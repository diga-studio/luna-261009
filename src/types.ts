/** AST node types for parsed STEP parameters. */

export type Param =
  | ListParam
  | TypedParam
  | RefParam
  | StringParam
  | EnumParam
  | NumberParam
  | UnsetParam
  | DerivedParam;

export interface ListParam {
  readonly t: "list";
  readonly items: readonly Param[];
}

export interface TypedParam {
  readonly t: "typed";
  readonly name: string;
  readonly items: readonly Param[];
}

export interface RefParam {
  readonly t: "ref";
  /** Entity id as decimal string (may exceed 2^53). */
  readonly id: string;
}

export interface StringParam {
  readonly t: "str";
  readonly v: string;
}

export interface EnumParam {
  readonly t: "enum";
  readonly v: string;
}

export interface NumberParam {
  readonly t: "num";
  /** Original source text of the number, preserved verbatim. */
  readonly raw: string;
}

/** `$` placeholder. */
export interface UnsetParam {
  readonly t: "unset";
}

/** `*` placeholder. */
export interface DerivedParam {
  readonly t: "derived";
}

export interface EntityComponent {
  readonly name: string;
  readonly params: readonly Param[];
}

export interface EntityRecord {
  readonly id: string;
  readonly complex: boolean;
  readonly components: readonly EntityComponent[];
}

export interface EntityResult extends EntityRecord {
  /** Deduped direct forward reference ids (this entity -> others). */
  readonly forwardRefs: readonly string[];
  /** Deduped direct backward reference ids (others -> this entity). */
  readonly backwardRefs: readonly string[];
}

export class StepParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StepParseError";
  }
}
