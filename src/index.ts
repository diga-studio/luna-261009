import { Store } from "./store.js";
import { Importer } from "./importer.js";
import type { EntityResult } from "./types.js";

export * from "./types.js";
export { Importer } from "./importer.js";

/** Public entry point: a STEP index backed by a SQLite file. */
export class StepIndex {
  private constructor(private readonly store: Store) {}

  static open(path: string): StepIndex {
    return new StepIndex(new Store(path));
  }

  /** Begin an import. On failure the previous index content is preserved. */
  beginImport(): Importer {
    return new Importer(this.store);
  }

  getEntity(id: string | number | bigint): EntityResult | null {
    return this.store.getEntity(String(id));
  }

  entityCount(): number {
    return this.store.entityCount();
  }

  close(): void {
    this.store.close();
  }
}
