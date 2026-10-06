import type { BranchSpec, MatchResult, Matcher } from "./types.js";
import { parsePattern } from "./parser.js";
import { bestInterval, compileAst, type CompiledPattern } from "./nfa.js";

interface CompiledBranch {
  id: string;
  /** 非空关键词，按码点拆分。 */
  keywords: string[][];
  patterns: CompiledPattern[];
}

interface CompiledMatcher extends Matcher {
  branches: CompiledBranch[];
}

/** 编译分支声明为可复用匹配器。表达式非法时抛出 Error。 */
export function compile(branches: readonly BranchSpec[]): Matcher {
  const compiled: CompiledBranch[] = branches.map((branch, index) => {
    const where = `branch ${JSON.stringify(branch.id)} (index ${index})`;
    const keywords = (branch.keywords ?? [])
      .filter((keyword) => keyword.length > 0)
      .map((keyword) => Array.from(keyword));
    const patterns = (branch.patterns ?? []).map((source) => {
      try {
        return compileAst(parsePattern(source));
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to compile pattern in ${where}: ${detail}`);
      }
    });
    return { id: branch.id, keywords, patterns };
  });
  return { __brand: "SmartDeskMatcher", branches: compiled } as CompiledMatcher;
}

/** 关键词字面子串匹配：返回最早出现位置（码点下标），未出现返回 null。 */
function earliestKeywordStart(text: readonly string[], keyword: readonly string[]): number | null {
  const n = text.length;
  const k = keyword.length;
  outer: for (let start = 0; start + k <= n; start += 1) {
    for (let i = 0; i < k; i += 1) {
      if (text[start + i] !== keyword[i]) continue outer;
    }
    return start;
  }
  return null;
}

/** 单个分支的最佳候选：起点最小，起点相同则终点最大。 */
function branchBest(branch: CompiledBranch, text: readonly string[]): { start: number; end: number } | null {
  let best: { start: number; end: number } | null = null;
  const consider = (candidate: { start: number; end: number } | null): void => {
    if (candidate === null || candidate.end <= candidate.start) return;
    if (
      best === null ||
      candidate.start < best.start ||
      (candidate.start === best.start && candidate.end > best.end)
    ) {
      best = candidate;
    }
  };
  for (const keyword of branch.keywords) {
    const start = earliestKeywordStart(text, keyword);
    consider(start === null ? null : { start, end: start + keyword.length });
  }
  for (const pattern of branch.patterns) {
    consider(bestInterval(pattern, text));
  }
  return best;
}

/** 用匹配器路由消息；未命中返回 null。匹配器无内部状态，可并发复用。 */
export function match(matcher: Matcher, text: string): MatchResult | null {
  const { branches } = matcher as CompiledMatcher;
  const cps = Array.from(text);
  let best: { branchId: string; start: number; end: number } | null = null;
  // 按声明顺序扫描；严格更优才替换，平局保留先声明者。
  for (const branch of branches) {
    const candidate = branchBest(branch, cps);
    if (candidate === null) continue;
    if (
      best === null ||
      candidate.start < best.start ||
      (candidate.start === best.start && candidate.end > best.end)
    ) {
      best = { branchId: branch.id, start: candidate.start, end: candidate.end };
    }
  }
  return best;
}
