import * as fs from "fs";
import { PreparedFunnel, StageIndex } from "./prepare";
import { FunnelAnalyzer } from "./analyzer";
import { STAGE_COUNT } from "./types";

const MAGIC = "JFUNNEL1";

interface SectionMeta {
  offset: number;
  length: number; // 元素个数
}

interface FileHeader {
  version: number;
  timeBits: number;
  times: SectionMeta;
  stages: { ax: SectionMeta; ay: SectionMeta; bx: SectionMeta; by: SectionMeta }[];
}

function align8(v: number): number {
  return (v + 7) & ~7;
}

/** 把准备结果保存到本地文件。 */
export function save(prepared: PreparedFunnel, path: string): void {
  // 先计算布局：文件头（magic + 头长度 + JSON 头）之后按 8 字节对齐排布各段
  const header: FileHeader = {
    version: 1,
    timeBits: prepared.timeBits,
    times: { offset: 0, length: prepared.times.length },
    stages: [],
  };
  for (let s = 0; s < STAGE_COUNT; s++) {
    const st = prepared.stages[s];
    header.stages.push({
      ax: { offset: 0, length: st.ax.length },
      ay: { offset: 0, length: st.ay.length },
      bx: { offset: 0, length: st.bx.length },
      by: { offset: 0, length: st.by.length },
    });
  }

  // 头长度依赖于偏移量，偏移量依赖于头长度：迭代至收敛
  let headerBytes = Buffer.from(JSON.stringify(header), "utf8");
  for (let iter = 0; iter < 10; iter++) {
    const prevLen = headerBytes.length;
    let offset = align8(8 + 4 + headerBytes.length);
    header.times.offset = offset;
    offset += prepared.times.length * 8;
    for (let s = 0; s < STAGE_COUNT; s++) {
      const st = prepared.stages[s];
      const meta = header.stages[s];
      meta.ax.offset = offset;
      offset += st.ax.length * 4;
      meta.ay.offset = offset;
      offset += st.ay.length * 4;
      meta.bx.offset = offset;
      offset += st.bx.length * 4;
      meta.by.offset = offset;
      offset += st.by.length * 4;
    }
    headerBytes = Buffer.from(JSON.stringify(header), "utf8");
    if (headerBytes.length === prevLen && iter > 0) break;
  }

  const fd = fs.openSync(path, "w");
  try {
    const prefix = Buffer.alloc(align8(8 + 4 + headerBytes.length));
    prefix.write(MAGIC, 0, "ascii");
    prefix.writeUInt32LE(headerBytes.length, 8);
    headerBytes.copy(prefix, 12);
    fs.writeSync(fd, prefix);

    fs.writeSync(fd, Buffer.from(prepared.times.buffer, prepared.times.byteOffset, prepared.times.length * 8));
    for (let s = 0; s < STAGE_COUNT; s++) {
      const st = prepared.stages[s];
      fs.writeSync(fd, Buffer.from(st.ax.buffer, st.ax.byteOffset, st.ax.length * 4));
      fs.writeSync(fd, Buffer.from(st.ay.buffer, st.ay.byteOffset, st.ay.length * 4));
      fs.writeSync(fd, Buffer.from(st.bx.buffer, st.bx.byteOffset, st.bx.length * 4));
      fs.writeSync(fd, Buffer.from(st.by.buffer, st.by.byteOffset, st.by.length * 4));
    }
  } finally {
    fs.closeSync(fd);
  }
}

function readSection(fd: number, meta: SectionMeta, bytesPerElement: number): ArrayBuffer {
  const buf = new ArrayBuffer(meta.length * bytesPerElement);
  const view = new Uint8Array(buf);
  let read = 0;
  while (read < view.length) {
    const got = fs.readSync(fd, view, read, view.length - read, meta.offset + read);
    if (got <= 0) throw new Error("unexpected end of funnel file");
    read += got;
  }
  return buf;
}

/** 从本地文件重新打开准备结果，得到可查询的分析器。 */
export function open(path: string): FunnelAnalyzer {
  const fd = fs.openSync(path, "r");
  let prepared: PreparedFunnel;
  try {
    const prefix = Buffer.alloc(12);
    fs.readSync(fd, prefix, 0, 12, 0);
    if (prefix.toString("ascii", 0, 8) !== MAGIC) {
      throw new Error("not a journey-funnel file: " + path);
    }
    const headerLen = prefix.readUInt32LE(8);
    const headerBuf = Buffer.alloc(headerLen);
    fs.readSync(fd, headerBuf, 0, headerLen, 12);
    const header = JSON.parse(headerBuf.toString("utf8")) as FileHeader;

    const times = new Float64Array(readSection(fd, header.times, 8));
    const stages: StageIndex[] = [];
    for (let s = 0; s < STAGE_COUNT; s++) {
      const meta = header.stages[s];
      stages.push({
        ax: new Uint32Array(readSection(fd, meta.ax, 4)),
        ay: new Uint32Array(readSection(fd, meta.ay, 4)),
        bx: new Uint32Array(readSection(fd, meta.bx, 4)),
        by: new Uint32Array(readSection(fd, meta.by, 4)),
      });
    }
    prepared = { times, stages, timeBits: header.timeBits };
  } finally {
    fs.closeSync(fd);
  }
  return new FunnelAnalyzer(prepared);
}
