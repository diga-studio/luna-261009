import { tokenize } from "./tokenize";
import { Message, PhraseIndex, SynonymPair, TokenSequence } from "./types";

export { Message, PhraseIndex, SynonymPair } from "./types";
export { tokenize } from "./tokenize";

const MIN_RULE_SIDE_TOKENS = 1;
const MAX_RULE_SIDE_TOKENS = 3;

/** 构建索引。索引构建后不变。 */
export function buildIndex(
  messages: Message[],
  synonymPairs: SynonymPair[]
): PhraseIndex {
  const indexedMessages = messages.map((message) =>
    Object.freeze({
      id: message.id,
      tokens: Object.freeze(tokenize(message.text)) as TokenSequence,
    })
  );

  const rules = synonymPairs.map((pair, ruleIndex) => {
    const left = Object.freeze(tokenize(pair.left)) as TokenSequence;
    const right = Object.freeze(tokenize(pair.right)) as TokenSequence;
    for (const [sideName, side] of [
      ["left", left],
      ["right", right],
    ] as const) {
      if (
        side.length < MIN_RULE_SIDE_TOKENS ||
        side.length > MAX_RULE_SIDE_TOKENS
      ) {
        throw new Error(
          `synonym rule ${ruleIndex} ${sideName} side must contain ` +
            `${MIN_RULE_SIDE_TOKENS}-${MAX_RULE_SIDE_TOKENS} tokens, got ${side.length}`
        );
      }
    }
    return Object.freeze([left, right]) as TokenSequence[];
  });

  return Object.freeze({
    messages: Object.freeze(indexedMessages),
    rules: Object.freeze(rules),
  });
}

/**
 * 状态：输出序列当前末尾能匹配上的查询前缀长度集合。
 * 始终包含 0（表示可以从当前位置重新开始匹配）。
 */
type MatchState = ReadonlySet<number>;

function serializeState(state: MatchState): string {
  return [...state].sort((a, b) => a - b).join(",");
}

/**
 * 向输出序列追加一个 token，返回新的匹配状态；
 * 若查询因此完整出现，返回 null 作为命中信号。
 */
function advance(
  state: MatchState,
  token: string,
  query: TokenSequence
): MatchState | null {
  const next = new Set<number>([0]);
  for (const matched of state) {
    if (matched < query.length && query[matched] === token) {
      const extended = matched + 1;
      if (extended === query.length) {
        return null;
      }
      next.add(extended);
    }
  }
  return next;
}

/** 判断查询是否在消息的至少一种合法改写中连续出现。 */
function matchesMessage(
  tokens: TokenSequence,
  rules: ReadonlyArray<TokenSequence[]>,
  query: TokenSequence
): boolean {
  // reachable[i]：消费完前 i 个原始 token 后所有可达的匹配状态。
  const reachable: Array<Map<string, MatchState>> = Array.from(
    { length: tokens.length + 1 },
    () => new Map()
  );
  const initial: MatchState = new Set([0]);
  reachable[0].set(serializeState(initial), initial);

  const appendSegment = (
    state: MatchState,
    segment: TokenSequence
  ): MatchState | null => {
    let current: MatchState | null = state;
    for (const token of segment) {
      current = advance(current, token, query);
      if (current === null) {
        return null;
      }
    }
    return current;
  };

  for (let i = 0; i < tokens.length; i++) {
    for (const state of reachable[i].values()) {
      // 保留原 token。
      const kept = appendSegment(state, [tokens[i]]);
      if (kept === null) {
        return true;
      }
      reachable[i + 1].set(serializeState(kept), kept);

      // 应用一条规则：某一侧匹配原序列区间，整体替换为另一侧。
      for (const [left, right] of rules) {
        for (const [from, to] of [
          [left, right],
          [right, left],
        ] as const) {
          if (i + from.length > tokens.length) {
            continue;
          }
          let equal = true;
          for (let k = 0; k < from.length; k++) {
            if (tokens[i + k] !== from[k]) {
              equal = false;
              break;
            }
          }
          if (!equal) {
            continue;
          }
          const replaced = appendSegment(state, to);
          if (replaced === null) {
            return true;
          }
          reachable[i + from.length].set(
            serializeState(replaced),
            replaced
          );
        }
      }
    }
  }
  return false;
}

/**
 * 在索引中检索命中 phrase 的消息 id。
 * 查询自身不扩展；空 token 查询不命中任何消息。
 */
export function search(index: PhraseIndex, phrase: string): string[] {
  const query = tokenize(phrase);
  if (query.length === 0) {
    return [];
  }
  const hits: string[] = [];
  for (const message of index.messages) {
    if (matchesMessage(message.tokens, index.rules, query)) {
      hits.push(message.id);
    }
  }
  return hits;
}
