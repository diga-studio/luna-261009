/** 分支声明：id 唯一标识，keywords 为字面关键词，patterns 为表达式。 */
export interface BranchSpec {
  id: string;
  keywords?: readonly string[];
  patterns?: readonly string[];
}

/** 命中结果：分支 id 与匹配区间（按 Unicode 码点计数，左闭右开）。 */
export interface MatchResult {
  branchId: string;
  start: number;
  end: number;
}

/** compile 返回的可复用匹配器（不透明句柄）。 */
export interface Matcher {
  readonly __brand: "SmartDeskMatcher";
}
