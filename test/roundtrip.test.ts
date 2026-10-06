import test from "node:test";
import assert from "node:assert/strict";
import { decode, encode, RRType } from "../src/index";
import type { DnsMessage, Name, ResourceRecord } from "../src/index";
import { nameOf } from "./helpers";

export function baseMessage(): DnsMessage {
  return {
    header: { id: 0xbeef, qr: true, opcode: 0, aa: true, tc: false, rd: true, ra: true, z: 0, rcode: 0 },
    question: { qname: nameOf("www", "Example", "COM"), qtype: RRType.A, qclass: 1 },
    answers: [],
    authorities: [],
    additionals: [],
  };
}

test("roundtrips all seven record types with order and case preserved", () => {
  const msg = baseMessage();
  const owner = nameOf("WWW", "Example", "COM");
  const records: ResourceRecord[] = [
    { name: owner, type: RRType.A, class: 1, ttl: 300, rdata: { kind: "A", address: "192.0.2.1" } },
    { name: owner, type: RRType.AAAA, class: 1, ttl: 300, rdata: { kind: "AAAA", address: "2001:db8:0:0:0:0:0:1" } },
    { name: owner, type: RRType.CNAME, class: 1, ttl: 300, rdata: { kind: "CNAME", cname: nameOf("Cdn", "Example", "COM") } },
    { name: owner, type: RRType.MX, class: 1, ttl: 300, rdata: { kind: "MX", preference: 10, exchange: nameOf("Mail", "Example", "COM") } },
    { name: owner, type: RRType.TXT, class: 1, ttl: 300, rdata: { kind: "TXT", strings: [new Uint8Array([0, 46, 255]), Uint8Array.from([97, 98])] } },
    { name: owner, type: RRType.PTR, class: 1, ttl: 300, rdata: { kind: "PTR", ptrdname: nameOf("Ptr", "Example", "COM") } },
    { name: owner, type: RRType.SRV, class: 1, ttl: 300, rdata: { kind: "SRV", priority: 1, weight: 2, port: 443, target: nameOf("Srv", "Example", "COM") } },
  ];
  msg.answers = records;
  const packet = encode(msg);
  const back = decode(packet);
  assert.equal(back.header.id, 0xbeef);
  assert.equal(back.header.tc, false);
  assert.deepEqual(back.question.qname, nameOf("www", "Example", "COM"));
  assert.equal(back.answers.length, 7);
  for (let i = 0; i < records.length; i++) {
    assert.equal(back.answers[i]!.type, records[i]!.type, `type at ${i}`);
    assert.deepEqual(back.answers[i]!.name, records[i]!.name, `name at ${i}`);
    assert.deepEqual(back.answers[i]!.rdata, records[i]!.rdata, `rdata at ${i}`);
    assert.equal(back.answers[i]!.ttl, records[i]!.ttl);
  }
});

test("preserves label boundaries, dots, zero and non-ASCII bytes inside labels", () => {
  const msg = baseMessage();
  const weird = new Uint8Array([0x2e, 0x00, 0xff, 0x80, 0x2e]);
  msg.question.qname = [weird, ...nameOf("example", "com")];
  msg.answers = [
    { name: msg.question.qname, type: RRType.TXT, class: 1, ttl: 0, rdata: { kind: "TXT", strings: [new Uint8Array([0, 1, 2, 46, 255])] } },
  ];
  const back = decode(encode(msg));
  assert.deepEqual(back.question.qname[0], weird);
  assert.deepEqual((back.answers[0]!.rdata as { strings: Uint8Array[] }).strings[0], new Uint8Array([0, 1, 2, 46, 255]));
});

test("accepts 63-byte labels and 255-byte names", () => {
  const msg = baseMessage();
  const label63 = new Uint8Array(63).fill(0x61);
  // 1+63 + 1+63 + 1+63 + 1+61 + 1(root) = 255
  const label61 = new Uint8Array(61).fill(0x62);
  msg.question.qname = [label63, label63, label63, label61];
  const back = decode(encode(msg));
  assert.deepEqual(back.question.qname, [label63, label63, label63, label61]);
});

test("rejects labels over 63 bytes and names over 255 bytes", () => {
  const msg = baseMessage();
  msg.question.qname = [new Uint8Array(64).fill(0x61)];
  assert.throws(() => encode(msg), /63/);
  msg.question.qname = [new Uint8Array(63).fill(1), new Uint8Array(63).fill(2), new Uint8Array(63).fill(3), new Uint8Array(62).fill(4)];
  assert.throws(() => encode(msg), /255/);
});

test("SRV target is never compressed", () => {
  const msg = baseMessage();
  const target = nameOf("www", "Example", "COM"); // same as qname: compressible in principle
  msg.answers = [
    { name: target, type: RRType.SRV, class: 1, ttl: 0, rdata: { kind: "SRV", priority: 0, weight: 0, port: 80, target } },
  ];
  const packet = encode(msg);
  // The SRV target must appear as literal labels: find "www" bytes after the SRV fixed fields.
  const tail = packet.subarray(packet.length - (1 + 3 + 1 + 7 + 1 + 3 + 1));
  assert.deepEqual([...tail], [3, 119, 119, 119, 7, 69, 120, 97, 109, 112, 108, 101, 3, 67, 79, 77, 0]);
  const back = decode(packet);
  assert.deepEqual((back.answers[0]!.rdata as { target: Name }).target, target);
});

test("rejects unsupported RR types on decode", () => {
  const msg = baseMessage();
  const packet = encode(msg);
  // Hand-craft: take header+question, then append an NS (type 2) record.
  const qEnd = packet.length;
  const rr = [0xc0, 0x0c, 0, 2, 0, 1, 0, 0, 0, 0, 0, 2, 0xc0, 0x0c];
  const full = new Uint8Array(qEnd + rr.length);
  full.set(packet);
  full.set(rr, qEnd);
  full[7] = 1; // ANCOUNT = 1
  assert.throws(() => decode(full), /unsupported/);
});
