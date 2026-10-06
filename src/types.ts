/** 支付倍率：基础 1 倍、1.5 倍、2 倍。 */
export type PayRate = 1 | 1.5 | 2;

/** 节日倍率标记，只允许 1.5 或 2。 */
export type HolidayRate = 1.5 | 2;

/** ISO 8601 格式的 UTC 时刻字符串（精确到秒），如 "2025-03-09T05:00:00Z"。 */
export type UtcInstant = string;

/** 当地日期，格式 YYYY-MM-DD。 */
export type LocalDate = string;

/** 已配对并审批完成的实际工作区间，起点包含、终点不包含。 */
export interface WorkInterval {
  employeeId: string;
  /** 来源区间 ID，用于明细追溯。 */
  sourceId: string;
  locationId: string;
  /** UTC 起点（包含）。 */
  startUtc: UtcInstant;
  /** UTC 终点（不包含）。 */
  endUtc: UtcInstant;
}

/** 每名员工的结算请求上下文。 */
export interface EmployeeContext {
  employeeId: string;
  /** 员工会计 IANA 时区，如 "America/New_York"。 */
  accountingTimeZone: string;
  /** 结算周的当地周一日期（员工会计时区），YYYY-MM-DD。 */
  weekStartLocalDate: LocalDate;
  /** 周起点之前已连续工作的秒数。 */
  initialContinuousSeconds: number;
}

export interface SettlementInput {
  employees: EmployeeContext[];
  /** 地点 ID -> IANA 时区。 */
  locationTimeZones: Record<string, string>;
  /** 地点 ID -> (当地日期 -> 节日倍率)，未标记日期为 1 倍。 */
  holidayRates: Record<string, Record<LocalDate, HolidayRate>>;
  /** 全部工作区间，顺序任意。 */
  intervals: WorkInterval[];
}

/** 分段结算明细，完整覆盖输入工作时间。 */
export interface SettlementSegment {
  sourceId: string;
  startUtc: UtcInstant;
  endUtc: UtcInstant;
  /** 该段最终支付倍率。 */
  rate: PayRate;
}

/** 各倍率的实际秒数总量。 */
export interface RateTotals {
  regular: number;
  timeAndHalf: number;
  double: number;
}

export interface EmployeeSettlement {
  employeeId: string;
  segments: SettlementSegment[];
  totals: RateTotals;
}

export interface SettlementResult {
  employees: EmployeeSettlement[];
}
