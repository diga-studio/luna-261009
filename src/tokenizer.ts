export type TokenKind = "ident" | "qident" | "number" | "string" | "symbol" | "eof";

export interface Token {
  kind: TokenKind;
  /** ident：未加引号，已转小写；qident：双引号包裹，保留大小写 */
  text: string;
}

const SYMBOLS = ["(", ")", ",", ".", "*", ";", "=", "<>", "!=", "<=", ">=", "<", ">"];

export function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const c = sql[i];

    // 空白
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v") {
      i++;
      continue;
    }
    // 行注释
    if (c === "-" && sql[i + 1] === "-") {
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }
    // 块注释
    if (c === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    // 双引号标识符（区分大小写，"" 为转义）
    if (c === '"') {
      let j = i + 1;
      let text = "";
      while (j < n) {
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') {
            text += '"';
            j += 2;
          } else {
            break;
          }
        } else {
          text += sql[j];
          j++;
        }
      }
      tokens.push({ kind: "qident", text });
      i = j + 1;
      continue;
    }
    // 字符串字面量（'' 为转义）；其中的关键词不参与结构判断
    if (c === "'") {
      let j = i + 1;
      let text = "";
      while (j < n) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            text += "'";
            j += 2;
          } else {
            break;
          }
        } else {
          text += sql[j];
          j++;
        }
      }
      tokens.push({ kind: "string", text });
      i = j + 1;
      continue;
    }
    // 数字
    if ((c >= "0" && c <= "9") || (c === "." && sql[i + 1] >= "0" && sql[i + 1] <= "9")) {
      let j = i;
      while (j < n && /[0-9._eE+-]/.test(sql[j]) && sql[j] !== ";") {
        // 简化：数字主体
        if (/[0-9.]/.test(sql[j])) {
          j++;
        } else {
          break;
        }
      }
      tokens.push({ kind: "number", text: sql.slice(i, j) });
      i = j;
      continue;
    }
    // 普通标识符 / 关键字（小写化）
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$]/.test(sql[j])) j++;
      tokens.push({ kind: "ident", text: sql.slice(i, j).toLowerCase() });
      i = j;
      continue;
    }
    // 符号（先双字符）
    const two = sql.slice(i, i + 2);
    if (SYMBOLS.includes(two)) {
      tokens.push({ kind: "symbol", text: two });
      i += 2;
      continue;
    }
    if (SYMBOLS.includes(c)) {
      tokens.push({ kind: "symbol", text: c });
      i++;
      continue;
    }
    throw new Error(`tokenizer: unexpected character ${JSON.stringify(c)} at ${i}`);
  }

  tokens.push({ kind: "eof", text: "" });
  return tokens;
}
