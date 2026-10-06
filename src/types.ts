/** A domain name as an ordered list of raw labels. Each label is the exact
 *  wire bytes (1..63 bytes, may contain dots, zero bytes, non-ASCII).
 *  The root name is the empty array. */
export type DnsName = Buffer[];

/** Supported resource record types. */
export const enum RRType {
  A = 1,
  CNAME = 5,
  PTR = 12,
  MX = 15,
  TXT = 16,
  AAAA = 28,
  SRV = 33,
}

export interface DnsHeader {
  id: number;
  /** true for response, false for query */
  qr: boolean;
  opcode: number;
  aa: boolean;
  tc: boolean;
  rd: boolean;
  ra: boolean;
  /** 3-bit reserved Z field */
  z: number;
  rcode: number;
}

export interface Question {
  name: DnsName;
  qtype: number;
  qclass: number;
}

export type RData =
  | { type: RRType.A; address: Buffer }
  | { type: RRType.AAAA; address: Buffer }
  | { type: RRType.CNAME; target: DnsName }
  | { type: RRType.PTR; target: DnsName }
  | { type: RRType.MX; preference: number; exchange: DnsName }
  | { type: RRType.TXT; strings: Buffer[] }
  | { type: RRType.SRV; priority: number; weight: number; port: number; target: DnsName };

export interface ResourceRecord {
  name: DnsName;
  type: RRType;
  class: number;
  ttl: number;
  rdata: RData;
}

export interface DnsMessage {
  header: DnsHeader;
  /** Exactly one question is supported. */
  question: Question;
  answers: ResourceRecord[];
  authorities: ResourceRecord[];
  additionals: ResourceRecord[];
}
