/** A domain name as an array of raw label byte sequences (root label omitted). */
export type Name = Uint8Array[];

export enum RRType {
  A = 1,
  CNAME = 5,
  PTR = 12,
  MX = 15,
  TXT = 16,
  AAAA = 28,
  SRV = 33,
}

export type SectionName = "answer" | "authority" | "additional";

export interface Header {
  id: number;
  qr: boolean;
  opcode: number;
  aa: boolean;
  tc: boolean;
  rd: boolean;
  ra: boolean;
  z: number;
  rcode: number;
}

export interface Question {
  qname: Name;
  qtype: number;
  qclass: number;
}

export type RData =
  | { kind: "A"; address: string }
  | { kind: "AAAA"; address: string }
  | { kind: "CNAME"; cname: Name }
  | { kind: "PTR"; ptrdname: Name }
  | { kind: "MX"; preference: number; exchange: Name }
  | { kind: "TXT"; strings: Uint8Array[] }
  | { kind: "SRV"; priority: number; weight: number; port: number; target: Name };

export interface ResourceRecord {
  name: Name;
  type: RRType;
  class: number;
  ttl: number;
  rdata: RData;
}

export interface DnsMessage {
  header: Header;
  question: Question;
  answers: ResourceRecord[];
  authorities: ResourceRecord[];
  additionals: ResourceRecord[];
}
