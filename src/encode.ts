import { DnsError } from "./errors";
import { NameEncoder } from "./name";
import {
  DnsHeader,
  DnsMessage,
  Question,
  RData,
  ResourceRecord,
  RRType,
} from "./types";

const HEADER_LENGTH = 12;
const DEFAULT_MAX_BYTES = 65535;

function checkRange(value: number, bits: number, what: string): void {
  if (!Number.isInteger(value) || value < 0 || value >= 1 << bits) {
    throw new DnsError(`${what} out of range for ${bits}-bit field`);
  }
}

function encodeHeader(header: DnsHeader, qd: number, an: number, ns: number, ar: number): Buffer {
  checkRange(header.id, 16, "id");
  checkRange(header.opcode, 4, "opcode");
  checkRange(header.z, 3, "z");
  checkRange(header.rcode, 4, "rcode");
  const flags =
    (header.qr ? 0x8000 : 0) |
    (header.opcode << 11) |
    (header.aa ? 0x0400 : 0) |
    (header.tc ? 0x0200 : 0) |
    (header.rd ? 0x0100 : 0) |
    (header.ra ? 0x0080 : 0) |
    (header.z << 4) |
    header.rcode;
  const buf = Buffer.alloc(HEADER_LENGTH);
  buf.writeUInt16BE(header.id, 0);
  buf.writeUInt16BE(flags, 2);
  buf.writeUInt16BE(qd, 4);
  buf.writeUInt16BE(an, 6);
  buf.writeUInt16BE(ns, 8);
  buf.writeUInt16BE(ar, 10);
  return buf;
}

function encodeRdata(rdata: RData, enc: NameEncoder, offset: number): Buffer {
  switch (rdata.type) {
    case RRType.A: {
      if (rdata.address.length !== 4) {
        throw new DnsError("A record address must be 4 bytes");
      }
      return Buffer.from(rdata.address);
    }
    case RRType.AAAA: {
      if (rdata.address.length !== 16) {
        throw new DnsError("AAAA record address must be 16 bytes");
      }
      return Buffer.from(rdata.address);
    }
    case RRType.CNAME:
    case RRType.PTR: {
      return enc.encode(rdata.target, true, offset);
    }
    case RRType.MX: {
      checkRange(rdata.preference, 16, "MX preference");
      const head = Buffer.alloc(2);
      head.writeUInt16BE(rdata.preference, 0);
      return Buffer.concat([head, enc.encode(rdata.exchange, true, offset + 2)]);
    }
    case RRType.TXT: {
      const parts: Buffer[] = [];
      for (const segment of rdata.strings) {
        if (segment.length > 255) {
          throw new DnsError("TXT segment exceeds 255 bytes");
        }
        parts.push(Buffer.from([segment.length]), segment);
      }
      return Buffer.concat(parts);
    }
    case RRType.SRV: {
      checkRange(rdata.priority, 16, "SRV priority");
      checkRange(rdata.weight, 16, "SRV weight");
      checkRange(rdata.port, 16, "SRV port");
      const head = Buffer.alloc(6);
      head.writeUInt16BE(rdata.priority, 0);
      head.writeUInt16BE(rdata.weight, 2);
      head.writeUInt16BE(rdata.port, 4);
      // SRV target must not be compressed (RFC 2782).
      return Buffer.concat([head, enc.encode(rdata.target, false, offset + 6)]);
    }
  }
}

function validateRecord(record: ResourceRecord): void {
  switch (record.type) {
    case RRType.A:
    case RRType.AAAA:
    case RRType.CNAME:
    case RRType.PTR:
    case RRType.MX:
    case RRType.TXT:
    case RRType.SRV:
      break;
    default:
      throw new DnsError(`unsupported RR type ${record.type}`);
  }
  if (record.type !== record.rdata.type) {
    throw new DnsError("record type does not match rdata variant");
  }
  checkRange(record.class, 16, "class");
  if (!Number.isInteger(record.ttl) || record.ttl < 0 || record.ttl > 0xffffffff) {
    throw new DnsError("ttl out of range for 32-bit field");
  }
}

function encodeRecord(record: ResourceRecord, enc: NameEncoder, offset: number): Buffer {
  validateRecord(record);
  const owner = enc.encode(record.name, true, offset);
  const fixed = Buffer.alloc(10);
  fixed.writeUInt16BE(record.type, 0);
  fixed.writeUInt16BE(record.class, 2);
  fixed.writeUInt32BE(record.ttl, 4);
  const rdata = encodeRdata(record.rdata, enc, offset + owner.length + 10 + 2);
  fixed.writeUInt16BE(rdata.length, 8);
  return Buffer.concat([owner, fixed, rdata]);
}

function encodeQuestion(question: Question, enc: NameEncoder, offset: number): Buffer {
  checkRange(question.qtype, 16, "qtype");
  checkRange(question.qclass, 16, "qclass");
  const name = enc.encode(question.name, true, offset);
  const fixed = Buffer.alloc(4);
  fixed.writeUInt16BE(question.qtype, 0);
  fixed.writeUInt16BE(question.qclass, 2);
  return Buffer.concat([name, fixed]);
}

function buildPacket(message: DnsMessage): Buffer {
  const enc = new NameEncoder();
  const parts: Buffer[] = [];
  let offset = HEADER_LENGTH;
  const push = (buf: Buffer): void => {
    parts.push(buf);
    offset += buf.length;
  };
  push(encodeQuestion(message.question, enc, offset));
  for (const rr of message.answers) {
    push(encodeRecord(rr, enc, offset));
  }
  for (const rr of message.authorities) {
    push(encodeRecord(rr, enc, offset));
  }
  for (const rr of message.additionals) {
    push(encodeRecord(rr, enc, offset));
  }
  const header = encodeHeader(
    message.header,
    1,
    message.answers.length,
    message.authorities.length,
    message.additionals.length,
  );
  return Buffer.concat([header, ...parts]);
}

function asciiLower(label: Buffer): Buffer {
  const out = Buffer.from(label);
  for (let i = 0; i < out.length; i++) {
    const b = out[i]!;
    if (b >= 0x41 && b <= 0x5a) {
      out[i] = b + 0x20;
    }
  }
  return out;
}

function rrsetKey(record: ResourceRecord): string {
  const name = record.name.map(asciiLower);
  const parts: Buffer[] = [];
  for (const label of name) {
    parts.push(Buffer.from([label.length]), label);
  }
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(record.type, 0);
  tail.writeUInt16BE(record.class, 2);
  return Buffer.concat([...parts, tail]).toString("latin1");
}

/** Remove the RRset (same section, case-insensitive owner, type, class)
 *  whose last occurrence is nearest to the end of `records`. */
function removeLastRrset(records: ResourceRecord[]): void {
  const lastIndex = new Map<string, number>();
  for (let i = 0; i < records.length; i++) {
    lastIndex.set(rrsetKey(records[i]!), i);
  }
  let victimKey = "";
  let victimPos = -1;
  for (const [key, pos] of lastIndex) {
    if (pos > victimPos) {
      victimPos = pos;
      victimKey = key;
    }
  }
  for (let i = records.length - 1; i >= 0; i--) {
    if (rrsetKey(records[i]!) === victimKey) {
      records.splice(i, 1);
    }
  }
}

/** Encode a DNS message to a complete packet of at most `maxBytes` bytes.
 *  When over budget, whole RRsets are removed (Additional, then Authority,
 *  then Answer; within a section the set whose last member appears latest
 *  goes first) and TC is set. Throws when even header+question (with any
 *  remaining records) cannot fit. */
export function encode(message: DnsMessage, maxBytes: number = DEFAULT_MAX_BYTES): Buffer {
  if (!Number.isInteger(maxBytes) || maxBytes < 0) {
    throw new DnsError("maxBytes must be a non-negative integer");
  }
  const working: DnsMessage = {
    header: { ...message.header },
    question: {
      name: message.question.name.map((l) => Buffer.from(l)),
      qtype: message.question.qtype,
      qclass: message.question.qclass,
    },
    answers: message.answers.slice(),
    authorities: message.authorities.slice(),
    additionals: message.additionals.slice(),
  };
  let packet = buildPacket(working);
  let trimmed = false;
  while (packet.length > maxBytes) {
    const section =
      working.additionals.length > 0
        ? working.additionals
        : working.authorities.length > 0
          ? working.authorities
          : working.answers.length > 0
            ? working.answers
            : null;
    if (section === null) {
      throw new DnsError(
        `message does not fit in ${maxBytes} bytes even after removing all records`,
      );
    }
    removeLastRrset(section);
    trimmed = true;
    packet = buildPacket(working);
  }
  if (trimmed && !working.header.tc) {
    working.header.tc = true;
    packet = buildPacket(working);
  }
  return packet;
}
