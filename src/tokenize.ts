/**
 * 将文本统一转小写，并提取连续 ASCII 字母或数字作为 token，
 * 其他字符仅作为分隔符。
 */
export function tokenize(text: string): string[] {
  const lowered = text.toLowerCase();
  const tokens: string[] = [];
  let current = "";
  for (const ch of lowered) {
    const code = ch.codePointAt(0)!;
    const isAsciiAlnum =
      (code >= 0x30 && code <= 0x39) || // 0-9
      (code >= 0x61 && code <= 0x7a); // a-z
    if (isAsciiAlnum) {
      current += ch;
    } else if (current.length > 0) {
      tokens.push(current);
      current = "";
    }
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}
