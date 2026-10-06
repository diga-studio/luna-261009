/** 每日生效窗口，UTC，"hh:mm AM/PM"。起点包含、终点不含；相等表示全天。 */
export interface DailyWindow {
  start: string;
  end: string;
}

export type PolicyEffect = 'allow' | 'deny';

export type PrincipalKind = 'user' | 'role' | 'group';

export interface Policy {
  id: string;
  principalKind: PrincipalKind;
  principalId: string;
  environmentId: string;
  resourceType: string;
  effect: PolicyEffect;
  /** 1..1000，数值越小越优先 */
  priority: number;
  window: DailyWindow;
  /** 仅允许策略：最长会话时长（毫秒），<= 8h */
  maxSessionMs?: number;
  /** 仅允许策略：是否要求审批 */
  requiresApproval?: boolean;
}

export interface Identity {
  id: string;
  roleIds: string[];
  groupIds: string[];
}

export interface Environment {
  id: string;
  resourceTypes: string[];
}

export interface Grant {
  id: string;
  userId: string;
  environmentId: string;
  resourceType: string;
  /** 整数毫秒，开始 <= 审计时刻 */
  startMs: number;
  /** 整数毫秒，到期 > 审计时刻，startMs..endMs <= 8h */
  endMs: number;
  approved: boolean;
}

export interface Snapshot {
  identities: Identity[];
  environments: Environment[];
  policies: Policy[];
  grants: Grant[];
  /** 审计时刻，整数毫秒 */
  auditTimeMs: number;
}

/** 左闭右开区间，整数毫秒 */
export interface Interval {
  startMs: number;
  endMs: number;
}

export interface DriftInterval extends Interval {
  userId: string;
  environmentId: string;
  resourceType: string;
}
