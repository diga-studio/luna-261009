/** 结算请求：一次完整批次结算的全部输入。 */
export interface SettlementRequest {
  /** 结算周在当地（员工会计时区）的周一日期，格式 YYYY-MM-DD。 */
  weekStartLocalDate: string;
  /** 员工会计 IANA 时区，如 "America/New_York"。 */
  employeeTimeZone: string;
  /** 周起点之前已连续工作的秒数（仅衔接从周起点立即开始的工作）。 */
  initialContinuousSeconds: number;
  /** 地点 ID -> IANA 时区。 */
  locationTimeZones: Record<string, string>;
  /** 地点 ID -> (当地日期 YYYY-MM-DD -> 节日倍率 1.5 | 2)。未标记日期为 1 倍。 */
  holidayRates: Record<string, Record<string, 1.5 | 2>>;
  /** 已配对审批的实际工作区间。 */
  intervals: WorkInterval[];
}

/** 一段实际工作区间，起点包含、终点不包含。 */
export interface WorkInterval {
  employeeId: string;
  /** 来源 ID，用于明细追溯。 */
  sourceId: string;
  locationId: string;
  /** UTC 起点，epoch 秒（含）。 */
  startUtc: number;
  /** UTC 终点，epoch 秒（不含）。 */
  endUtc: number;
}

/** 分段结算明细：同一来源区间内倍率一致的一段。 */
export interface SettlementSegment {
  employeeId: string;
  sourceId: string;
  locationId: string;
  startUtc: number;
  endUtc: number;
  /** 最终倍率：1 | 1.5 | 2。 */
  rate: number;
}

/** 单名员工的结算结果。 */
export interface EmployeeSettlement {
  employeeId: string;
  segments: SettlementSegment[];
  /** 各倍率下的实际秒数总量。 */
  totalSecondsByRate: { rate1: number; rate1_5: number; rate2: number };
}

/** 批次结算结果，按员工分组。 */
export interface SettlementResult {
  employees: EmployeeSettlement[];
}
