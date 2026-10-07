/** 表结构：列名 + B-tree 索引（有序列清单，仅普通列索引） */
export interface TableSchema {
  name: string;
  columns: string[];
  indexes: string[][];
}

/** 诊断报告：按基础表读取实例逐条给出 */
export interface ReadInstanceReport {
  /** 基础表名 */
  table: string;
  /** 读取实例路径描述（便于区分同表不同实例） */
  path: string;
  /** 每个索引的保证可用前缀长度 */
  indexes: IndexReport[];
  /** 是否存在必须全扫的逻辑分支 */
  hasFullScanBranch: boolean;
}

export interface IndexReport {
  columns: string[];
  guaranteedPrefix: number;
}

export interface DiagnosticReport {
  instances: ReadInstanceReport[];
}

/* ---------- SQL AST ---------- */

export interface SelectStatement {
  ctes: CteDef[];
  body: QueryBlock;
}

export interface CteDef {
  name: string;
  query: SelectStatement;
}

export interface QueryBlock {
  projection: ProjectionItem[];
  source: DataSource;
  where: Condition | null;
}

export type ProjectionItem =
  | { kind: "star" }
  | { kind: "column"; column: ColumnRef; alias: string | null }
  | { kind: "literal" };

export interface ColumnRef {
  /** 限定名（表/别名），可为空 */
  qualifier: string | null;
  name: string;
}

export type DataSource =
  | { kind: "table"; name: string; alias: string | null }
  | { kind: "subquery"; query: SelectStatement; alias: string | null };

export type Condition =
  | { kind: "and"; items: Condition[] }
  | { kind: "or"; items: Condition[] }
  | { kind: "comparison"; left: Operand; op: CompareOp; right: Operand }
  | { kind: "between"; operand: Operand; low: Operand; high: Operand }
  | { kind: "in"; operand: Operand; values: Operand[] }
  | { kind: "isNull"; operand: Operand }
  | { kind: "exists"; query: SelectStatement }
  | { kind: "unsupported" };

export type CompareOp = "=" | "<>" | "!=" | "<" | "<=" | ">" | ">=";

export type Operand =
  | { kind: "column"; column: ColumnRef }
  | { kind: "literal" };
