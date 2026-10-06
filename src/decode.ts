import { formatIPv4, formatIPv6 } from "./addr";
import { DecodeError, readName } from "./wire";
import { RRType } from "./types";
import type { DnsMessage, Header, Question, RData, ResourceRecord } from "./types";

class Reader {
  offset = 0;
  constructor(readonly buf: Uint8Array) {}

  u8(): number {
    if (this.offset + 1 > this.buf.length) {
      throw new DecodeError("unexpected end of packet");
    }
    return this.buf[this.offset++]!;
  }

  u16(): number {
    return (this.u8() << 8) | this.u8();
  }

  u32(): number {
    return ((this.u16() << 16) | this.u16()) >>> 0;
  }
}

function readHeader(reader: Reader): { header: Header; counts: [number, number, number, number] } {
  if (reader.offset + 12 > reader.buf.length) {
    throw new DecodeError("packet shorter than DNS header");
  }
  const id = reader.u16();
  const flags = reader.u16();
  const header: Header = {
    id,
    qr: (flags & 0x8000) !== 0,
    opcode: (flags >>> 11) & 0x0f,
    aa: (flags & 0x0400) !== 0,
    tc: (flags & 0x0200) !== 0,
    rd: (flags & 0x0100) !== 0,
    ra: (flags & 0x0080) !== 0,
    z: (flags >>> 4) & 0x07,
    rcode: flags & 0x0f,
  };
  const counts: [number, number, number, number] = [reader.u16(), reader.u16(), reader.u16(), reader.u16()];
  return { header, counts };
}

function readRData(
  buf: Uint8Array,
  rdStart: number,
  rdLength: number,
  type: RRType,
): RData {
  const end = rdStart + rdLength;
  switch (type) {
    case RRType.A: {
      if (rdLength !== 4) {
        throw new DecodeError("A record RDLENGTH must be 4");
      }
      return { kind: "A", address: formatIPv4(buf.subarray(rdStart, end)) };
    }
    case RRType.AAAA: {
      if (rdLength !== 16) {
        throw new DecodeError("AAAA record RDLENGTH must be 16");
      }
      return { kind: "AAAA", address: formatIPv6(buf.subarray(rdStart, end)) };
    }
    case RRType.CNAME: {
      const { name, nextOffset } = readName(buf, rdStart);
      if (nextOffset !== end) {
        throw new DecodeError("CNAME RDATA does not fill RDLENGTH");
      }
      return { kind: "CNAME", cname: name };
    }
    case RRType.PTR: {
      const { name, nextOffset } = readName(buf, rdStart);
      if (nextOffset !== end) {
        throw new DecodeError("PTR RDATA does not fill RDLENGTH");
      }
      return { kind: "PTR", ptrdname: name };
    }
    case RRType.MX: {
      if (rdLength < 3) {
        throw new DecodeError("MX RDATA too short");
      }
      const preference = (buf[rdStart]! << 8) | buf[rdStart + 1]!;
      const { name, nextOffset } = readName(buf, rdStart + 2);
      if (nextOffset !== end) {
        throw new DecodeError("MX RDATA does not fill RDLENGTH");
      }
      return { kind: "MX", preference, exchange: name };
    }
    case RRType.TXT: {
      const strings: Uint8Array[] = [];
      let pos = rdStart;
      while (pos < end) {
        const len = buf[pos]!;
        if (pos + 1 + len > end) {
          throw new DecodeError("TXT segment overruns RDLENGTH");
        }
        strings.push(buf.slice(pos + 1, pos + 1 + len));
        pos += 1 + len;
      }
      return { kind: "TXT", strings };
    }
    case RRType.SRV: {
      if (rdLength < 7) {
        throw new DecodeError("SRV RDATA too short");
      }
      const priority = (buf[rdStart]! << 8) | buf[rdStart + 1]!;
      const weight = (buf[rdStart + 2]! << 8) | buf[rdStart + 3]!;
      const port = (buf[rdStart + 4]! << 8) | buf[rdStart + 5]!;
      const { name, nextOffset } = readName(buf, rdStart + 6);
      if (nextOffset !== end) {
        throw new DecodeError("SRV RDATA does not fill RDLENGTH");
      }
      return { kind: "SRV", priority, weight, port, target: name };
    }
    default:
      throw new DecodeError(`unsupported RR type ${type}`);
  }
}

function readRecord(buf: Uint8Array, reader: Reader): ResourceRecord {
  const { name, nextOffset } = readName(buf, reader.offset);
  reader.offset = nextOffset;
  const type = reader.u16();
  const rrClass = reader.u16();
  const ttl = reader.u32();
  const rdLength = reader.u16();
  const rdStart = reader.offset;
  if (rdStart + rdLength > buf.length) {
    throw new DecodeError("RDATA runs past end of packet");
  }
  if (!Object.values(RRType).includes(type)) {
    throw new DecodeError(`unsupported RR type ${type}`);
  }
  const rdata = readRData(buf, rdStart, rdLength, type as RRType);
  reader.offset = rdStart + rdLength;
  return { name, type: type as RRType, class: rrClass, ttl, rdata };
}

export function decode(packet: Uint8Array): DnsMessage {
  const reader = new Reader(packet);
  const { header, counts } = readHeader(reader);
  const [qdCount, anCount, nsCount, arCount] = counts;
  if (qdCount !== 1) {
    throw new DecodeError(`expected exactly 1 question, got ${qdCount}`);
  }
  const { name: qname, nextOffset } = readName(packet, reader.offset);
  reader.offset = nextOffset;
  const question: Question = { qname, qtype: reader.u16(), qclass: reader.u16() };
  const answers: ResourceRecord[] = [];
  const authorities: ResourceRecord[] = [];
  const additionals: ResourceRecord[] = [];
  for (let i = 0; i < anCount; i++) answers.push(readRecord(packet, reader));
  for (let i = 0; i < nsCount; i++) authorities.push(readRecord(packet, reader));
  for (let i = 0; i < arCount; i++) additionals.push(readRecord(packet, reader));
  return { header, question, answers, authorities, additionals };
}
