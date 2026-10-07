import { tokenize, type Token } from "./tokenizer.js";
import type {
  ColumnRef,
  Condition,
  CteDef,
  DataSource,
  Operand,
  ProjectionItem,
  QueryBlock,
  SelectStatement,
} from "./types.js";

const RESERVED = new Set([
  "select", "from", "where", "and", "or", "not", "as", "with",
  "in", "is", "null", "between", "exists", "true", "false",
]);

class Parser {
  pos = 0;
  constructor(public tokens: Token[]) {}

  private peek(): Token {
    return this.tokens[this.pos];
  }
  private next(): Token {
    return this.tokens[this.pos++];
  }
  private isKw(kw: string): boolean {
    const t = this.peek();
    return t.kind === "ident" && t.text === kw;
  }
  private eatKw(kw: string): boolean {
    if (this.isKw(kw)) {
      this.pos++;
      return true;
    }
    return false;
  }
  private expectKw(kw: string): void {
    if (!this.eatKw(kw)) throw new Error(`parser: expected keyword ${kw}, got ${this.peek().text}`);
  }
  private isSym(s: string): boolean {
    const t = this.peek();
    return t.kind === "symbol" && t.text === s;
  }
  private eatSym(s: string): boolean {
    if (this.isSym(s)) {
      this.pos++;
      return true;
    }
    return false;
  }
  private expectSym(s: string): void {
    if (!this.eatSym(s)) throw new Error(`parser: expected ${s}, got ${this.peek().text}`);
  }
  private name(): string {
    const t = this.next();
    if (t.kind === "qident") return t.text;
    if (t.kind === "ident" && !RESERVED.has(t.text)) return t.text;
    throw new Error(`parser: expected identifier, got ${t.text}`);
  }

  atEnd(): boolean {
    return this.peek().kind === "eof";
  }

  /** 一条 SELECT 语句（可带 WITH），不消费结尾分号 */
  selectStatement(): SelectStatement {
    const ctes: CteDef[] = [];
    if (this.eatKw("with")) {
      do {
        const cteName = this.name();
        this.expectKw("as");
        this.expectSym("(");
        const query = this.selectStatement();
        this.expectSym(")");
        ctes.push({ name: cteName, query });
      } while (this.eatSym(","));
    }
    const body = this.queryBlock();
    return { ctes, body };
  }

  private queryBlock(): QueryBlock {
    this.expectKw("select");
    const projection = this.projectionList();
    this.expectKw("from");
    const source = this.dataSource();
    let where: Condition | null = null;
    if (this.eatKw("where")) {
      where = this.orExpr();
    }
    return { projection, source, where };
  }

  private projectionList(): ProjectionItem[] {
    const items: ProjectionItem[] = [];
    for (;;) {
      if (this.isSym("*")) {
        this.next();
        items.push({ kind: "star" });
      } else if (this.peek().kind === "number" || this.peek().kind === "string") {
        this.next();
        items.push({ kind: "literal" });
      } else {
        const col = this.columnRef();
        if (col.name === "*") {
          items.push({ kind: "star" });
        } else {
          let alias: string | null = null;
          if (this.eatKw("as")) {
            alias = this.name();
          } else {
            const t = this.peek();
            if (t.kind === "qident" || (t.kind === "ident" && !RESERVED.has(t.text))) {
              alias = this.name();
            }
          }
          items.push({ kind: "column", column: col, alias });
        }
      }
      if (!this.eatSym(",")) break;
    }
    return items;
  }

  private columnRef(): ColumnRef {
    const first = this.name();
    if (this.eatSym(".")) {
      if (this.eatSym("*")) return { qualifier: first, name: "*" };
      return { qualifier: first, name: this.name() };
    }
    return { qualifier: null, name: first };
  }

  private dataSource(): DataSource {
    if (this.eatSym("(")) {
      const query = this.selectStatement();
      this.expectSym(")");
      const alias = this.optionalAlias();
      return { kind: "subquery", query, alias };
    }
    const name = this.name();
    const alias = this.optionalAlias();
    return { kind: "table", name, alias };
  }

  private optionalAlias(): string | null {
    if (this.eatKw("as")) return this.name();
    const t = this.peek();
    if (t.kind === "qident" || (t.kind === "ident" && !RESERVED.has(t.text))) {
      return this.name();
    }
    return null;
  }

  private orExpr(): Condition {
    const items = [this.andExpr()];
    while (this.eatKw("or")) items.push(this.andExpr());
    return items.length === 1 ? items[0] : { kind: "or", items };
  }

  private andExpr(): Condition {
    const items = [this.pred()];
    while (this.eatKw("and")) items.push(this.pred());
    return items.length === 1 ? items[0] : { kind: "and", items };
  }

  private pred(): Condition {
    if (this.eatSym("(")) {
      const c = this.orExpr();
      this.expectSym(")");
      return c;
    }
    if (this.eatKw("exists")) {
      this.expectSym("(");
      const query = this.selectStatement();
      this.expectSym(")");
      return { kind: "exists", query };
    }
    const left = this.operand();
    if (this.eatKw("is")) {
      const negated = this.eatKw("not");
      this.expectKw("null");
      // IS NOT NULL 不是等值约束
      return negated ? { kind: "unsupported" } : { kind: "isNull", operand: left };
    }
    const negated = this.eatKw("not");
    if (this.eatKw("between")) {
      const low = this.operand();
      this.expectKw("and");
      const high = this.operand();
      // NOT BETWEEN 不提供可用约束
      return negated ? { kind: "unsupported" } : { kind: "between", operand: left, low, high };
    }
    if (this.eatKw("in")) {
      this.expectSym("(");
      const values: Operand[] = [];
      do {
        values.push(this.operand());
      } while (this.eatSym(","));
      this.expectSym(")");
      // NOT IN 不是等值约束
      return negated ? { kind: "unsupported" } : { kind: "in", operand: left, values };
    }
    if (negated) return { kind: "unsupported" };
    const opTok = this.next();
    if (opTok.kind === "symbol" && ["=", "<>", "!=", "<", "<=", ">", ">="].includes(opTok.text)) {
      const right = this.operand();
      return { kind: "comparison", left, op: opTok.text as never, right };
    }
    throw new Error(`parser: unexpected token in predicate: ${opTok.text}`);
  }

  private operand(): Operand {
    const t = this.peek();
    if (t.kind === "number" || t.kind === "string") {
      this.next();
      return { kind: "literal" };
    }
    if (t.kind === "ident" && (t.text === "true" || t.text === "false")) {
      this.next();
      return { kind: "literal" };
    }
    return { kind: "column", column: this.columnRef() };
  }
}

/** 解析 SQL 批次（分号分隔的多条 SELECT） */
export function parse(sql: string): SelectStatement[] {
  const p = new Parser(tokenize(sql));
  const out: SelectStatement[] = [];
  while (!p.atEnd()) {
    while (!p.atEnd() && p.tokens[p.pos].kind === "symbol" && p.tokens[p.pos].text === ";") p.pos++;
    if (p.atEnd()) break;
    out.push(p.selectStatement());
  }
  return out;
}
