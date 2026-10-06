export type EventType = 'exposure' | 'conversion';

export interface ExperimentEvent {
  eventId: string;
  visitorId: string;
  variant: string;
  type: EventType;
}

export interface VariantStats {
  variant: string;
  n: number;
  c: number;
}

export interface LockRecord {
  winner: string;
  triggerEventId: string;
  stats: VariantStats[];
}

export interface ExperimentResult {
  experimentId: string;
  variants: VariantStats[];
  lock: LockRecord | null;
}
