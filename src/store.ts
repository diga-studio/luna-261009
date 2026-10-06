import * as fs from "fs";
import * as path from "path";
import { PreparedData, PREPARED_VERSION, STAGE_COUNT, StageData } from "./types";

interface Manifest {
  version: number;
  customerCount: number;
  journeyCount: number;
  eventCount: number;
  stages: { n: number }[];
}

function writeArray(file: string, arr: Float64Array | Uint32Array): void {
  const buf = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
  fs.writeFileSync(file, buf);
}

function readF64(file: string, n: number): Float64Array {
  const buf = fs.readFileSync(file);
  if (buf.byteLength !== n * 8) {
    throw new Error(`corrupt file ${file}: expected ${n * 8} bytes, got ${buf.byteLength}`);
  }
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  return new Float64Array(ab);
}

function readU32(file: string, n: number): Uint32Array {
  const buf = fs.readFileSync(file);
  if (buf.byteLength !== n * 4) {
    throw new Error(`corrupt file ${file}: expected ${n * 4} bytes, got ${buf.byteLength}`);
  }
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  return new Uint32Array(ab);
}

/** Persist prepared data into `dir` (created if missing). */
export function savePrepared(dir: string, data: PreparedData): void {
  fs.mkdirSync(dir, { recursive: true });
  const manifest: Manifest = {
    version: PREPARED_VERSION,
    customerCount: data.customerCount,
    journeyCount: data.journeyCount,
    eventCount: data.eventCount,
    stages: data.stages.map((s) => ({ n: s.n })),
  };
  for (let k = 0; k < STAGE_COUNT; k++) {
    const s = data.stages[k];
    const prefix = path.join(dir, `stage${k}`);
    writeArray(`${prefix}.starts.f64`, s.starts);
    writeArray(`${prefix}.ends.f64`, s.ends);
    writeArray(`${prefix}.cust.u32`, s.cust);
    writeArray(`${prefix}.endsSorted.f64`, s.endsSorted);
    writeArray(`${prefix}.startsByEnd.f64`, s.startsByEnd);
    writeArray(`${prefix}.custByEnd.u32`, s.custByEnd);
  }
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
}

/** Load prepared data previously saved with savePrepared. */
export function loadPrepared(dir: string): PreparedData {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(dir, "manifest.json"), "utf8")
  ) as Manifest;
  if (manifest.version !== PREPARED_VERSION) {
    throw new Error(`unsupported prepared version ${manifest.version}`);
  }
  const stages: StageData[] = [];
  for (let k = 0; k < STAGE_COUNT; k++) {
    const n = manifest.stages[k].n;
    const prefix = path.join(dir, `stage${k}`);
    stages.push({
      n,
      starts: readF64(`${prefix}.starts.f64`, n),
      ends: readF64(`${prefix}.ends.f64`, n),
      cust: readU32(`${prefix}.cust.u32`, n),
      endsSorted: readF64(`${prefix}.endsSorted.f64`, n),
      startsByEnd: readF64(`${prefix}.startsByEnd.f64`, n),
      custByEnd: readU32(`${prefix}.custByEnd.u32`, n),
    });
  }
  return {
    version: manifest.version,
    customerCount: manifest.customerCount,
    journeyCount: manifest.journeyCount,
    eventCount: manifest.eventCount,
    stages,
  };
}
