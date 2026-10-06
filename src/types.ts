export interface Message {
  id: string;
  text: string;
}

export interface SynonymPair {
  left: string;
  right: string;
}

export interface RewriteRule {
  from: readonly string[];
  to: readonly string[];
}

export interface IndexedMessage {
  id: string;
  tokens: readonly string[];
}

export interface PhraseIndex {
  readonly messages: readonly IndexedMessage[];
  readonly rules: readonly RewriteRule[];
}
