export type Site = 'A' | 'B';

export type VmPowerState = 'running' | 'stopped';

export type VmOp = 'start' | 'stop';

export type RequestPhase =
  | 'stopping_source'
  | 'starting_target'
  | 'stopping_target'
  | 'starting_source';

export type RequestStatus = 'in_progress' | 'success' | 'failed';

export type InstructionStatus = 'pending' | 'sent' | 'success' | 'rejected';

export type ExecResult = 'success' | 'rejected';

export interface Instruction {
  instructionId: string;
  vmId: string;
  site: Site;
  op: VmOp;
}

export interface SwitchResult {
  requestId: string;
  status: 'success' | 'failed';
  activeSite: Site;
  reason?: string;
}

export interface RequestInfo {
  requestId: string;
  status: RequestStatus;
  phase: RequestPhase | null;
  fromSite: Site;
  toSite: Site;
}

export interface VmInspection {
  vmId: string;
  A: VmPowerState;
  B: VmPowerState;
}

export interface InspectResult {
  groupId: string;
  activeSite: Site;
  request: RequestInfo | null;
  vms: VmInspection[];
}

export interface HistoryEntry {
  seq: number;
  instructionId: string;
  vmId: string;
  site: Site;
  op: VmOp;
  event: 'received' | 'applied' | 'rejected' | 'replayed';
}
