/** 一条待索引的消息。 */
export interface Message {
  id: string;
  text: string;
}

/** 一条同义规则，由两段文本组成，双向生效。 */
export interface SynonymPair {
  left: string;
  right: string;
}

/** 构建完成后的不可变索引。 */
export interface PhraseIndex {
  readonly messages: ReadonlyArray<IndexedMessage>;
  readonly rules: ReadonlyArray<TokenSequence[]>;
}

/** 索引内部的消息表示。 */
export interface IndexedMessage {
  readonly id: string;
  readonly tokens: ReadonlyArray<string>;
}

/** token 序列。 */
export type TokenSequence = ReadonlyArray<string>;
