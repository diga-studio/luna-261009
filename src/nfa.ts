import type { Ast, ClassItem } from "./parser.js";
import type { Program } from "./types.js";

type Inst =
  | { op: "char"; cp: number }
  | { op: "any" }
  | { op: "class"; negate: boolean; items: ClassItem[] }
  | { op: "split"; a: number; b: number }
  | { op: "jmp"; to: number }
  | { op: "anchorStart" }
  | { op: "anchorEnd" }
  | { op: "match" };

export class NfaProgram implements Program {
  readonly insts: Inst[] = [];
  constructor(readonly source: string) {}
}

function emitAst(prog: NfaProgram, ast: Ast): void {
  switch (ast.kind) {
    case "empty":
      return;
    case "char":
      prog.insts.push({ op: "char", cp: ast.cp });
      return;
    case "any":
      prog.insts.push({ op: "any" });
      return;
    case "class":
      prog.insts.push({ op: "class", negate: ast.negate, items: ast.items });
      return;
    case "anchorStart":
      prog.insts.push({ op: "anchorStart" });
      return;
    case "anchorEnd":
      prog.insts.push({ op: "anchorEnd" });
      return;
    case "concat":
      for (const part of ast.parts) emitAst(prog, part);
      return;
    case "alt":
      emitAlt(prog, ast.options);
      return;
    case "repeat": {
      emitRepeat(prog, ast.node, ast.min, ast.max);
      return;
    }
  }
}

function emitAlt(prog: NfaProgram, options: Ast[]): void {
  const jmpSlots: number[] = [];
  for (let i = 0; i < options.length; i++) {
    const isLast = i === options.length - 1;
    let splitAt = -1;
    if (!isLast) {
      splitAt = prog.insts.length;
      prog.insts.push({ op: "split", a: -1, b: -1 });
    }
    const bodyStart = prog.insts.length;
    emitAst(prog, options[i]);
    if (!isLast) {
      jmpSlots.push(prog.insts.length);
      prog.insts.push({ op: "jmp", to: -1 });
      (prog.insts[splitAt] as { a: number; b: number }).a = bodyStart;
      (prog.insts[splitAt] as { a: number; b: number }).b = prog.insts.length;
    }
  }
  const join = prog.insts.length;
  for (const slot of jmpSlots) (prog.insts[slot] as { to: number }).to = join;
}

function emitRepeat(prog: NfaProgram, node: Ast, min: number, max: number | null): void {
  // 展开有界重复：node{min} 必需部分 + (max-min) 个可选部分；max 为 null 时用循环。
  for (let i = 0; i < min; i++) emitAst(prog, node);
  if (max === null) {
    // 尾部：L: split(body, end); body; jmp L; end:
    const splitAt = prog.insts.length;
    prog.insts.push({ op: "split", a: -1, b: -1 });
    const bodyStart = prog.insts.length;
    emitAst(prog, node);
    prog.insts.push({ op: "jmp", to: splitAt });
    const end = prog.insts.length;
    (prog.insts[splitAt] as { a: number; b: number }).a = bodyStart;
    (prog.insts[splitAt] as { a: number; b: number }).b = end;
  } else {
    const jmpSlots: number[] = [];
    for (let i = min; i < max; i++) {
      const splitAt = prog.insts.length;
      prog.insts.push({ op: "split", a: -1, b: -1 });
      (prog.insts[splitAt] as { a: number }).a = prog.insts.length;
      emitAst(prog, node);
      jmpSlots.push(splitAt);
    }
    const end = prog.insts.length;
    for (const slot of jmpSlots) (prog.insts[slot] as { b: number }).b = end;
  }
}

/** 将 AST 编译为 NFA 程序。 */
export function compileAst(source: string, ast: Ast): Program {
  const prog = new NfaProgram(source);
  emitAst(prog, ast);
  prog.insts.push({ op: "match" });
  return prog;
}

function classMatches(negate: boolean, items: ClassItem[], cp: number): boolean {
  let hit = false;
  for (const item of items) {
    if (item.kind === "char") {
      if (item.cp === cp) { hit = true; break; }
    } else if (cp >= item.lo && cp <= item.hi) {
      hit = true;
      break;
    }
  }
  return negate ? !hit : hit;
}

/** 线程集合的 epsilon 闭包（处理 split/jmp/锚点），visited 防止 (a*)* 之类死循环。 */
function addThread(prog: NfaProgram, list: number[], pc: number, pos: number, textLen: number, visited: Set<number>): void {
  if (visited.has(pc)) return;
  visited.add(pc);
  const inst = prog.insts[pc];
  switch (inst.op) {
    case "split":
      addThread(prog, list, inst.a, pos, textLen, visited);
      addThread(prog, list, inst.b, pos, textLen, visited);
      return;
    case "jmp":
      addThread(prog, list, inst.to, pos, textLen, visited);
      return;
    case "anchorStart":
      if (pos === 0) addThread(prog, list, pc + 1, pos, textLen, visited);
      return;
    case "anchorEnd":
      if (pos === textLen) addThread(prog, list, pc + 1, pos, textLen, visited);
      return;
    default:
      list.push(pc);
  }
}

function stepInst(inst: Inst, cp: number): boolean {
  switch (inst.op) {
    case "char":
      return inst.cp === cp;
    case "any":
      return true; // 通配符包含换行
    case "class":
      return classMatches(inst.negate, inst.items, cp);
    default:
      return false;
  }
}

/**
 * 在码点数组上运行程序，返回每个起点的最长非零长度命中（左闭右开）。
 * 纯函数，不携带任何跨调用状态。
 */
export function runProgram(
  program: Program,
  text: number[],
): Array<{ start: number; end: number }> {
  const prog = program as NfaProgram;
  const n = text.length;
  const results: Array<{ start: number; end: number }> = [];
  for (let start = 0; start < n; start++) {
    let clist: number[] = [];
    addThread(prog, clist, 0, start, n, new Set());
    let bestEnd = -1;
    for (let pos = start; pos < n && clist.length > 0; pos++) {
      const cp = text[pos];
      const nlist: number[] = [];
      const visited = new Set<number>();
      for (const pc of clist) {
        const inst = prog.insts[pc];
        if (inst.op === "match") {
          if (pos > bestEnd) bestEnd = pos;
          continue;
        }
        if (stepInst(inst, cp)) {
          addThread(prog, nlist, pc + 1, pos + 1, n, visited);
        }
      }
      clist = nlist;
    }
    // 文本耗尽后仍可能到达 match（例如尾部锚点之外的零宽后缀）
    for (const pc of clist) {
      if (prog.insts[pc].op === "match" && n > bestEnd) bestEnd = n;
    }
    if (bestEnd > start) results.push({ start, end: bestEnd });
  }
  return results;
}
