/** Public API of the offline SQL index diagnoser. */

import { analyzeBatch } from './analyzer';
import { parseBatch } from './parser';
import {
  IndexDef,
  IndexReport,
  ReadInstanceReport,
  TableDef,
} from './types';

export { IndexDef, IndexReport, ReadInstanceReport, TableDef };

/**
 * Diagnose a batch of SELECT statements against the given table definitions.
 * Never executes anything; purely static analysis.
 */
export function diagnose(sql: string, tables: TableDef[]): ReadInstanceReport[] {
  return analyzeBatch(parseBatch(sql), tables);
}
