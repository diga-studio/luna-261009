import { StepParseError } from "./types.js";

/** Streaming lexer: accepts arbitrary UTF-8 byte splits, yields tokens. */

export type Token =
  | { readonly k: "ident"; readonly v: string }
  | { readonly k: "num"; readonly raw: string }
  | { readonly k: "str"; readonly v: string }
  | { readonly k: "ref"; readonly id: string }
  | { readonly k: "enum"; readonly v: string }
  | { readonly k: "punct"; readonly c: string }
  | { readonly k: "eof" };

const MAX_ENTITY_ID = 9223372036854775807n;

function isWs(c: string): boolean {
  return c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v";
}
function isDigit(c: string): boolean {
  return c >= "0" && c <= "9";
}
function isLetter(c: string): boolean {
  return (c >= "A" && c <= "Z") || (c >= "a" && c <= "z");
}
function isIdentChar(c: string): boolean {
  return isLetter(c) || isDigit(c) || c === "_" || c === "-";
}
function isHex(c: string): boolean {
  return isDigit(c) || (c >= "A" && c <= "F") || (c >= "a" && c <= "f");
}

/**
 * Incremental lexer. Feed bytes with write(), then pull tokens with next().
 * next() returns null when more input is needed to complete a token.
 * mark()/rollback() allow the parser to retry a record after more input
 * arrives; compact() drops consumed input to bound memory.
 */
export class Lexer {
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private buf = "";
  private pos = 0;
  private markPos: number | null = null;
  private ended = false;
  private peeked: Token | null | undefined; // undefined = not peeking

  write(chunk: Uint8Array): void {
    if (this.ended) throw new StepParseError("write after end");
    // Decode in small slices: large single allocations fragment the heap
    // and inflate peak RSS.
    const SLICE = 64 * 1024;
    for (let off = 0; off < chunk.length; off += SLICE) {
      let decoded: string;
      try {
        decoded = this.decoder.decode(chunk.subarray(off, off + SLICE), { stream: true });
      } catch {
        throw new StepParseError("invalid UTF-8 input");
      }
      this.buf += decoded;
    }
    if (this.peeked === null) this.peeked = undefined;
    this.compact();
  }

  end(): void {
    if (this.ended) return;
    try {
      this.buf += this.decoder.decode();
    } catch {
      throw new StepParseError("invalid UTF-8 input (truncated sequence)");
    }
    this.ended = true;
    if (this.peeked === null) this.peeked = undefined;
  }

  mark(): void {
    this.markPos = this.pos;
  }
  rollback(): void {
    if (this.markPos === null) throw new Error("rollback without mark");
    this.pos = this.markPos;
    this.markPos = null;
    this.peeked = undefined;
  }
  commit(): void {
    this.markPos = null;
  }

  /** Current scan position in decoded characters (for record size checks). */
  tell(): number {
    return this.pos;
  }

  private compact(): void {
    const base = this.markPos ?? this.pos;
    if (base > 1 << 20) {
      // slice() creates a SlicedString that pins the whole original buffer;
      // round-trip through Buffer to get a flat, independent string.
      this.buf = Buffer.from(this.buf.slice(base), "utf8").toString("utf8");
      this.pos -= base;
      if (this.markPos !== null) this.markPos -= base;
    }
  }

  /** Next token, or null if more input is required. */
  next(): Token | null {
    if (this.peeked !== undefined) {
      const t = this.peeked;
      this.peeked = undefined;
      return t;
    }
    return this.scan();
  }

  peek(): Token | null {
    if (this.peeked === undefined) {
      const t = this.scan();
      this.peeked = t;
      return t;
    }
    return this.peeked;
  }

  private scan(): Token | null {
    const start = this.pos;
    const tok = this.scanInner();
    if (tok === null) this.pos = start;
    return tok;
  }

  /** Returns null when the buffer ends mid-token and input is not ended. */
  private scanInner(): Token | null {
    // Skip whitespace and non-nested block comments.
    for (;;) {
      if (this.pos >= this.buf.length) {
        return this.ended ? { k: "eof" } : null;
      }
      const c = this.buf[this.pos];
      if (isWs(c)) {
        this.pos++;
        continue;
      }
      if (c === "/" && this.pos + 1 >= this.buf.length && !this.ended) return null;
      if (c === "/" && this.buf[this.pos + 1] === "*") {
        const close = this.buf.indexOf("*/", this.pos + 2);
        if (close < 0) {
          if (this.ended) throw new StepParseError("unterminated comment");
          return null;
        }
        this.pos = close + 2;
        continue;
      }
      break;
    }

    const c = this.buf[this.pos];

    if (c === "'") return this.scanString();

    if (c === "#") {
      let i = this.pos + 1;
      while (i < this.buf.length && isDigit(this.buf[i])) i++;
      if (i >= this.buf.length && !this.ended) return null;
      if (i === this.pos + 1) throw new StepParseError("'#' not followed by digits");
      const id = BigInt(this.buf.slice(this.pos + 1, i));
      if (id < 1n || id > MAX_ENTITY_ID) {
        throw new StepParseError(`entity id out of range: #${this.buf.slice(this.pos + 1, i)}`);
      }
      this.pos = i;
      return { k: "ref", id: id.toString() };
    }

    if (isDigit(c) || c === "+" || c === "-" || (c === "." && isDigit(this.buf[this.pos + 1] ?? ""))) {
      return this.scanNumber();
    }

    if (c === ".") {
      // Enumeration: .NAME.
      let i = this.pos + 1;
      while (i < this.buf.length && (isLetter(this.buf[i]) || isDigit(this.buf[i]) || this.buf[i] === "_")) i++;
      if (i >= this.buf.length && !this.ended) return null;
      if (this.buf[i] !== ".") throw new StepParseError("malformed enumeration literal");
      const v = this.buf.slice(this.pos + 1, i);
      if (v.length === 0) throw new StepParseError("empty enumeration literal");
      this.pos = i + 1;
      return { k: "enum", v };
    }

    if (isLetter(c)) {
      let i = this.pos + 1;
      while (i < this.buf.length && isIdentChar(this.buf[i])) i++;
      if (i >= this.buf.length && !this.ended) return null;
      const v = this.buf.slice(this.pos, i);
      this.pos = i;
      return { k: "ident", v };
    }

    if ("(),;=$*".includes(c)) {
      this.pos++;
      return { k: "punct", c };
    }

    throw new StepParseError(`unexpected character ${JSON.stringify(c)}`);
  }

  private scanNumber(): Token | null {
    const b = this.buf;
    let i = this.pos;
    if (b[i] === "+" || b[i] === "-") i++;
    if (i >= b.length && !this.ended) return null;
    let digits = 0;
    while (i < b.length && isDigit(b[i])) { i++; digits++; }
    let hasDot = false;
    if (b[i] === ".") {
      hasDot = true;
      i++;
      while (i < b.length && isDigit(b[i])) { i++; digits++; }
    }
    if (i >= b.length && !this.ended) {
      // Number may continue in the next chunk.
      return null;
    }
    if (digits === 0) throw new StepParseError("malformed number");
    if ((b[i] === "E" || b[i] === "e")) {
      let j = i + 1;
      if (b[j] === "+" || b[j] === "-") j++;
      let expDigits = 0;
      while (j < b.length && isDigit(b[j])) { j++; expDigits++; }
      if (j >= b.length && !this.ended) return null;
      if (expDigits > 0) i = j;
      // A bare 'E' with no exponent digits is left for the next token (will error there).
    }
    const raw = b.slice(this.pos, i);
    this.pos = i;
    void hasDot;
    return { k: "num", raw };
  }

  private scanString(): Token | null {
    const b = this.buf;
    let i = this.pos + 1;
    let out = "";
    let chunkStart = i;
    for (;;) {
      if (i >= b.length) {
        if (this.ended) throw new StepParseError("unterminated string");
        return null;
      }
      const c = b[i];
      if (c === "'") {
        if (b[i + 1] === "'") {
          out += b.slice(chunkStart, i) + "'";
          i += 2;
          chunkStart = i;
          continue;
        }
        out += b.slice(chunkStart, i);
        this.pos = i + 1;
        return { k: "str", v: out };
      }
      if (c === "\\") {
        const n = b[i + 1];
        if (n === undefined) {
          if (this.ended) throw new StepParseError("unterminated string");
          return null;
        }
        if (n === "\\") {
          out += b.slice(chunkStart, i) + "\\";
          i += 2;
          chunkStart = i;
          continue;
        }
        if (n === "X") {
          const kind = b[i + 2];
          if (kind === undefined && !this.ended) return null;
          if (kind !== "2" && kind !== "4") throw new StepParseError(`unsupported escape \\X${kind ?? ""}`);
          if (b[i + 3] === undefined && !this.ended) return null;
          if (b[i + 3] !== "\\") throw new StepParseError("malformed \\Xn\\ escape");
          out += b.slice(chunkStart, i);
          const decoded = this.scanXEscape(i + 4, kind === "2" ? 4 : 8);
          if (decoded === null) return null; // need more input
          out += decoded.text;
          i = decoded.next;
          chunkStart = i;
          continue;
        }
        // n === '\\' but not followed by another backslash
        throw new StepParseError("unsupported escape: lone backslash");
      }
      i++;
    }
  }

  /** Scan hex code units after `\X2\` / `\X4\` up to the closing `\X0\`. */
  private scanXEscape(
    from: number,
    unitLen: number,
  ): { text: string; next: number } | null {
    const b = this.buf;
    const units: number[] = [];
    let i = from;
    for (;;) {
      if (i + unitLen > b.length) {
        if (this.ended) throw new StepParseError("unterminated \\Xn\\ escape");
        return null;
      }
      // Closing sequence \X0\
      if (b[i] === "\\") {
        if (i + 3 > b.length) {
          if (this.ended) throw new StepParseError("unterminated \\Xn\\ escape");
          return null;
        }
        if (b[i + 1] === "X" && b[i + 2] === "0" && b[i + 3] === "\\") {
          return { text: unitsToString(units, unitLen), next: i + 4 };
        }
        throw new StepParseError("malformed \\Xn\\ escape body");
      }
      let v = 0;
      for (let k = 0; k < unitLen; k++) {
        const ch = b[i + k];
        if (!isHex(ch)) throw new StepParseError(`invalid hex digit ${JSON.stringify(ch)} in \\Xn\\ escape`);
        v = v * 16 + parseInt(ch, 16);
      }
      units.push(v);
      i += unitLen;
    }
  }
}

function unitsToString(units: number[], unitLen: number): string {
  if (unitLen === 8) {
    // \X4\: each unit is a Unicode code point; must be a valid scalar value.
    let s = "";
    for (const cp of units) {
      if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
        throw new StepParseError(`invalid Unicode code point U+${cp.toString(16).toUpperCase()}`);
      }
      s += String.fromCodePoint(cp);
    }
    return s;
  }
  // \X2\: UTF-16 code units; combine surrogate pairs, reject lone surrogates.
  let s = "";
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    if (u >= 0xd800 && u <= 0xdbff) {
      const lo = units[i + 1];
      if (lo === undefined || lo < 0xdc00 || lo > 0xdfff) {
        throw new StepParseError("lone high surrogate in \\X2\\ escape");
      }
      s += String.fromCharCode(u, lo);
      i++;
    } else if (u >= 0xdc00 && u <= 0xdfff) {
      throw new StepParseError("lone low surrogate in \\X2\\ escape");
    } else {
      s += String.fromCharCode(u);
    }
  }
  return s;
}
