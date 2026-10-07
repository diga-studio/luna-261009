/** Lexer: turns SQL text into tokens. String contents never become keywords. */

export type TokenType =
  | 'ident' // unquoted identifier, already lowercased
  | 'qident' // double-quoted identifier, case preserved
  | 'number'
  | 'string'
  | 'punct' // ( ) , ; . *
  | 'op' // = < > <= >= <> !=
  | 'eof';

export interface Token {
  type: TokenType;
  value: string;
  pos: number;
}

function isIdentStart(ch: string): boolean {
  return /[A-Za-z_]/.test(ch);
}

function isIdentPart(ch: string): boolean {
  return /[A-Za-z0-9_$]/.test(ch);
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

export function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i];

    // Whitespace
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n' || ch === '\f') {
      i++;
      continue;
    }

    // Line comment
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }

    // Block comment
    if (ch === '/' && sql[i + 1] === '*') {
      const start = i;
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      if (i >= sql.length) throw new Error(`Unterminated block comment at ${start}`);
      i += 2;
      continue;
    }

    // String literal ('' is an escaped quote); content is opaque to the parser
    if (ch === "'") {
      const start = i;
      i++;
      let value = '';
      for (;;) {
        if (i >= sql.length) throw new Error(`Unterminated string at ${start}`);
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            value += "'";
            i += 2;
          } else {
            i++;
            break;
          }
        } else {
          value += sql[i];
          i++;
        }
      }
      tokens.push({ type: 'string', value, pos: start });
      continue;
    }

    // Quoted identifier ("" is an escaped quote); case preserved
    if (ch === '"') {
      const start = i;
      i++;
      let value = '';
      for (;;) {
        if (i >= sql.length) throw new Error(`Unterminated quoted identifier at ${start}`);
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            value += '"';
            i += 2;
          } else {
            i++;
            break;
          }
        } else {
          value += sql[i];
          i++;
        }
      }
      tokens.push({ type: 'qident', value, pos: start });
      continue;
    }

    // Number literal
    if (isDigit(ch) || (ch === '.' && isDigit(sql[i + 1] ?? ''))) {
      const start = i;
      while (i < sql.length && isDigit(sql[i])) i++;
      if (sql[i] === '.') {
        i++;
        while (i < sql.length && isDigit(sql[i])) i++;
      }
      tokens.push({ type: 'number', value: sql.slice(start, i), pos: start });
      continue;
    }

    // Unquoted identifier: folded to lowercase
    if (isIdentStart(ch)) {
      const start = i;
      while (i < sql.length && isIdentPart(sql[i])) i++;
      tokens.push({ type: 'ident', value: sql.slice(start, i).toLowerCase(), pos: start });
      continue;
    }

    // Two-character operators
    const two = sql.slice(i, i + 2);
    if (two === '<=' || two === '>=' || two === '<>' || two === '!=') {
      tokens.push({ type: 'op', value: two, pos: i });
      i += 2;
      continue;
    }

    // Single-character operators
    if (ch === '=' || ch === '<' || ch === '>') {
      tokens.push({ type: 'op', value: ch, pos: i });
      i++;
      continue;
    }

    // Punctuation
    if (ch === '(' || ch === ')' || ch === ',' || ch === ';' || ch === '.' || ch === '*') {
      tokens.push({ type: 'punct', value: ch, pos: i });
      i++;
      continue;
    }

    throw new Error(`Unexpected character ${JSON.stringify(ch)} at ${i}`);
  }

  tokens.push({ type: 'eof', value: '', pos: sql.length });
  return tokens;
}
