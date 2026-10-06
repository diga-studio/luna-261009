import { Lexer, type Token } from "./lexer.js";
import {
  StepParseError,
  type EntityComponent,
  type EntityRecord,
  type Param,
} from "./types.js";

/** Thrown internally when a step needs more input; the step is retried later. */
export class NeedMoreData extends Error {
  constructor() {
    super("need more data");
    this.name = "NeedMoreData";
  }
}

const MAX_RECORD_CHARS = 64 * 1024;
const MAX_DEPTH = 64;
const TYPE_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

type Phase = "prefix" | "headerKw" | "headerRecords" | "dataRecords" | "trailer" | "done";

/**
 * Pull parser over a Lexer. Each call to step() parses one atomic unit
 * (a structural keyword group, a header record, or an entity record).
 * If input runs out mid-step it throws NeedMoreData; the caller rolls the
 * lexer back and retries the step when more input arrives.
 */
export class Parser {
  private phase: Phase = "prefix";
  private refs: string[] = [];
  private recordStart: number | null = null;

  constructor(private readonly lexer: Lexer) {}

  get done(): boolean {
    return this.phase === "done";
  }

  /**
   * Parse one atomic step. Returns an entity record when the step completed
   * a DATA entity, otherwise null (structural progress or discarded header
   * record). Sets this.refs to the entity's direct references.
   */
  step(): EntityRecord | null {
    switch (this.phase) {
      case "prefix":
        this.expectIdent("ISO-10303-21");
        this.expectPunct(";");
        this.phase = "headerKw";
        return null;
      case "headerKw":
        this.expectIdent("HEADER");
        this.expectPunct(";");
        this.phase = "headerRecords";
        return null;
      case "headerRecords":
        return this.stepHeaderRecords();
      case "dataRecords":
        return this.stepDataRecords();
      case "trailer": {
        const t = this.lexer.next();
        if (t === null) throw new NeedMoreData();
        if (t.k !== "eof") {
          throw new StepParseError("unexpected content after END-ISO-10303-21;");
        }
        this.phase = "done";
        return null;
      }
      case "done":
        throw new StepParseError("parser already finished");
    }
  }

  private stepHeaderRecords(): EntityRecord | null {
    const t = this.peek();
    if (t.k === "ident" && t.v === "ENDSEC") {
      this.take();
      this.expectPunct(";");
      this.expectIdent("DATA");
      this.expectPunct(";");
      this.phase = "dataRecords";
      return null;
    }
    // Header record: TYPE '(' params ')' ';' — parsed for syntax, discarded.
    const start = this.lexer.tell();
    this.recordStart = start;
    this.refs = [];
    this.takeTypeName();
    this.expectPunct("(");
    this.parseParams(1);
    this.expectPunct(")");
    this.expectPunct(";");
    this.recordStart = null;
    this.checkRecordSize(start);
    this.refs = [];
    return null;
  }

  private stepDataRecords(): EntityRecord | null {
    const t = this.peek();
    if (t.k === "ident" && t.v === "ENDSEC") {
      this.take();
      this.expectPunct(";");
      this.expectIdent("END-ISO-10303-21");
      this.expectPunct(";");
      this.phase = "trailer";
      return null;
    }
    const start = this.lexer.tell();
    this.recordStart = start;
    this.refs = [];
    const idTok = this.take();
    if (idTok.k !== "ref") {
      throw new StepParseError(`expected entity reference (#id), got ${describe(idTok)}`);
    }
    this.expectPunct("=");
    const next = this.peek();
    let record: EntityRecord;
    if (next.k === "ident") {
      const name = this.takeTypeName();
      this.expectPunct("(");
      const params = this.parseParams(1);
      this.expectPunct(")");
      this.expectPunct(";");
      record = { id: idTok.id, complex: false, components: [{ name, params }] };
    } else if (next.k === "punct" && next.c === "(") {
      this.take();
      const components: EntityComponent[] = [];
      for (;;) {
        const p = this.peek();
        if (p.k === "punct" && p.c === ")") {
          this.take();
          break;
        }
        const name = this.takeTypeName();
        this.expectPunct("(");
        const params = this.parseParams(1);
        this.expectPunct(")");
        components.push({ name, params });
      }
      if (components.length === 0) {
        throw new StepParseError("complex entity with no components");
      }
      this.expectPunct(";");
      record = { id: idTok.id, complex: true, components };
    } else {
      throw new StepParseError(`expected entity body, got ${describe(next)}`);
    }
    this.checkRecordSize(start);
    this.recordStart = null;
    return record;
  }

  private checkRecordSize(start: number): void {
    if (this.lexer.tell() - start > MAX_RECORD_CHARS) {
      throw new StepParseError("record exceeds 64 KiB limit");
    }
  }

  private parseParams(depth: number): Param[] {
    if (depth > MAX_DEPTH) {
      throw new StepParseError("parameter nesting exceeds 64 levels");
    }
    const params: Param[] = [];
    const first = this.peek();
    if (first.k === "punct" && first.c === ")") return params;
    for (;;) {
      params.push(this.parseParam(depth));
      const t = this.peek();
      if (t.k === "punct" && t.c === ",") {
        this.take();
        continue;
      }
      return params;
    }
  }

  private parseParam(depth: number): Param {
    const t = this.take();
    switch (t.k) {
      case "ref":
        this.refs.push(t.id);
        return { t: "ref", id: t.id };
      case "num":
        return { t: "num", raw: t.raw };
      case "str":
        return { t: "str", v: t.v };
      case "enum":
        return { t: "enum", v: t.v };
      case "ident": {
        if (!TYPE_NAME_RE.test(t.v)) {
          throw new StepParseError(`invalid type name ${JSON.stringify(t.v)}`);
        }
        this.expectPunct("(");
        const items = this.parseParams(depth + 1);
        this.expectPunct(")");
        return { t: "typed", name: t.v, items };
      }
      case "punct":
        if (t.c === "(") {
          const items = this.parseParams(depth + 1);
          this.expectPunct(")");
          return { t: "list", items };
        }
        if (t.c === "$") return { t: "unset" };
        if (t.c === "*") return { t: "derived" };
        throw new StepParseError(`unexpected '${t.c}' in parameter list`);
      case "eof":
        throw new StepParseError("unexpected end of input in parameter list");
    }
  }

  private takeTypeName(): string {
    const t = this.take();
    if (t.k !== "ident" || !TYPE_NAME_RE.test(t.v)) {
      throw new StepParseError(`expected type name, got ${describe(t)}`);
    }
    return t.v;
  }

  private expectIdent(v: string): void {
    const t = this.take();
    if (t.k !== "ident" || t.v !== v) {
      throw new StepParseError(`expected ${v}, got ${describe(t)}`);
    }
  }

  private expectPunct(c: string): void {
    const t = this.take();
    if (t.k !== "punct" || t.c !== c) {
      throw new StepParseError(`expected '${c}', got ${describe(t)}`);
    }
  }

  private take(): Token {
    const t = this.lexer.next();
    if (t === null) throw new NeedMoreData();
    if (t.k === "eof") throw new StepParseError("unexpected end of input");
    if (this.recordStart !== null && this.lexer.tell() - this.recordStart > MAX_RECORD_CHARS) {
      throw new StepParseError("record exceeds 64 KiB limit");
    }
    return t;
  }

  private peek(): Token {
    const t = this.lexer.peek();
    if (t === null) throw new NeedMoreData();
    return t;
  }

  /** Direct references collected by the most recently completed record. */
  takeRefs(): string[] {
    const r = this.refs;
    this.refs = [];
    return r;
  }
}

function describe(t: Token): string {
  switch (t.k) {
    case "ident":
      return `identifier ${JSON.stringify(t.v)}`;
    case "num":
      return `number ${JSON.stringify(t.raw)}`;
    case "str":
      return "string";
    case "ref":
      return `#${t.id}`;
    case "enum":
      return `enum .${t.v}.`;
    case "punct":
      return `'${t.c}'`;
    case "eof":
      return "end of input";
  }
}
