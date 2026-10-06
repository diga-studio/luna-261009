import type { LifecycleRecord, MonthlyBill } from "./types.js";
import { PLANS } from "./types.js";
import { RecordStore } from "./db.js";
import { InstanceIndex } from "./instanceIndex.js";
import { costCentsFor } from "./money.js";

/**
 * 计费服务：补录生命周期记录、查询单实例月账单。
 * 顺序调用；进程正常重启后数据不丢失。
 */
export class BillingService {
  private readonly store: RecordStore;
  private readonly indexes = new Map<string, InstanceIndex>();
  /** 月账单缓存：instanceId -> (monthStart -> bill)。补录时整体失效。 */
  private readonly billCache = new Map<string, Map<number, MonthlyBill>>();

  /** dbPath 为 SQLite 文件路径，":memory:" 表示纯内存。 */
  constructor(dbPath: string) {
    this.store = new RecordStore(dbPath);
  }

  /** 补录一条记录；重放（相同 eventId）自动忽略。 */
  ingest(record: LifecycleRecord): void {
    if (!this.store.insert(record)) return;
    this.indexes.get(record.instanceId)?.add(record);
    this.billCache.delete(record.instanceId);
  }

  /** 批量补录，等价于逐条 ingest，性能更好。 */
  ingestBatch(records: LifecycleRecord[]): void {
    const inserted = this.store.insertBatch(records);
    for (const record of inserted) {
      this.indexes.get(record.instanceId)?.add(record);
      this.billCache.delete(record.instanceId);
    }
  }

  /** 懒加载实例索引；未缓存时从持久层重建。 */
  private indexFor(instanceId: string): InstanceIndex {
    let index = this.indexes.get(instanceId);
    if (!index) {
      index = new InstanceIndex(this.store.listByInstance(instanceId));
      this.indexes.set(instanceId, index);
    }
    return index;
  }

  /**
   * 查询某实例指定 UTC 自然月的账单。
   * @param year  UTC 年份（如 2026）
   * @param month UTC 月份，1-12
   */
  getMonthlyBill(instanceId: string, year: number, month: number): MonthlyBill {
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      throw new RangeError(`month 必须在 1-12 之间，收到 ${month}`);
    }
    const monthStart = Date.UTC(year, month - 1, 1);
    const monthEnd = Date.UTC(year, month, 1);
    let cache = this.billCache.get(instanceId);
    const cached = cache?.get(monthStart);
    if (cached) return cached;
    const usage = this.indexFor(instanceId).usageInRange(monthStart, monthEnd);
    const lineItems = PLANS.map((plan) => ({
      plan,
      runningMs: usage[plan],
      costCents: costCentsFor(plan, usage[plan]),
    }));
    const totalCents = lineItems.reduce((sum, item) => sum + item.costCents, 0);
    const bill: MonthlyBill = { instanceId, monthStart, monthEnd, lineItems, totalCents };
    if (!cache) {
      cache = new Map();
      this.billCache.set(instanceId, cache);
    }
    cache.set(monthStart, bill);
    return bill;
  }

  /** 关闭底层存储。 */
  close(): void {
    this.store.close();
  }
}
