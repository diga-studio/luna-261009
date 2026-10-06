import { tokenize } from "./tokenize.js";
import type {
  IndexedMessage,
  Message,
  PhraseIndex,
  RewriteRule,
  SynonymPair,
} from "./types.js";

export type { Message, PhraseIndex, SynonymPair } from "./types.js";

const MIN_SIDE_TOKENS = 1;
const MAX_SIDE_TOKENS = 3;

function buildRules(synonymPairs: readonly SynonymPair[]): RewriteRule[] {
  const rules: RewriteRule[] = [];
  for (const pair of synonymPairs) {
    const left = tokenize(pair.left);
    const right = tokenize(pair.right);
    for (const [side, raw] of [
      [left, pair.left],
      [right, pair.right],
    ] as const) {
      if (side.length < MIN_SIDE_TOKENS || side.length > MAX_SIDE_TOKENS) {
        throw new RangeError(
          `synonym side must have 1-3 tokens, got ${side.length}: ${JSON.stringify(raw)}`,
        );
      }
    }
    rules.push({ from: Object.freeze(left), to: Object.freeze(right) });
    if (left.join("") !== right.join("") || left.length !== right.length) {
      rules.push({ from: Object.freeze(right), to: Object.freeze(left) });
    }
  }
  return rules;
}

export function buildIndex(
  messages: readonly Message[],
  synonymPairs: readonly SynonymPair[],
): PhraseIndex {
  const indexed: IndexedMessage[] = messages.map((message) => ({
    id: message.id,
    tokens: Object.freeze(tokenize(message.text)),
  }));
  return Object.freeze({
    messages: Object.freeze(indexed),
    rules: Object.freeze(buildRules(synonymPairs)),
  });
}

function collectRewrites(
  tokens: readonly string[],
  rules: readonly RewriteRule[],
): string[][] {
  const results: string[][] = [];
  const seen = new Set<string>();
  const walk = (pos: number, acc: string[]): void => {
    if (pos >= tokens.length) {
      const key = acc.join("");
      if (!seen.has(key)) {
        seen.add(key);
        results.push([...acc]);
      }
      return;
    }
    walk(pos + 1, [...acc, tokens[pos]]);
    for (const rule of rules) {
      const end = pos + rule.from.length;
      if (end > tokens.length) continue;
      let matches = true;
      for (let k = 0; k < rule.from.length; k++) {
        if (tokens[pos + k] !== rule.from[k]) {
          matches = false;
          break;
        }
      }
      if (matches) walk(end, [...acc, ...rule.to]);
    }
  };
  walk(0, []);
  return results;
}

function containsContiguous(haystack: readonly string[], needle: readonly string[]): boolean {
  if (needle.length > haystack.length) return false;
  outer: for (let start = 0; start + needle.length <= haystack.length; start++) {
    for (let k = 0; k < needle.length; k++) {
      if (haystack[start + k] !== needle[k]) continue outer;
    }
    return true;
  }
  return false;
}

export function search(index: PhraseIndex, phrase: string): string[] {
  const query = tokenize(phrase);
  if (query.length === 0) return [];
  const hits: string[] = [];
  for (const message of index.messages) {
    const variants = collectRewrites(message.tokens, index.rules);
    if (variants.some((variant) => containsContiguous(variant, query))) {
      hits.push(message.id);
    }
  }
  return hits;
}
