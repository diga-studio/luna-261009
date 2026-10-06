import { DnsError } from "./errors";
import { readName } from "./name";
import {
  DnsHeader,
  DnsMessage,
  Question,
  RData,
  ResourceRecord,
  RRType,
} from "./types";

const SUPPORTED_TYPES = new Set<number>([
  RRType.A,
  RRType.CNAME,
  RRType.PTR,
  RRType.MX,
  RRType.TXT,
  RRType.AAAA,
  RRType.SRV,
]);

function readHeader(packet: Buffer): DnsHeader {
  if (packet.length < 12) {
    throw new DnsError("packet shorter than DNS header");
  }
  const flags = packet.readUInt16BE(2);
  return {
    id: packet.readUInt16BE(0),
    qr: (flags & 0x8000) !== 0,
    opcode: (flags >> 11) & 0x0f,
    aa: (flags & 0x0400) !== 0,
    tc: (flags & 0x0200) !== 0,
    rd: (flags & 0x0100) !== 0,
    ra: (flags & 0x0080) !== 0,
    z: (flags >> 4) & 0x07,
    rcode: flags & 0x0f,
  };
}

function readQuestion(packet: Buffer, offset: number): { question: Question; next: number } {
  const { name, consumed } = readName(packet, offset);
  const pos = offset + consumed;
  if (pos + 4 > packet.length) {
    throw new DnsError("truncated question");
  }
  return {
    question: {
      name,
      qtype: packet.readUInt16BE(pos),
      qclass: packet.readUInt16BE(pos + 2),
    },
    next: pos + 4,
  };
}

function readRdata(
  packet: Buffer,
  type: RRType,
  start: number,
  rdlength: number,
): RData {
  const end = start + rdlength;
  switch (type) {
    case RRType.A: {
      if (rdlength !== 4) {
        throw new DnsError("A record RDLENGTH must be 4");
      }
      return { type, address: Buffer.from(packet.subarray(start, end)) };
    }
    case RRType.AAAA: {
      if (rdlength !== 16) {
        throw new DnsError("AAAA record RDLENGTH must be 16");
      }
      return { type, address: Buffer.from(packet.subarray(start, end)) };
    }
    case RRType.CNAME:
    case RRType.PTR: {
      const { name, consumed } = readName(packet, start);
      if (consumed !== rdlength) {
        throw new DnsError("RDLENGTH does not match name in RDATA");
      }
      return { type, target: name };
    }
    case RRType.MX: {
      if (rdlength < 3) {
        throw new DnsError("MX RDATA too short");
      }
      const preference = packet.readUInt16BE(start);
      const { name, consumed } = readName(packet, start + 2);
      if (consumed !== rdlength - 2) {
        throw new DnsError("RDLENGTH does not match MX exchange name");
      }
      return { type, preference, exchange: name };
    }
    case RRType.TXT: {
      const strings: Buffer[] = [];
      let pos = start;
      while (pos < end) {
        const len = packet[pos]!;
        if (pos + 1 + len > end) {
          throw new DnsError("TXT segment overruns RDATA");
        }
        strings.push(Buffer.from(packet.subarray(pos + 1, pos + 1 + len)));
        pos += 1 + len;
      }
      return { type, strings };
    }
    case RRType.SRV: {
      if (rdlength < 7) {
        throw new DnsError("SRV RDATA too short");
      }
      const priority = packet.readUInt16BE(start);
      const weight = packet.readUInt16BE(start + 2);
      const port = packet.readUInt16BE(start + 4);
      const { name, consumed } = readName(packet, start + 6);
      if (consumed !== rdlength - 6) {
        throw new DnsError("RDLENGTH does not match SRV target name");
      }
      return { type, priority, weight, port, target: name };
    }
  }
}

function readRecord(packet: Buffer, offset: number): { record: ResourceRecord; next: number } {
  const { name, consumed } = readName(packet, offset);
  const pos = offset + consumed;
  if (pos + 10 > packet.length) {
    throw new DnsError("truncated resource record header");
  }
  const type = packet.readUInt16BE(pos);
  if (!SUPPORTED_TYPES.has(type)) {
    throw new DnsError(`unsupported RR type ${type}`);
  }
  const rrClass = packet.readUInt16BE(pos + 2);
  const ttl = packet.readUInt32BE(pos + 4);
  const rdlength = packet.readUInt16BE(pos + 8);
  const rdataStart = pos + 10;
  if (rdataStart + rdlength > packet.length) {
    throw new DnsError("RDLENGTH overruns packet");
  }
  const rdata = readRdata(packet, type as RRType, rdataStart, rdlength);
  return {
    record: { name, type: type as RRType, class: rrClass, ttl, rdata },
    next: rdataStart + rdlength,
  };
}

/** Parse one complete DNS message. Throws DnsError on malformed input. */
export function decode(packet: Buffer): DnsMessage {
  const header = readHeader(packet);
  const qdcount = packet.readUInt16BE(4);
  const ancount = packet.readUInt16BE(6);
  const nscount = packet.readUInt16BE(8);
  const arcount = packet.readUInt16BE(10);
  if (qdcount !== 1) {
    throw new DnsError(`expected exactly 1 question, got ${qdcount}`);
  }
  const { question, next } = readQuestion(packet, 12);
  let offset = next;
  const readSection = (count: number): ResourceRecord[] => {
    const records: ResourceRecord[] = [];
    for (let i = 0; i < count; i++) {
      const { record, next: n } = readRecord(packet, offset);
      records.push(record);
      offset = n;
    }
    return records;
  };
  const answers = readSection(ancount);
  const authorities = readSection(nscount);
  const additionals = readSection(arcount);
  return { header, question, answers, authorities, additionals };
}
