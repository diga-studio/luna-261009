import type { AstNode } from "./parser.js";

type CharTest =
  | { kind: "eq"; cp: number }
  | { kind: "any" }
  | { kind: "class"; negate: boolean; ranges: readonly [number, number][] };

interface State {
  /** 消费一个码点的转移；null 表示该状态不消费字符。 */
  charTest: CharTest | null;
  charTarget: number;
  /** 无条件 epsilon 转移。 */
  eps: number[];
  /** 锚点断言转移：仅在对应位置可走。 */
  assertStart: number[];
  assertEnd: number[];
  accept: boolean;
}

/** 编译后的表达式（NFA）。 */
export interface CompiledPattern {
  readonly states: readonly State[];
  readonly start: number;
}

function testChar(test: CharTest, cp: number): boolean {
  switch (test.kind) {
    case "eq":
      return cp === test.cp;
    case "any":
      return true;
    case "class": {
      // 范围已按码点排序，二分查找。
      let lo = 0;
      let hi = test.ranges.length;
      let found = false;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        const range = test.ranges[mid]!;
        if (cp < range[0]) hi = mid;
        else if (cp > range[1]) lo = mid + 1;
        else {
          found = true;
          break;
        }
      }
      return test.negate ? !found : found;
    }
  }
}

/** 以 continuation-passing 方式把 AST 编译进 states，返回入口状态下标。 */
function build(ast: AstNode, states: State[], next: number): number {
  const add = (partial: Partial<State>): number => {
    states.push({
      charTest: null,
      charTarget: -1,
      eps: [],
      assertStart: [],
      assertEnd: [],
      accept: false,
      ...partial,
    });
    return states.length - 1;
  };

  switch (ast.kind) {
    case "empty":
      return add({ eps: [next] });
    case "char":
      return add({ charTest: { kind: "eq", cp: ast.cp }, charTarget: next });
    case "any":
      return add({ charTest: { kind: "any" }, charTarget: next });
    case "class":
      return add({
        charTest: { kind: "class", negate: ast.negate, ranges: ast.ranges },
        charTarget: next,
      });
    case "anchor":
      return ast.at === "start"
        ? add({ assertStart: [next] })
        : add({ assertEnd: [next] });
    case "concat": {
      let cont = next;
      for (let i = ast.parts.length - 1; i >= 0; i -= 1) {
        cont = build(ast.parts[i]!, states, cont);
      }
      return cont;
    }
    case "alt": {
      const targets = ast.options.map((option) => build(option, states, next));
      return add({ eps: targets });
    }
    case "repeat": {
      if (ast.max === null && ast.min === 0) {
        // star：先建循环 split，body 完成后回到 split。
        const split = add({});
        const body = build(ast.node, states, split);
        states[split]!.eps = [body, next];
        return split;
      }
      if (ast.max === null && ast.min === 1) {
        const split = add({});
        const body = build(ast.node, states, split);
        states[split]!.eps = [body, next];
        return body;
      }
      if (ast.max === 1 && ast.min === 0) {
        const body = build(ast.node, states, next);
        return add({ eps: [body, next] });
      }
      throw new Error("unsupported quantifier shape");
    }
  }
}

/** 将 AST 编译为可模拟执行的 NFA。 */
export function compileAst(ast: AstNode): CompiledPattern {
  const states: State[] = [];
  states.push({
    charTest: null,
    charTarget: -1,
    eps: [],
    assertStart: [],
    assertEnd: [],
    accept: true,
  });
  const start = build(ast, states, 0);
  return { states, start };
}

/** epsilon 闭包：沿 eps 与当前位置可用的锚点断言扩展状态集合。 */
function closure(
  states: readonly State[],
  seed: readonly number[],
  pos: number,
  textLength: number,
): number[] {
  const seen = new Set<number>();
  const stack = [...seed];
  const out: number[] = [];
  while (stack.length > 0) {
    const idx = stack.pop()!;
    if (seen.has(idx)) continue;
    seen.add(idx);
    out.push(idx);
    const state = states[idx]!;
    for (const target of state.eps) stack.push(target);
    if (pos === 0) {
      for (const target of state.assertStart) stack.push(target);
    }
    if (pos === textLength) {
      for (const target of state.assertEnd) stack.push(target);
    }
  }
  return out;
}

/**
 * 从 text[start] 开始模拟 NFA，返回所有可行终点中最大的那个（>start）。
 * 无命中返回 null。
 */
function maxEndFrom(
  pattern: CompiledPattern,
  text: readonly string[],
  start: number,
): number | null {
  const { states } = pattern;
  const n = text.length;
  let current = closure(states, [pattern.start], start, n);
  let best: number | null = null;
  for (let pos = start; pos <= n; pos += 1) {
    if (pos > start) {
      for (const idx of current) {
        if (states[idx]!.accept) {
          best = pos;
          break;
        }
      }
    }
    if (pos === n) break;
    const cp = text[pos]!.codePointAt(0)!;
    const nextSeed: number[] = [];
    for (const idx of current) {
      const state = states[idx]!;
      if (state.charTest !== null && testChar(state.charTest, cp)) {
        nextSeed.push(state.charTarget);
      }
    }
    if (nextSeed.length === 0) break;
    current = closure(states, nextSeed, pos + 1, n);
  }
  return best;
}

/**
 * 在码点数组上寻找该表达式的最佳命中区间：
 * 起点最小；起点相同时终点最大。零长度命中不参与。
 * 无命中返回 null。
 */
export function bestInterval(
  pattern: CompiledPattern,
  text: readonly string[],
): { start: number; end: number } | null {
  for (let start = 0; start < text.length; start += 1) {
    const end = maxEndFrom(pattern, text, start);
    if (end !== null) return { start, end };
  }
  return null;
}
