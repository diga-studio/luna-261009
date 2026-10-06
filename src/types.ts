/** 一个分支的声明。数组顺序用于最终平局裁决。 */
export interface Branch {
  id: string;
  keywords: string[];
  patterns: string[];
}

/** compile 返回的可复用匹配器。 */
export interface Matcher {
  readonly branches: readonly CompiledBranch[];
}

/** 内部：编译后的分支。 */
export interface CompiledBranch {
  id: string;
  order: number;
  keywords: string[];
  programs: Program[];
}

/** 内部：表达式编译产物（NFA 程序，占位）。 */
export interface Program {
  readonly source: string;
}

/** match 的命中结果。区间左闭右开，按 Unicode 码点计数。 */
export interface MatchResult {
  branchId: string;
  start: number;
  end: number;
}
