/** 身份：用户及其所属角色、组（各最多 8 个） */
export interface Identity {
  userId: string;
  roles: string[];
  groups: string[];
}

/** 环境及其包含的资源类型 */
export interface Environment {
  environmentId: string;
  resourceTypes: string[];
}

/** 策略主体：精确匹配一个用户、角色或组 */
export type Principal =
  | { kind: 'user'; id: string }
  | { kind: 'role'; id: string }
  | { kind: 'group'; id: string };

/** 每日生效窗口，UTC，"hh:mm AM/PM"；起点含、终点不含；相等表示全天 */
export interface DailyWindow {
  start: string;
  end: string;
}

export interface Policy {
  policyId: string;
  principal: Principal;
  environmentId: string;
  resourceType: string;
  effect: 'allow' | 'deny';
  /** 1..1000，数值越小越优先 */
  priority: number;
  window: DailyWindow;
  /** 仅 allow：最长会话时长（毫秒），不超过 8 小时 */
  maxSessionMs?: number;
  /** 仅 allow：是否要求审批 */
  requiresApproval?: boolean;
}

/** 已发放授权 */
export interface Grant {
  grantId: string;
  userId: string;
  environmentId: string;
  resourceType: string;
  /** 整数毫秒，开始 <= 审计时刻 */
  startMs: number;
  /** 整数毫秒，到期 > 审计时刻，总时长 <= 8 小时 */
  endMs: number;
  approved: boolean;
}

/** 不可变快照 */
export interface Snapshot {
  identities: Identity[];
  environments: Environment[];
  policies: Policy[];
  grants: Grant[];
  /** 审计时刻，整数毫秒 */
  auditMs: number;
}

/** 漂移区间，左闭右开，整数毫秒 */
export interface DriftInterval {
  userId: string;
  environmentId: string;
  resourceType: string;
  startMs: number;
  endMs: number;
}
