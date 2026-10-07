import { parse } from "./parser.js";
import { analyze } from "./analyzer.js";
import type { DiagnosticReport, TableSchema } from "./types.js";

export * from "./types.js";

/** 对一批 SQL（分号分隔或单条）做离线索引诊断 */
export function diagnose(sql: string, schemas: TableSchema[]): DiagnosticReport {
  const ast = parse(sql);
  return analyze(ast, schemas);
}
