import * as fs from "fs";
import { openFunnel } from "./index";
import { StageCounts } from "./types";

/**
 * CLI helper: open a prepared directory in a fresh process, run queries from a
 * JSON file ([[start, end], ...]) and write JSON results to a file.
 * Usage: node reopen-cli.js <preparedDir> <queries.json> <out.json>
 */
export function main(argv: string[]): void {
  const [dir, queriesFile, outFile] = argv;
  if (!dir || !queriesFile || !outFile) {
    throw new Error("usage: reopen-cli <preparedDir> <queries.json> <out.json>");
  }
  const queries = JSON.parse(fs.readFileSync(queriesFile, "utf8")) as [number, number][];
  const db = openFunnel(dir);
  const results: StageCounts[] = [];
  for (const [s, e] of queries) {
    results.push(db.query(s, e));
  }
  db.close();
  fs.writeFileSync(outFile, JSON.stringify(results));
}

if (require.main === module) {
  main(process.argv.slice(2));
}
