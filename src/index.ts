import type { PaperResult, WordEntry } from "./types.js";
import { assemblePaper, QUESTIONS_PER_PAPER } from "./assemble.js";

export type { PaperFailure, PaperResult, PaperSuccess, QuizQuestion, WordEntry } from "./types.js";
export { QUESTIONS_PER_PAPER } from "./assemble.js";

/** 企业词汇测验组卷库：载入单个语种的词库，为指定题干生成试卷。数据保存在内存中。 */
export class QuizPaperLibrary {
  private bank: WordEntry[] = [];

  /** 载入（替换）当前语种的词库。词条需具有稳定且不重复的标识、1 至 5 的难度。 */
  loadWordBank(entries: readonly WordEntry[]): void {
    const seen = new Set<string>();
    for (const entry of entries) {
      if (seen.has(entry.id)) {
        throw new Error(`词条标识重复: ${entry.id}`);
      }
      seen.add(entry.id);
      if (!Number.isInteger(entry.difficulty) || entry.difficulty < 1 || entry.difficulty > 5) {
        throw new Error(`词条 ${entry.id} 的难度超出 1 至 5: ${entry.difficulty}`);
      }
    }
    this.bank = [...entries];
  }

  /**
   * 为 20 个指定题干生成试卷。
   * stemIds 为词库中词条的稳定标识，必须恰好 20 个、互不相同且都存在于词库中。
   * 输入非法时抛错；仅在整卷确实不存在合法分配时返回 { ok: false }。
   */
  generatePaper(stemIds: readonly string[]): PaperResult {
    if (stemIds.length !== QUESTIONS_PER_PAPER) {
      throw new Error(`题干数量必须为 ${QUESTIONS_PER_PAPER}，实际为 ${stemIds.length}`);
    }
    if (new Set(stemIds).size !== stemIds.length) {
      throw new Error("题干标识存在重复");
    }
    const byId = new Map(this.bank.map((entry) => [entry.id, entry]));
    const stems = stemIds.map((id) => {
      const entry = byId.get(id);
      if (!entry) {
        throw new Error(`题干标识不在词库中: ${id}`);
      }
      return entry;
    });
    return assemblePaper(this.bank, stems);
  }
}
