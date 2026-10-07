/** A single telemetry sample for one pump. */
export interface TelemetryPoint {
  /** Sampling time, milliseconds since epoch. */
  timestampMs: number;
  /** Pump speed (e.g. rpm). 0 means stopped. */
  speed: number;
  /** Measured (actual) head. */
  head: number;
}

/** Remaining life is reported in operating hours, never wall-clock hours. */
export type LifeAssessment =
  | { status: 'insufficient-data' }
  | {
      status: 'depleted';
      slope: number;
      fittedNormalizedHead: number;
      remainingOperatingHours: 0;
    }
  | {
      status: 'no-finite-estimate';
      slope: number;
      fittedNormalizedHead: number;
    }
  | {
      status: 'finite';
      slope: number;
      fittedNormalizedHead: number;
      remainingOperatingHours: number;
    };
