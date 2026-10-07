/** 调用方提交的单个知识块：原文 + 已归一化词项序列（保留重复）。 */
export interface ChunkInput {
  text: string;
  terms: string[];
}

/** 检索命中结果。 */
export interface SearchHit {
  kbId: string;
  docId: string;
  versionId: number;
  /** 块在版本内的序号，从 0 开始。 */
  seq: number;
  text: string;
  score: number;
}
