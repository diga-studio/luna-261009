/** 表达式 AST。 */
export type Ast =
  | { kind: "empty" }
  | { kind: "char"; cp: number }
  | { kind: "any" }
  | { kind: "class"; negate: boolean; items: ClassItem[] }
  | { kind: "concat"; parts: Ast[] }
  | { kind: "alt"; options: Ast[] }
  | { kind: "repeat"; node: Ast; min: number; max: number | null }
  | { kind: "anchorStart" }
  | { kind: "anchorEnd" };

export type ClassItem =
  | { kind: "char"; cp: number }
  | { kind: "range"; lo: number; hi: number };

const SYNTAX_CHARS = new Set(["(", ")", "[", "]", "|", "*", "+", "?", ".", "^", "$", "\\"]);

function isSyntaxChar(ch: string): boolean {
  return SYNTAX_CHARS.has(ch);
}

function isAlphaNum(cp: number): boolean {
  return (
    (cp >= 0x30 && cp <= 0x39) ||
    (cp >= 0x41 && cp <= 0x5a) ||
    (cp >= 0x61 && cp <= 0x7a)
  );
}

class Parser {
  private readonly cps: number[];
  private pos = 0;

  constructor(private readonly source: string) {
    this.cps = Array.from(source, (ch) => ch.codePointAt(0)!);
  }

  parse(): Ast {
    const ast = this.parseAlt();
    if (this.pos < this.cps.length) {
      throw this.error(`unexpected '${String.fromCodePoint(this.cps[this.pos])}'`);
    }
    return ast;
  }

  private error(msg: string): Error {
    return new Error(`invalid pattern ${JSON.stringify(this.source)}: ${msg} at offset ${this.pos}`);
  }

  private peek(): number | undefined {
    return this.cps[this.pos];
  }

  private next(): number {
    if (this.pos >= this.cps.length) throw this.error("unexpected end of pattern");
    return this.cps[this.pos++];
  }

  private parseAlt(): Ast {
    const options: Ast[] = [this.parseConcat()];
    while (this.peek() === 0x7c /* | */) {
      this.pos++;
      options.push(this.parseConcat());
    }
    return options.length === 1 ? options[0] : { kind: "alt", options };
  }

  private parseConcat(): Ast {
    const parts: Ast[] = [];
    for (;;) {
      const cp = this.peek();
      if (cp === undefined || cp === 0x7c /* | */ || cp === 0x29 /* ) */) break;
      parts.push(this.parseRepeat());
    }
    if (parts.length === 0) return { kind: "empty" };
    return parts.length === 1 ? parts[0] : { kind: "concat", parts };
  }

  private parseRepeat(): Ast {
    const atom = this.parseAtom();
    const cp = this.peek();
    if (cp === 0x2a /* * */ || cp === 0x2b /* + */ || cp === 0x3f /* ? */) {
      this.pos++;
      const min = cp === 0x2b ? 1 : 0;
      const max = cp === 0x3f ? 1 : null;
      const node: Ast = { kind: "repeat", node: atom, min, max };
      const after = this.peek();
      if (after === 0x2a || after === 0x2b || after === 0x3f) {
        throw this.error("stacked quantifiers are not supported");
      }
      return node;
    }
    return atom;
  }

  private parseAtom(): Ast {
    const cp = this.peek();
    if (cp === undefined) throw this.error("unexpected end of pattern");
    switch (cp) {
      case 0x28 /* ( */: {
        this.pos++;
        const inner = this.parseAlt();
        if (this.peek() !== 0x29 /* ) */) throw this.error("unclosed group");
        this.pos++;
        return inner;
      }
      case 0x29 /* ) */:
        throw this.error("unbalanced ')'");
      case 0x5b /* [ */:
        return this.parseClass();
      case 0x2e /* . */:
        this.pos++;
        return { kind: "any" };
      case 0x5e /* ^ */:
        this.pos++;
        return { kind: "anchorStart" };
      case 0x24 /* $ */:
        this.pos++;
        return { kind: "anchorEnd" };
      case 0x2a:
      case 0x2b:
      case 0x3f:
        throw this.error("quantifier without a target");
      case 0x5c /* \\ */:
        return { kind: "char", cp: this.parseEscape() };
      default:
        this.pos++;
        return { kind: "char", cp };
    }
  }

  /** 反斜杠转义：仅用于把语法元字符（或非字母数字字符）作为字面量；不支持简写字符类。 */
  private parseEscape(): number {
    this.pos++; // consume backslash
    const cp = this.next();
    if (isAlphaNum(cp)) {
      throw this.error(`unsupported escape '\\${String.fromCodePoint(cp)}' (shorthand classes are not supported)`);
    }
    return cp;
  }

  private parseClass(): Ast {
    this.pos++; // consume '['
    let negate = false;
    if (this.peek() === 0x5e /* ^ */) {
      negate = true;
      this.pos++;
    }
    const items: ClassItem[] = [];
    let first = true;
    for (;;) {
      const cp = this.peek();
      if (cp === undefined) throw this.error("unclosed character class");
      if (cp === 0x5d /* ] */ && !first) {
        this.pos++;
        break;
      }
      first = false;
      const lo = this.parseClassChar();
      if (this.peek() === 0x2d /* - */ && this.cps[this.pos + 1] !== 0x5d && this.cps[this.pos + 1] !== undefined) {
        this.pos++; // consume '-'
        const hi = this.parseClassChar();
        if (lo > hi) {
          throw this.error(
            `range out of order: '${String.fromCodePoint(lo)}-${String.fromCodePoint(hi)}'`,
          );
        }
        items.push({ kind: "range", lo, hi });
      } else {
        items.push({ kind: "char", cp: lo });
      }
    }
    if (items.length === 0) throw this.error("empty character class");
    return { kind: "class", negate, items };
  }

  private parseClassChar(): number {
    const cp = this.peek();
    if (cp === undefined) throw this.error("unclosed character class");
    if (cp === 0x5c /* \\ */) return this.parseEscape();
    this.pos++;
    return cp;
  }
}

/** 解析表达式为 AST。语法错误抛出 Error。 */
export function parsePattern(source: string): Ast {
  return new Parser(source).parse();
}

export { isSyntaxChar };
