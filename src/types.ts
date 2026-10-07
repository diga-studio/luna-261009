/** 一条遥测：毫秒时间戳、转速、实际扬程。 */
export interface TelemetryPoint {
  readonly timestampMs: number;
  readonly rpm: number;
  readonly head: number;
}

/** 寿命查询结果判别联合。 */
export type RulStatus =
  | 'insufficient-data'
  | 'no-finite-estimate'
  | 'exhausted'
  | 'ok';

export interface RulResultBase {
  readonly status: RulStatus;
}

export interface InsufficientDataResult extends RulResultBase {
  readonly status: 'insufficient-data';
}

export interface NoFiniteEstimateResult extends RulResultBase {
  readonly status: 'no-finite-estimate';
  readonly slope: number;
  readonly fittedValue: number;
}

export interface ExhaustedResult extends RulResultBase {
  readonly status: 'exhausted';
  readonly slope: number;
  readonly fittedValue: number;
  readonly remainingLifeHours: 0;
}

export interface OkResult extends RulResultBase {
  readonly status: 'ok';
  readonly slope: number;
  readonly fittedValue: number;
  readonly remainingLifeHours: number;
}

export type RulResult =
  | InsufficientDataResult
  | NoFiniteEstimateResult
  | ExhaustedResult
  | OkResult;
