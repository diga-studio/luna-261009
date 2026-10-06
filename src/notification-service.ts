import { DatabaseSync } from 'node:sqlite';
import type {
  AdvanceResult,
  Campaign,
  CampaignStatus,
  CreateCampaignInput,
  CustomerState,
  Notification,
  Segment,
} from './types.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const RECENT_PURCHASE_WINDOW_MS = 30 * DAY_MS;
const STALE_CART_THRESHOLD_MS = 48 * 60 * 60 * 1000;
const NOTIFICATION_TTL_MS = 30 * DAY_MS;

const SEGMENTS: readonly Segment[] = ['all', 'recent_buyers', 'stale_cart'];

interface CampaignRow {
  id: string;
  title: string;
  body: string;
  segment: string;
  scheduled_at: number;
  status: string;
  activated_at: number | null;
  expires_at: number | null;
}

interface NotificationRow {
  id: string;
  campaign_id: string;
  customer_id: string;
  title: string;
  body: string;
  created_at: number;
  expires_at: number;
}

function toCampaign(row: CampaignRow): Campaign {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    segment: row.segment as Segment,
    scheduledAt: row.scheduled_at,
    status: row.status as CampaignStatus,
    activatedAt: row.activated_at,
    expiresAt: row.expires_at,
  };
}

function toNotification(row: NotificationRow): Notification {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    customerId: row.customer_id,
    title: row.title,
    body: row.body,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

export class NotificationService {
  constructor(private readonly db: DatabaseSync) {}

  private checkClock(now: number): void {
    if (!Number.isFinite(now)) {
      throw new Error('logical time must be a finite number');
    }
    const row = this.db
      .prepare("SELECT value FROM meta WHERE key = 'last_time'")
      .get() as { value: number } | undefined;
    if (row !== undefined && now < row.value) {
      throw new Error(`logical time must be monotonically non-decreasing (last: ${row.value}, got: ${now})`);
    }
    this.db
      .prepare(
        "INSERT INTO meta (key, value) VALUES ('last_time', ?) " +
          'ON CONFLICT (key) DO UPDATE SET value = excluded.value',
      )
      .run(now);
  }

  upsertCustomer(state: CustomerState, now: number): void {
    this.checkClock(now);
    this.db
      .prepare(
        'INSERT INTO customers (customer_id, last_purchase_at, cart_non_empty, cart_updated_at) ' +
          'VALUES (?, ?, ?, ?) ' +
          'ON CONFLICT (customer_id) DO UPDATE SET ' +
          'last_purchase_at = excluded.last_purchase_at, ' +
          'cart_non_empty = excluded.cart_non_empty, ' +
          'cart_updated_at = excluded.cart_updated_at',
      )
      .run(
        state.customerId,
        state.lastPurchaseAt,
        state.cartNonEmpty ? 1 : 0,
        state.cartUpdatedAt,
      );
  }

  createCampaign(input: CreateCampaignInput, now: number): Campaign {
    this.checkClock(now);
    if (!SEGMENTS.includes(input.segment)) {
      throw new Error(`unknown segment: ${input.segment}`);
    }
    this.db
      .prepare(
        'INSERT INTO campaigns (id, title, body, segment, scheduled_at, status, activated_at, expires_at) ' +
          "VALUES (?, ?, ?, ?, ?, 'scheduled', NULL, NULL)",
      )
      .run(input.id, input.title, input.body, input.segment, input.scheduledAt);
    const campaign = this.getCampaign(input.id);
    if (campaign === null) {
      throw new Error('unreachable: campaign just inserted');
    }
    return campaign;
  }

  advance(campaignId: string, now: number, batchSize: number): AdvanceResult {
    this.checkClock(now);
    if (!Number.isInteger(batchSize) || batchSize < 1) {
      throw new Error('batchSize must be a positive integer');
    }
    this.db.exec('BEGIN');
    try {
      const result = this.advanceInTransaction(campaignId, now, batchSize);
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  private advanceInTransaction(campaignId: string, now: number, batchSize: number): AdvanceResult {
    const row = this.db
      .prepare('SELECT * FROM campaigns WHERE id = ?')
      .get(campaignId) as CampaignRow | undefined;
    if (row === undefined) {
      throw new Error(`campaign not found: ${campaignId}`);
    }
    let campaign = toCampaign(row);

    const expiredNotifications = Number(
      this.db
        .prepare('DELETE FROM notifications WHERE campaign_id = ? AND expires_at <= ?')
        .run(campaignId, now).changes,
    );

    let delivered = 0;
    let expiredRecipients = 0;

    if (campaign.status === 'scheduled' && now >= campaign.scheduledAt) {
      const activatedAt = now;
      const expiresAt = activatedAt + NOTIFICATION_TTL_MS;
      const recipients = this.selectRecipients(campaign.segment, activatedAt);
      const insertRecipient = this.db.prepare(
        'INSERT INTO recipients (campaign_id, customer_id, status) VALUES (?, ?, ?)',
      );
      for (const customerId of recipients) {
        insertRecipient.run(campaignId, customerId, 'pending');
      }
      this.db
        .prepare("UPDATE campaigns SET status = 'sending', activated_at = ?, expires_at = ? WHERE id = ?")
        .run(activatedAt, expiresAt, campaignId);
      campaign = {
        ...campaign,
        status: 'sending',
        activatedAt,
        expiresAt,
      };
    }

    if (campaign.status === 'sending') {
      const expiresAt = campaign.expiresAt as number;
      if (now >= expiresAt) {
        expiredRecipients = Number(
          this.db
            .prepare(
              "UPDATE recipients SET status = 'expired_skip' " +
                "WHERE campaign_id = ? AND status = 'pending'",
            )
            .run(campaignId).changes,
        );
      } else {
        const pending = this.db
          .prepare(
            "SELECT customer_id FROM recipients WHERE campaign_id = ? AND status = 'pending' " +
              'ORDER BY customer_id LIMIT ?',
          )
          .all(campaignId, batchSize) as unknown as { customer_id: string }[];
        const insertNotification = this.db.prepare(
          'INSERT INTO notifications (id, campaign_id, customer_id, title, body, created_at, expires_at) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?)',
        );
        const markDelivered = this.db.prepare(
          "UPDATE recipients SET status = 'delivered' WHERE campaign_id = ? AND customer_id = ?",
        );
        for (const { customer_id: customerId } of pending) {
          insertNotification.run(
            `${campaignId}:${customerId}`,
            campaignId,
            customerId,
            campaign.title,
            campaign.body,
            now,
            expiresAt,
          );
          markDelivered.run(campaignId, customerId);
          delivered += 1;
        }
      }

      const remaining = this.db
        .prepare(
          "SELECT COUNT(*) AS n FROM recipients WHERE campaign_id = ? AND status = 'pending'",
        )
        .get(campaignId) as { n: number };
      if (Number(remaining.n) === 0) {
        this.db.prepare("UPDATE campaigns SET status = 'sent' WHERE id = ?").run(campaignId);
        campaign = { ...campaign, status: 'sent' };
      }
    }

    return {
      campaignId,
      status: campaign.status,
      delivered,
      expiredNotifications,
      expiredRecipients,
    };
  }

  private selectRecipients(segment: Segment, t: number): string[] {
    let rows: { customer_id: string }[];
    if (segment === 'all') {
      rows = this.db
        .prepare('SELECT customer_id FROM customers')
        .all() as unknown as { customer_id: string }[];
    } else if (segment === 'recent_buyers') {
      rows = this.db
        .prepare(
          'SELECT customer_id FROM customers WHERE last_purchase_at IS NOT NULL ' +
            'AND last_purchase_at >= ? AND last_purchase_at <= ?',
        )
        .all(t - RECENT_PURCHASE_WINDOW_MS, t) as unknown as { customer_id: string }[];
    } else {
      rows = this.db
        .prepare(
          'SELECT customer_id FROM customers WHERE cart_non_empty = 1 ' +
            'AND cart_updated_at IS NOT NULL AND ? - cart_updated_at > ?',
        )
        .all(t, STALE_CART_THRESHOLD_MS) as unknown as { customer_id: string }[];
    }
    return rows.map((r) => r.customer_id);
  }

  getCampaign(campaignId: string): Campaign | null {
    const row = this.db
      .prepare('SELECT * FROM campaigns WHERE id = ?')
      .get(campaignId) as CampaignRow | undefined;
    return row === undefined ? null : toCampaign(row);
  }

  getNotifications(customerId: string, now: number): Notification[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM notifications WHERE customer_id = ? AND expires_at > ? ORDER BY created_at, id',
      )
      .all(customerId, now) as unknown as NotificationRow[];
    return rows.map(toNotification);
  }
}
