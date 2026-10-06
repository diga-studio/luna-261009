import { Lexer } from "./lexer.js";
import { NeedMoreData, Parser } from "./parser.js";
import type { Store } from "./store.js";
import { StepParseError } from "./types.js";

/**
 * Feeds byte chunks through lexer+parser into the store.
 * The whole import runs in one transaction; any failure rolls back,
 * leaving the previous index content intact.
 */
export class Importer {
  private readonly lexer = new Lexer();
  private readonly parser: Parser;
  private state: "active" | "done" | "failed" = "active";

  constructor(private readonly store: Store) {
    this.parser = new Parser(this.lexer);
    this.store.begin();
  }

  write(chunk: Uint8Array): void {
    this.ensureActive();
    try {
      this.lexer.write(chunk);
      this.drain();
    } catch (e) {
      this.abort();
      throw e;
    }
  }

  finish(): void {
    this.ensureActive();
    try {
      this.lexer.end();
      this.drain();
      if (!this.parser.done) {
        throw new StepParseError("input ended before END-ISO-10303-21;");
      }
      this.store.validateRefs();
      this.store.commit();
      this.state = "done";
    } catch (e) {
      this.abort();
      throw e;
    }
  }

  private drain(): void {
    while (!this.parser.done) {
      this.lexer.mark();
      let rec;
      try {
        rec = this.parser.step();
      } catch (e) {
        if (e instanceof NeedMoreData) {
          this.lexer.rollback();
          return;
        }
        throw e;
      }
      this.lexer.commit();
      if (rec !== null) {
        this.store.insertEntity(rec, this.parser.takeRefs());
      }
    }
  }

  private ensureActive(): void {
    if (this.state === "done") throw new StepParseError("import already finished");
    if (this.state === "failed") throw new StepParseError("import already failed");
  }

  private abort(): void {
    this.state = "failed";
    try {
      this.store.rollback();
    } catch {
      // ignore rollback errors
    }
  }
}
