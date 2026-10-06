/** 表达式抽象语法树节点。字符均以 Unicode 码点表示。 */
export type AstNode =
  | { kind: "empty" }
  | { kind: "char"; cp: number }
  | { kind: "any" }
  | { kind: "class"; negate: boolean; ranges: readonly [number, number][] }
  | { kind: "anchor"; at: "start" | "end" }
  | { kind: "concat"; parts: readonly AstNode[] }
  | { kind: "alt"; options: readonly AstNode[] }
  | { kind: "repeat"; node: AstNode; min: number; max: number | null };

/** 解析表达式源码为 AST。语法错误时抛出 Error。 */
export function parsePattern(source: string): AstNode {
  const chars = Array.from(source);
  let pos = 0;

  const fail = (message: string): never => {
    throw new Error(`Invalid pattern ${JSON.stringify(source)}: ${message} (at offset ${pos})`);
  };

  const peek = (): string | undefined => chars[pos];

  const parseEscape = (): number => {
    // 调用时 pos 指向 '\\'。转义只把后一个字符变成字面字符，不支持简写字符类。
    pos += 1;
    const ch = chars[pos];
    if (ch === undefined) fail("trailing backslash");
    pos += 1;
    return ch!.codePointAt(0)!;
  };

  const parseClass = (): AstNode => {
    // 调用时 pos 指向 '['。
    pos += 1;
    let negate = false;
    if (peek() === "^") {
      negate = true;
      pos += 1;
    }
    const ranges: [number, number][] = [];
    const readClassChar = (): number => {
      const ch = chars[pos];
      if (ch === undefined) fail("unterminated character class");
      if (ch === "\\") return parseEscape();
      pos += 1;
      return ch!.codePointAt(0)!;
    };
    while (true) {
      const ch = peek();
      if (ch === undefined) fail("unterminated character class");
      if (ch === "]") {
        pos += 1;
        break;
      }
      const lo = readClassChar();
      // “-”仅在两侧都有字符时构成范围，否则是字面字符。
      if (peek() === "-" && chars[pos + 1] !== undefined && chars[pos + 1] !== "]") {
        pos += 1;
        const hi = readClassChar();
        if (lo > hi) fail("character class range out of order");
        ranges.push([lo, hi]);
      } else {
        ranges.push([lo, lo]);
      }
    }
    ranges.sort((a, b) => a[0] - b[0]);
    return { kind: "class", negate, ranges };
  };

  const parseAtom = (): AstNode | null => {
    const ch = peek();
    if (ch === undefined || ch === ")" || ch === "|") return null;
    if (ch === "*" || ch === "+" || ch === "?") fail("quantifier without a target");
    if (ch === "(") {
      pos += 1;
      const inner = parseAlt();
      if (peek() !== ")") fail("unclosed group");
      pos += 1;
      return inner;
    }
    if (ch === "[") return parseClass();
    if (ch === ".") {
      pos += 1;
      return { kind: "any" };
    }
    if (ch === "^") {
      pos += 1;
      return { kind: "anchor", at: "start" };
    }
    if (ch === "$") {
      pos += 1;
      return { kind: "anchor", at: "end" };
    }
    if (ch === "\\") return { kind: "char", cp: parseEscape() };
    pos += 1;
    return { kind: "char", cp: ch.codePointAt(0)! };
  };

  const parseRepeat = (): AstNode | null => {
    const atom = parseAtom();
    if (atom === null) return null;
    const ch = peek();
    if (ch === "*" || ch === "+" || ch === "?") {
      pos += 1;
      const next = peek();
      if (next === "*" || next === "+" || next === "?") {
        fail("multiple quantifiers on the same target");
      }
      if (ch === "*") return { kind: "repeat", node: atom, min: 0, max: null };
      if (ch === "+") return { kind: "repeat", node: atom, min: 1, max: null };
      return { kind: "repeat", node: atom, min: 0, max: 1 };
    }
    return atom;
  };

  const parseConcat = (): AstNode => {
    const parts: AstNode[] = [];
    while (true) {
      const node = parseRepeat();
      if (node === null) break;
      parts.push(node);
    }
    if (parts.length === 0) return { kind: "empty" };
    if (parts.length === 1) return parts[0]!;
    return { kind: "concat", parts };
  };

  const parseAlt = (): AstNode => {
    const options: AstNode[] = [parseConcat()];
    while (peek() === "|") {
      pos += 1;
      options.push(parseConcat());
    }
    if (options.length === 1) return options[0]!;
    return { kind: "alt", options };
  };

  const ast = parseAlt();
  if (peek() === ")") fail("unmatched closing parenthesis");
  if (pos !== chars.length) fail("unexpected trailing input");
  return ast;
}
