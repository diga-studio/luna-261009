/** Parser: builds SelectStmt ASTs for the supported PostgreSQL SELECT subset. */

import { tokenize, Token } from './tokenizer';
import {
  CompareOp,
  Expr,
  FromSource,
  LiteralValue,
  SelectItem,
  SelectStmt,
} from './types';

const RESERVED = new Set([
  'select', 'from', 'where', 'and', 'or', 'not', 'as', 'with',
  'in', 'is', 'null', 'between', 'exists', 'true', 'false',
  'join', 'inner', 'left', 'right', 'full', 'cross', 'on',
  'group', 'order', 'limit', 'offset', 'having', 'union', 'recursive',
]);

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(sql: string) {
    this.tokens = tokenize(sql);
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    return this.tokens[this.pos++];
  }

  private error(message: string): Error {
    const tok = this.peek();
    return new Error(`${message} (at token ${JSON.stringify(tok.value)}, pos ${tok.pos})`);
  }

  private isKeyword(word: string): boolean {
    const tok = this.peek();
    return tok.type === 'ident' && tok.value === word;
  }

  private eatKeyword(word: string): boolean {
    if (this.isKeyword(word)) {
      this.pos++;
      return true;
    }
    return false;
  }

  private expectKeyword(word: string): void {
    if (!this.eatKeyword(word)) throw this.error(`Expected keyword ${word.toUpperCase()}`);
  }

  private isPunct(value: string): boolean {
    const tok = this.peek();
    return tok.type === 'punct' && tok.value === value;
  }

  private eatPunct(value: string): boolean {
    if (this.isPunct(value)) {
      this.pos++;
      return true;
    }
    return false;
  }

  private expectPunct(value: string): void {
    if (!this.eatPunct(value)) throw this.error(`Expected '${value}'`);
  }

  /** Identifier usable as a name (table, column, alias, CTE). */
  private parseName(): string {
    const tok = this.peek();
    if (tok.type === 'qident') {
      this.pos++;
      return tok.value;
    }
    if (tok.type === 'ident' && !RESERVED.has(tok.value)) {
      this.pos++;
      return tok.value;
    }
    throw this.error('Expected identifier');
  }

  /** Optional alias: AS name, or a bare non-reserved identifier. */
  private parseOptionalAlias(): string | null {
    if (this.eatKeyword('as')) return this.parseName();
    const tok = this.peek();
    if (tok.type === 'qident' || (tok.type === 'ident' && !RESERVED.has(tok.value))) {
      this.pos++;
      return tok.value;
    }
    return null;
  }

  parseStatements(): SelectStmt[] {
    const statements: SelectStmt[] = [];
    while (this.peek().type !== 'eof') {
      statements.push(this.parseSelect());
      if (!this.eatPunct(';')) break;
    }
    if (this.peek().type !== 'eof') throw this.error('Unexpected trailing input');
    return statements;
  }

  private parseSelect(): SelectStmt {
    const ctes: SelectStmt['ctes'] = [];
    if (this.eatKeyword('with')) {
      if (this.isKeyword('recursive')) throw this.error('Recursive CTEs are not supported');
      do {
        const name = this.parseName();
        this.expectKeyword('as');
        this.expectPunct('(');
        const query = this.parseSelect();
        this.expectPunct(')');
        ctes.push({ name, query });
      } while (this.eatPunct(','));
    }

    this.expectKeyword('select');
    const projections: SelectItem[] = [];
    do {
      projections.push(this.parseSelectItem());
    } while (this.eatPunct(','));

    this.expectKeyword('from');
    const from = this.parseFromSource();
    if (this.isPunct(',')) throw this.error('Multiple FROM sources are not supported');
    if (this.isKeyword('join') || this.isKeyword('inner') || this.isKeyword('left') ||
        this.isKeyword('right') || this.isKeyword('full') || this.isKeyword('cross')) {
      throw this.error('JOIN is not supported');
    }

    let where: Expr | null = null;
    if (this.eatKeyword('where')) where = this.parseOr();

    return { ctes, projections, from, where };
  }

  private parseSelectItem(): SelectItem {
    if (this.eatPunct('*')) return { kind: 'star' };
    const { table, name } = this.parseColumnRef();
    const alias = this.parseOptionalAlias();
    return { kind: 'column', table, name, alias };
  }

  private parseColumnRef(): { table: string | null; name: string } {
    const first = this.parseName();
    if (this.eatPunct('.')) {
      const second = this.parseName();
      return { table: first, name: second };
    }
    return { table: null, name: first };
  }

  private parseFromSource(): FromSource {
    if (this.eatPunct('(')) {
      const query = this.parseSelect();
      this.expectPunct(')');
      const alias = this.parseOptionalAlias();
      return { kind: 'subquery', query, alias };
    }
    const name = this.parseName();
    const alias = this.parseOptionalAlias();
    return { kind: 'table', name, alias };
  }

  private parseOr(): Expr {
    const items = [this.parseAnd()];
    while (this.eatKeyword('or')) items.push(this.parseAnd());
    return items.length === 1 ? items[0] : { kind: 'or', items };
  }

  private parseAnd(): Expr {
    const items = [this.parseUnary()];
    while (this.eatKeyword('and')) items.push(this.parseUnary());
    return items.length === 1 ? items[0] : { kind: 'and', items };
  }

  private parseUnary(): Expr {
    if (this.eatKeyword('not')) {
      if (!this.isKeyword('exists')) {
        throw this.error('Only NOT EXISTS is supported after NOT');
      }
      return this.parseExists(true);
    }
    return this.parsePredicate();
  }

  private parseExists(negated: boolean): Expr {
    this.expectKeyword('exists');
    this.expectPunct('(');
    const query = this.parseSelect();
    this.expectPunct(')');
    return { kind: 'exists', query, negated };
  }

  private parsePredicate(): Expr {
    if (this.isKeyword('exists')) return this.parseExists(false);
    if (this.eatPunct('(')) {
      const inner = this.parseOr();
      this.expectPunct(')');
      return inner;
    }

    const left = this.parseOperand();

    // IS [NOT] NULL
    if (this.eatKeyword('is')) {
      const negated = this.eatKeyword('not');
      this.expectKeyword('null');
      return { kind: 'isnull', value: left, negated };
    }

    // [NOT] BETWEEN / [NOT] IN
    let negated = false;
    if (this.isKeyword('not')) {
      const save = this.pos;
      this.pos++;
      if (this.isKeyword('between') || this.isKeyword('in')) {
        negated = true;
      } else {
        this.pos = save;
      }
    }
    if (this.eatKeyword('between')) {
      const low = this.parseOperand();
      this.expectKeyword('and');
      const high = this.parseOperand();
      return { kind: 'between', value: left, low, high, negated };
    }
    if (this.eatKeyword('in')) {
      this.expectPunct('(');
      const items: Expr[] = [];
      do {
        const item = this.parseOperand();
        if (item.kind !== 'literal') {
          throw this.error('IN lists may only contain constants');
        }
        items.push(item);
      } while (this.eatPunct(','));
      this.expectPunct(')');
      return { kind: 'in', value: left, items, negated };
    }
    if (negated) throw this.error('Expected BETWEEN or IN after NOT');

    // Comparison
    const tok = this.peek();
    if (tok.type === 'op') {
      this.pos++;
      const right = this.parseOperand();
      return { kind: 'compare', op: tok.value as CompareOp, left, right };
    }

    throw this.error('Expected a predicate');
  }

  private parseOperand(): Expr {
    const tok = this.peek();
    if (tok.type === 'number') {
      this.pos++;
      return { kind: 'literal', value: Number(tok.value) };
    }
    if (tok.type === 'string') {
      this.pos++;
      return { kind: 'literal', value: tok.value };
    }
    if (tok.type === 'ident') {
      if (tok.value === 'true' || tok.value === 'false') {
        this.pos++;
        return { kind: 'literal', value: tok.value === 'true' };
      }
      if (tok.value === 'null') {
        this.pos++;
        return { kind: 'literal', value: null };
      }
    }
    if (tok.type === 'ident' || tok.type === 'qident') {
      const { table, name } = this.parseColumnRef();
      return { kind: 'column', table, name };
    }
    throw this.error('Expected a column reference or literal');
  }
}

export function parseBatch(sql: string): SelectStmt[] {
  return new Parser(sql).parseStatements();
}
