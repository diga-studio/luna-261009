/**
 * Shared type definitions for the SQL index diagnoser.
 */

/** A B-tree index over plain columns, in key order. */
export interface IndexDef {
  name: string;
  columns: string[];
}

/** A base table known to the hosting platform. */
export interface TableDef {
  name: string;
  columns: string[];
  indexes: IndexDef[];
}

/** Literal values allowed on the non-column side of a comparison. */
export type LiteralValue = string | number | boolean | null;

export type CompareOp = '=' | '<' | '>' | '<=' | '>=' | '<>' | '!=';

export type Expr =
  | { kind: 'column'; table: string | null; name: string }
  | { kind: 'literal'; value: LiteralValue }
  | { kind: 'and'; items: Expr[] }
  | { kind: 'or'; items: Expr[] }
  | { kind: 'compare'; op: CompareOp; left: Expr; right: Expr }
  | { kind: 'between'; value: Expr; low: Expr; high: Expr; negated: boolean }
  | { kind: 'in'; value: Expr; items: Expr[]; negated: boolean }
  | { kind: 'isnull'; value: Expr; negated: boolean }
  | { kind: 'exists'; query: SelectStmt; negated: boolean };

export type SelectItem =
  | { kind: 'column'; table: string | null; name: string; alias: string | null }
  | { kind: 'star' };

export type FromSource =
  | { kind: 'table'; name: string; alias: string | null }
  | { kind: 'subquery'; query: SelectStmt; alias: string | null };

export interface CteDef {
  name: string;
  query: SelectStmt;
}

export interface SelectStmt {
  ctes: CteDef[];
  projections: SelectItem[];
  from: FromSource;
  where: Expr | null;
}

/** Per-index diagnostic for one read instance. */
export interface IndexReport {
  index: string;
  columns: string[];
  /** Guaranteed usable leftmost prefix length across all OR branches. */
  guaranteedPrefix: number;
}

/** Diagnostic for one base-table read instance. */
export interface ReadInstanceReport {
  /** Base table being read. */
  table: string;
  /** Alias of the innermost source, when present. */
  alias: string | null;
  /** Human-readable location, e.g. "stmt1 > cte c1 > users u". */
  source: string;
  indexes: IndexReport[];
  /** True when some logical branch can use no index prefix at all. */
  hasFullScanBranch: boolean;
}
