import { parsePattern } from "./parser.js";
import { compileAst, runProgram } from "./nfa.js";
import type { Branch, CompiledBranch, Matcher, MatchResult } from "./types.js";

/** 编译分支列表为可复用匹配器。 */
export function compile(branches: Branch[]): Matcher {
  const compiled: CompiledBranch[] = branches.map((branch, order) => ({
    id: branch.id,
    order,
    keywords: branch.keywords.filter((kw) => kw.length > 0),
    programs: branch.patterns.map((source) => compileAst(source, parsePattern(source))),
  }));
  return { branches: compiled };
}

interface Candidate {
  start: number;
  end: number;
}

/** 在码点数组中查找关键字的首次出现（字面子串，码点级）。 */
function findKeyword(haystack: number[], needle: number[]): number {
  if (needle.length === 0 || needle.length > haystack.length) return -1;
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/** 候选比较：起点小者优先；起点相同终点大者优先。 */
function better(a: Candidate, b: Candidate): Candidate {
  if (b.start < a.start) return b;
  if (b.start === a.start && b.end > a.end) return b;
  return a;
}

/** 将客户消息路由到一个分支；未命中返回 null。 */
export function match(matcher: Matcher, text: string): MatchResult | null {
  const cps = Array.from(text, (ch) => ch.codePointAt(0)!);
  let best: (Candidate & { branchId: string }) | null = null;
  for (const branch of matcher.branches) {
    let branchBest: Candidate | null = null;
    for (const kw of branch.keywords) {
      const needle = Array.from(kw, (ch) => ch.codePointAt(0)!);
      const start = findKeyword(cps, needle);
      if (start >= 0) {
        const cand = { start, end: start + needle.length };
        branchBest = branchBest === null ? cand : better(branchBest, cand);
      }
    }
    for (const program of branch.programs) {
      for (const cand of runProgram(program, cps)) {
        branchBest = branchBest === null ? cand : better(branchBest, cand);
      }
    }
    // 跨分支：起点/终点规则相同；完全并列时先声明者优先（严格小于才替换）。
    if (
      branchBest !== null &&
      (best === null || better(best, branchBest) === branchBest)
    ) {
      best = { ...branchBest, branchId: branch.id };
    }
  }
  return best;
}
