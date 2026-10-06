import * as fs from "fs";
import { ColumnarEvents } from "./types";

const MAGIC = "JFRAW001";
const HEADER_BYTES = 16;
const RECORD_BYTES = 24;

/**
 * Simple binary raw-event file format (little endian):
 *   16-byte header: magic "JFRAW001", u32 recordCount, u32 reserved
 *   then per record (24 bytes): f64 time, u32 customer, u32 journey, u32 seq, u8 action, 3 pad
 */
export function writeRawEventsFile(path: string, events: ColumnarEvents): void {
  const n = events.count;
  const buf = Buffer.alloc(HEADER_BYTES + n * RECORD_BYTES);
  buf.write(MAGIC, 0, "ascii");
  buf.writeUInt32LE(n, 8);
  buf.writeUInt32LE(0, 12);
  let off = HEADER_BYTES;
  for (let i = 0; i < n; i++) {
    buf.writeDoubleLE(events.time[i], off);
    buf.writeUInt32LE(events.customer[i], off + 8);
    buf.writeUInt32LE(events.journey[i], off + 12);
    buf.writeUInt32LE(events.seq[i], off + 16);
    buf.writeUInt8(events.action[i], off + 20);
    off += RECORD_BYTES;
  }
  fs.writeFileSync(path, buf);
}

export function readRawEventsFile(path: string): ColumnarEvents {
  const buf = fs.readFileSync(path);
  if (buf.length < HEADER_BYTES || buf.toString("ascii", 0, 8) !== MAGIC) {
    throw new Error(`not a raw events file: ${path}`);
  }
  const n = buf.readUInt32LE(8);
  if (buf.length !== HEADER_BYTES + n * RECORD_BYTES) {
    throw new Error(`corrupt raw events file: ${path}`);
  }
  const time = new Float64Array(n);
  const customer = new Uint32Array(n);
  const journey = new Uint32Array(n);
  const seq = new Uint32Array(n);
  const action = new Uint8Array(n);
  let maxCustomer = 0;
  let maxJourney = 0;
  let off = HEADER_BYTES;
  for (let i = 0; i < n; i++) {
    time[i] = buf.readDoubleLE(off);
    const c = buf.readUInt32LE(off + 8);
    const j = buf.readUInt32LE(off + 12);
    customer[i] = c;
    journey[i] = j;
    seq[i] = buf.readUInt32LE(off + 16);
    action[i] = buf.readUInt8(off + 20);
    if (c > maxCustomer) maxCustomer = c;
    if (j > maxJourney) maxJourney = j;
    off += RECORD_BYTES;
  }
  return {
    count: n,
    customerCount: maxCustomer + 1,
    journeyCount: maxJourney + 1,
    customer,
    journey,
    action,
    time,
    seq,
  };
}
