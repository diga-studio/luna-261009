const TOKEN_PATTERN = /[a-z0-9]+/g;

export function tokenize(text: string): string[] {
  return text.toLowerCase().match(TOKEN_PATTERN) ?? [];
}
