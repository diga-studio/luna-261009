import { randomUUID } from "node:crypto";
import type { StatementSync } from "node:sqlite";
import { Store } from "./store.js";
import {
  LEASE_DURATION_MS,
  MAX_ATTEMPTS,
  MAX_CLAIM_LIMIT,
  MAX_GROUPS,
  MAX_PRIORITY,
  MIN_CLAIM_LIMIT,
  MIN_GROUPS,
  MIN_PRIORITY,
} from "./types.js";
import type {
  ClaimedMessage,
  Clock,
  GroupDeliveryStatus,
  PipeLiteOptions,
  Receipt,
} from "./types.js";

export type {
  ClaimedMessage,
  Clock,
  DeliveryState,
  GroupDeliveryStatus,
  PipeLiteOptions,
  Receipt,
} from "./types.js";
export {
  LEASE_DURATION_MS,
  MAX_ATTEMPTS,
  MAX_CLAIM_LIMIT,
  MAX_GROUPS,
  MAX_PRIORITY,
  MIN_CLAIM_LIMIT,
  MIN_GROUPS,
  MIN_PRIORITY,
} from "./types.js";

interface CandidateRow {
  message_id: number;
  priority: number;
}

interface DeliveryRow {
  attempts: number;
  acked: number;
  receipt: string | null;
  lease_expires_at: number | null;
}

function isReceipt(value: unknown): value is Receipt {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.messageId === "number" &&
    typeof r.group === "string" &&
    typeof r.token === "string" &&
    typeof r.expiresAt === "number"
  );
}

/**
 * PipeLite 分组投递内核。
 *
 * 每条消息独立投递给每个消费组；各组的尝试次数、租约、确认与死信
 * 状态互不影响。所有状态变化都在 SQLite IMMEDIATE 事务中完成，
 * 并发效果等价于某个串行顺序。
 */
export class PipeLite {
  private readonly store: Store;
  private readonly groups: readonly string[];
  private readonly clock: Clock;
  private closed = false;
  private readonly stmtEnqueueMessage: StatementSync;
  private readonly stmtEnqueueDelivery: StatementSync;
  private readonly stmtClaimSelect: StatementSync;
  private readonly stmtClaimUpdate: StatementSync;
  private readonly stmtPayload: StatementSync;
  private readonly stmtAck: StatementSync;
  private readonly stmtStatus: StatementSync;

  constructor(options: PipeLiteOptions) {
    const { path, groups, clock } = options;
    if (
      !Array.isArray(groups) ||
      groups.length < MIN_GROUPS ||
      groups.length > MAX_GROUPS
    ) {
      throw new RangeError(`groups must contain ${MIN_GROUPS}..${MAX_GROUPS} names`);
    }
    if (groups.some((g) => typeof g !== "string" || g.length === 0)) {
      throw new TypeError("group names must be non-empty strings");
    }
    if (new Set(groups).size !== groups.length) {
      throw new Error("group names must be unique");
    }
    this.groups = [...groups];
    this.clock = clock ?? Date.now;
    this.store = new Store(path, this.groups);
    const db = this.store.db;
    this.stmtEnqueueMessage = db.prepare(
      "INSERT INTO messages (payload, priority, enqueued_at) VALUES (?, ?, ?)",
    );
    this.stmtEnqueueDelivery = db.prepare(
      "INSERT INTO deliveries (message_id, group_id, priority) VALUES (?, ?, ?)",
    );
    // 覆盖索引扫描：只访问该组未确认的行，按 优先级降序 + 入队顺序 输出
    this.stmtClaimSelect = db.prepare(
      `SELECT message_id, priority
       FROM deliveries INDEXED BY idx_claim
       WHERE group_id = ? AND acked = 0
         AND attempts < ?
         AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
       ORDER BY priority DESC, message_id ASC
       LIMIT ?`,
    );
    this.stmtClaimUpdate = db.prepare(
      `UPDATE deliveries
       SET attempts = attempts + 1, receipt = ?, lease_expires_at = ?
       WHERE message_id = ? AND group_id = ?`,
    );
    this.stmtPayload = db.prepare("SELECT payload FROM messages WHERE id = ?");
    this.stmtAck = db.prepare(
      `UPDATE deliveries
       SET acked = 1, receipt = NULL, lease_expires_at = NULL
       WHERE message_id = ? AND group_id = ? AND receipt = ?
         AND acked = 0 AND lease_expires_at > ?`,
    );
    this.stmtStatus = db.prepare(
      "SELECT attempts, acked, receipt, lease_expires_at FROM deliveries WHERE message_id = ? AND group_id = ?",
    );
  }

  /** 入队一条消息，返回消息 id（即全局入队顺序号，并发下确定）。 */
  enqueue(payload: unknown, priority: number): number {
    this.assertOpen();
    if (!Number.isInteger(priority) || priority < MIN_PRIORITY || priority > MAX_PRIORITY) {
      throw new RangeError(`priority must be an integer in ${MIN_PRIORITY}..${MAX_PRIORITY}`);
    }
    const serialized = JSON.stringify(payload);
    if (serialized === undefined) {
      throw new TypeError("payload must be JSON-serializable");
    }
    const now = this.clock();
    // 消息与各组的投递行在同一事务中生效，并发入队形成确定先后关系
    return this.store.transaction(() => {
      const result = this.stmtEnqueueMessage.run(serialized, priority, now);
      const messageId = Number(result.lastInsertRowid);
      for (const group of this.groups) {
        this.stmtEnqueueDelivery.run(messageId, group, priority);
      }
      return messageId;
    });
  }

  /**
   * 按组批量领取当前可领取的消息（1 至 50 条）。
   * 优先级高的在前，同优先级按入队先后排序；重新投递保留原顺序。
   * 整个批次在单个事务中生效，同组同消息最多一个有效回执。
   */
  claim(group: string, limit: number = 1): ClaimedMessage[] {
    this.assertOpen();
    this.assertGroup(group);
    if (!Number.isInteger(limit) || limit < MIN_CLAIM_LIMIT || limit > MAX_CLAIM_LIMIT) {
      throw new RangeError(`limit must be an integer in ${MIN_CLAIM_LIMIT}..${MAX_CLAIM_LIMIT}`);
    }
    const now = this.clock();
    const expiresAt = now + LEASE_DURATION_MS;
    return this.store.transaction(() => {
      const rows = this.stmtClaimSelect.all(
        group,
        MAX_ATTEMPTS,
        now,
        limit,
      ) as unknown as CandidateRow[];
      const claimed: ClaimedMessage[] = [];
      for (const row of rows) {
        const token = randomUUID();
        this.stmtClaimUpdate.run(token, expiresAt, row.message_id, group);
        const payloadRow = this.stmtPayload.get(row.message_id) as unknown as {
          payload: string;
        };
        claimed.push({
          messageId: row.message_id,
          payload: JSON.parse(payloadRow.payload),
          priority: row.priority,
          receipt: { messageId: row.message_id, group, token, expiresAt },
        });
      }
      return claimed;
    });
  }

  /**
   * 确认回执。仅在回执与当前租约完全匹配且未到期（到期时刻本身已失效）
   * 时生效；迟到、过期、重复或伪造回执均返回 false 且不产生状态变化。
   */
  ack(receipt: unknown): boolean {
    this.assertOpen();
    if (!isReceipt(receipt)) {
      throw new TypeError("invalid receipt");
    }
    const now = this.clock();
    // 单条 UPDATE 自身即原子，无需显式事务
    const result = this.stmtAck.run(
      receipt.messageId,
      receipt.group,
      receipt.token,
      now,
    );
    return Number(result.changes) > 0;
  }

  /** 查看指定消息在各消费组的投递状态（反映当前时间的到期效果）。 */
  status(messageId: number): GroupDeliveryStatus[] {
    this.assertOpen();
    if (!Number.isInteger(messageId)) {
      throw new TypeError("messageId must be an integer");
    }
    const now = this.clock();
    return this.groups.map((group) => {
      const row = this.stmtStatus.get(messageId, group) as unknown as
        | DeliveryRow
        | undefined;
      if (row === undefined) {
        return { group, state: "pending", attempts: 0, leaseExpiresAt: null };
      }
      if (row.acked !== 0) {
        return { group, state: "acked", attempts: row.attempts, leaseExpiresAt: null };
      }
      const leaseExpiresAt = row.lease_expires_at;
      if (leaseExpiresAt !== null && leaseExpiresAt > now) {
        return { group, state: "leased", attempts: row.attempts, leaseExpiresAt };
      }
      if (row.attempts >= MAX_ATTEMPTS) {
        return { group, state: "dead", attempts: row.attempts, leaseExpiresAt: null };
      }
      return { group, state: "pending", attempts: row.attempts, leaseExpiresAt: null };
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.store.close();
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("PipeLite instance is closed");
    }
  }

  private assertGroup(group: string): void {
    if (!this.groups.includes(group)) {
      throw new Error(`unknown group: ${group}`);
    }
  }
}
