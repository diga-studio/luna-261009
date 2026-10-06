import { parseIPv4, parseIPv6 } from "./addr";
import { DecodeError, PacketWriter } from "./wire";
import { RRType } from "./types";
import type { DnsMessage, Name, RData, ResourceRecord, SectionName } from "./types";

export class EncodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EncodeError";
  }
}

/** Case-insensitive (ASCII-only) key for one label of an owner name. */
function lowerLabel(label: Uint8Array): string {
  let out = "";
  for (let i = 0; i < label.length; i++) {
    let byte = label[i]!;
    if (byte >= 0x41 && byte <= 0x5a) {
      byte += 0x20;
    }
    out += String.fromCharCode(byte);
  }
  return out;
}

function ownerKey(name: Name): string {
  let key = "";
  for (const label of name) {
    key += label.length + ":" + lowerLabel(label) + ",";
  }
  return key;
}

function rrsetKey(rr: ResourceRecord): string {
  return `${rr.type}|${rr.class}|${ownerKey(rr.name)}`;
}

function writeRData(writer: PacketWriter, rdata: RData): void {
  switch (rdata.kind) {
    case "A":
      writer.raw(parseIPv4(rdata.address));
      return;
    case "AAAA":
      writer.raw(parseIPv6(rdata.address));
      return;
    case "CNAME":
      writer.writeName(rdata.cname);
      return;
    case "PTR":
      writer.writeName(rdata.ptrdname);
      return;
    case "MX":
      writer.u16(rdata.preference);
      writer.writeName(rdata.exchange);
      return;
    case "TXT":
      for (const segment of rdata.strings) {
        if (segment.length > 255) {
          throw new EncodeError("TXT segment exceeds 255 bytes");
        }
        writer.u8(segment.length);
        writer.raw(segment);
      }
      return;
    case "SRV":
      writer.u16(rdata.priority);
      writer.u16(rdata.weight);
      writer.u16(rdata.port);
      // RFC 2782: the SRV target must not be compressed.
      writer.writeName(rdata.target, { compress: false });
      return;
  }
}

function writeRecord(writer: PacketWriter, rr: ResourceRecord): void {
  writer.writeName(rr.name);
  writer.u16(rr.type);
  writer.u16(rr.class);
  writer.u32(rr.ttl);
  const rdLengthOffset = writer.length;
  writer.u16(0); // patched below
  writeRData(writer, rr.rdata);
  const rdLength = writer.length - rdLengthOffset - 2;
  if (rdLength > 0xffff) {
    throw new EncodeError("RDATA exceeds 65535 bytes");
  }
  writer.setU16At(rdLengthOffset, rdLength);
}

function encodeMessage(message: DnsMessage, tc: boolean): Uint8Array {
  const writer = new PacketWriter();
  const { header, question } = message;
  writer.u16(header.id);
  let flags = 0;
  if (header.qr) flags |= 0x8000;
  flags |= (header.opcode & 0x0f) << 11;
  if (header.aa) flags |= 0x0400;
  if (tc) flags |= 0x0200;
  if (header.rd) flags |= 0x0100;
  if (header.ra) flags |= 0x0080;
  flags |= (header.z & 0x07) << 4;
  flags |= header.rcode & 0x0f;
  writer.u16(flags);
  writer.u16(1);
  writer.u16(message.answers.length);
  writer.u16(message.authorities.length);
  writer.u16(message.additionals.length);
  writer.writeName(question.qname);
  writer.u16(question.qtype);
  writer.u16(question.qclass);
  for (const rr of message.answers) writeRecord(writer, rr);
  for (const rr of message.authorities) writeRecord(writer, rr);
  for (const rr of message.additionals) writeRecord(writer, rr);
  return writer.toUint8Array();
}

interface RRsetRef {
  section: SectionName;
  key: string;
  lastIndex: number;
}

function listRRsets(records: ResourceRecord[], section: SectionName): RRsetRef[] {
  const lastIndexByKey = new Map<string, number>();
  records.forEach((rr, index) => {
    lastIndexByKey.set(rrsetKey(rr), index);
  });
  return [...lastIndexByKey.entries()].map(([key, lastIndex]) => ({ section, key, lastIndex }));
}

export function encode(message: DnsMessage, maxBytes = 65535): Uint8Array {
  if (maxBytes < 12) {
    throw new EncodeError("maxBytes too small for a DNS header");
  }
  const working: DnsMessage = {
    header: message.header,
    question: message.question,
    answers: [...message.answers],
    authorities: [...message.authorities],
    additionals: [...message.additionals],
  };
  // Removal plan: Additional, then Authority, then Answer; within a section,
  // RRsets ordered by last occurrence, latest first.
  const plan: RRsetRef[] = [];
  for (const [section, records] of [
    ["additional", working.additionals],
    ["authority", working.authorities],
    ["answer", working.answers],
  ] as const) {
    const sets = listRRsets(records, section);
    sets.sort((a, b) => b.lastIndex - a.lastIndex);
    plan.push(...sets);
  }
  const sections: Record<SectionName, ResourceRecord[]> = {
    answer: working.answers,
    authority: working.authorities,
    additional: working.additionals,
  };
  let removed = false;
  let packet = encodeMessage(working, working.header.tc);
  for (const rrset of plan) {
    if (packet.length <= maxBytes) {
      return packet;
    }
    const key = rrset.key;
    const kept = sections[rrset.section].filter((rr) => rrsetKey(rr) !== key);
    sections[rrset.section] = kept;
    if (rrset.section === "answer") working.answers = kept;
    else if (rrset.section === "authority") working.authorities = kept;
    else working.additionals = kept;
    removed = true;
    packet = encodeMessage(working, true);
  }
  if (packet.length <= maxBytes) {
    return packet;
  }
  if (removed) {
    throw new EncodeError(`message does not fit in ${maxBytes} bytes even after removing all RRsets`);
  }
  throw new EncodeError(`header and question alone exceed ${maxBytes} bytes`);
}
