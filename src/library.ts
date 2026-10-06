import type { DatabaseSync } from "node:sqlite";
import type {
  AdvanceResult,
  Campaign,
  CampaignStatus,
  CustomerFacts,
  Notification,
  Segment,
} from "./types.js";
import {
  NOTIFICATION_TTL_MS,
  RECENT_PURCHASE_WINDOW_MS,
  STALE_CART_THRESHOLD_MS,
} from "./types.js";

const SEGMENT_QUERIES: Record<Segment, { sql: string; params: (t: number) => unknown[] }> = {
  all: {
    sql: "SELECT customer_id FROM customers",
    params: () => [],
  },
  recent_purchase: {
    sql:
      "SELECT customer_id FROM customers " +
      "WHERE last_purchase_at IS NOT NULL AND last_purchase_at BETWEEN ? AND ?",
    params: (t) => [t - RECENT_PURCHASE_WINDOW_MS, t],
  },
  stale_cart: {
    sql:
      "SELECT customer_id FROM customers " +
      "WHERE cart_nonempty = 1 AND cart_updated_at IS NOT NULL AND cart_updated_at < ?",
    params: (t) => [t - STALE_CART_THRESHOLD_MS],
  },
};

interface CampaignRow {
  id: string;
  title: string;
  body: string;
  segment: string;
  scheduled_at: number;
  status: string;
  send_started_at: number | null;
  expires_at: number | null;
}

function toCampaign(row: CampaignRow): Campaign {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    segment: row.segment as Segment,
    scheduledAt: Number(row.scheduled_at),
    status: row.status as CampaignStatus,
    sendStartedAt: row.send_started_at === null ? null : Number(row.send_started_at),
    expiresAt: row.expires_at === null ? null : Number(row.expires_at),
  };
}

export class NotificationLibrary {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  private checkClock(now: number): void {
    const row = this.db
      .prepare("SELECT value FROM meta WHERE key = 'last_time'")
      .get() as { value: string } | undefined;
    if (row !== undefined && now < Number(row.value)) {
      throw new Error(`logical time moved backwards: ${now} < ${row.value}`);
    }
    this.db
      .prepare(
        "INSERT INTO meta (key, value) VALUES ('last_time', ?) " +
          "ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      )
      .run(String(now));
  }

  upsertCustomer(facts: CustomerFacts, now: number): void {
    this.checkClock(now);
    this.db
      .prepare(
        "INSERT INTO customers (customer_id, last_purchase_at, cart_nonempty, cart_updated_at, updated_at) " +
          "VALUES (?, ?, ?, ?, ?) " +
          "ON CONFLICT (customer_id) DO UPDATE SET " +
          "last_purchase_at = excluded.last_purchase_at, " +
          "cart_nonempty = excluded.cart_nonempty, " +
          "cart_updated_at = excluded.cart_updated_at, " +
          "updated_at = excluded.updated_at",
      )
      .run(
        facts.customerId,
        facts.lastPurchaseAt,
        facts.cartNonempty ? 1 : 0,
        facts.cartUpdatedAt,
        now,
      );
  }

  createCampaign(input: {
    id: string;
    title: string;
    body: string;
    segment: Segment;
    scheduledAt: number;
  }): Campaign {
    this.db
      .prepare(
        "INSERT INTO campaigns (id, title, body, segment, scheduled_at, status, send_started_at, expires_at) " +
          "VALUES (?, ?, ?, ?, ?, 'scheduled', NULL, NULL)",
      )
      .run(input.id, input.title, input.body, input.segment, input.scheduledAt);
    const created = this.getCampaign(input.id);
    if (created === null) {
      throw new Error("unreachable: campaign missing after insert");
    }
    return created;
  }

  getCampaign(id: string): Campaign | null {
    const row = this.db.prepare("SELECT * FROM campaigns WHERE id = ?").get(id) as
      | CampaignRow
      | undefined;
    return row === undefined ? null : toCampaign(row);
  }

  advanceCampaign(campaignId: string, now: number, batchSize: number): AdvanceResult {
    this.checkClock(now);
    if (batchSize < 1) {
      throw new Error("batchSize must be >= 1");
    }
    const campaign = this.getCampaign(campaignId);
    if (campaign === null) {
      throw new Error(`campaign not found: ${campaignId}`);
    }

    const result: AdvanceResult = {
      campaignId,
      status: campaign.status,
      deliveredThisRound: 0,
      expiredThisRound: 0,
      purgedThisRound: 0,
    };

    this.db.exec("BEGIN");
    try {
      if (campaign.status === "scheduled") {
        if (now < campaign.scheduledAt) {
          this.db.exec("COMMIT");
          return result;
        }
        const expiresAt = now + NOTIFICATION_TTL_MS;
        this.db
          .prepare(
            "UPDATE campaigns SET status = 'sending', send_started_at = ?, expires_at = ? WHERE id = ?",
          )
          .run(now, expiresAt, campaignId);
        const segment = SEGMENT_QUERIES[campaign.segment];
        const rows = this.db.prepare(segment.sql).all(...segment.params(now));
        const insertRecipient = this.db.prepare(
          "INSERT OR IGNORE INTO recipients (campaign_id, customer_id, delivered) VALUES (?, ?, 0)",
        );
        for (const row of rows) {
          insertRecipient.run(campaignId, row.customer_id as string);
        }
        campaign.status = "sending";
        campaign.expiresAt = expiresAt;
      }

      if (campaign.status === "sending") {
        result.purgedThisRound = Number(
          this.db
            .prepare("DELETE FROM notifications WHERE campaign_id = ? AND expires_at <= ?")
            .run(campaignId, now).changes,
        );

        const expiresAt = campaign.expiresAt as number;
        if (now >= expiresAt) {
          result.expiredThisRound = Number(
            this.db
              .prepare(
                "UPDATE recipients SET delivered = 1 WHERE campaign_id = ? AND delivered = 0",
              )
              .run(campaignId).changes,
          );
        } else {
          const pending = this.db
            .prepare(
              "SELECT customer_id FROM recipients WHERE campaign_id = ? AND delivered = 0 " +
                "ORDER BY customer_id LIMIT ?",
            )
            .all(campaignId, batchSize);
          const insertNotification = this.db.prepare(
            "INSERT OR IGNORE INTO notifications (campaign_id, customer_id, title, body, created_at, expires_at) " +
              "VALUES (?, ?, ?, ?, ?, ?)",
          );
          const markDelivered = this.db.prepare(
            "UPDATE recipients SET delivered = 1 WHERE campaign_id = ? AND customer_id = ?",
          );
          for (const row of pending) {
            const customerId = row.customer_id as string;
            insertNotification.run(
              campaignId,
              customerId,
              campaign.title,
              campaign.body,
              now,
              expiresAt,
            );
            markDelivered.run(campaignId, customerId);
            result.deliveredThisRound += 1;
          }
        }

        const remaining = this.db
          .prepare(
            "SELECT COUNT(*) AS n FROM recipients WHERE campaign_id = ? AND delivered = 0",
          )
          .get(campaignId) as { n: number };
        if (Number(remaining.n) === 0) {
          this.db
            .prepare("UPDATE campaigns SET status = 'sent' WHERE id = ?")
            .run(campaignId);
          campaign.status = "sent";
        }
      }

      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }

    result.status = campaign.status;
    return result;
  }

  listNotifications(customerId: string, now: number): Notification[] {
    this.checkClock(now);
    const rows = this.db
      .prepare(
        "SELECT * FROM notifications WHERE customer_id = ? AND expires_at > ? ORDER BY id",
      )
      .all(customerId, now);
    return rows.map((row) => ({
      id: Number(row.id),
      campaignId: row.campaign_id as string,
      customerId: row.customer_id as string,
      title: row.title as string,
      body: row.body as string,
      createdAt: Number(row.created_at),
      expiresAt: Number(row.expires_at),
    }));
  }
}
