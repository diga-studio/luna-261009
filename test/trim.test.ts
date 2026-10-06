import test from "node:test";
import assert from "node:assert/strict";
import { decode, encode, RRType } from "../src/index";
import type { DnsMessage, Name, ResourceRecord } from "../src/index";
import { findSubsequence, nameOf } from "./helpers";

const text = (labels: Name) => labels.map((l) => String.fromCharCode(...l)).join(".");

function msg(): DnsMessage {
  return {
    header: { id: 7, qr: true, opcode: 0, aa: true, tc: false, rd: true, ra: true, z: 0, rcode: 0 },
    question: { qname: nameOf("www", "example", "com"), qtype: RRType.A, qclass: 1 },
    answers: [],
    authorities: [],
    additionals: [],
  };
}

function a(name: Name, address: string, ttl = 0): ResourceRecord {
  return { name, type: RRType.A, class: 1, ttl, rdata: { kind: "A", address } };
}

test("interleaved RRsets: later group removed whole, earlier member was a compression source", () => {
  const m = msg();
  const host = nameOf("host", "example", "com");
  const x = nameOf("x", "example", "com");
  // Y = {Y1, Y2} (host.example.com A), X = {X1, X2} (x.example.com A and CNAME).
  // X2's CNAME rdata points at host.example.com, which only Y1 writes as a
  // suffix boundary, so the untrimmed packet compresses X2's rdata into Y1.
  const y1 = a(host, "192.0.2.1");
  const x1 = a(x, "192.0.2.2");
  const x2: ResourceRecord = { name: x, type: RRType.CNAME, class: 1, ttl: 0, rdata: { kind: "CNAME", cname: host } };
  const y2 = a(host, "192.0.2.3");
  m.answers = [y1, x1, x2, y2];

  const full = encode(m);
  // Byte-level layout of the untrimmed packet (hand-computed):
  //   33: Y1 owner  04 "host" C0 10        ("host.example.com" suffix born here)
  //   54: X1 owner  01 "x" C0 10
  //   72: X2 owner  C0 36                  (pointer to X1's owner at 54)
  //   84: X2 rdata  C0 21                  (pointer into Y1's owner at 33)
  //   86: Y2 owner  C0 21
  assert.equal(full.length, 102);
  assert.deepEqual([...full.subarray(33, 38)], [4, 104, 111, 115, 116]);
  assert.deepEqual([...full.subarray(38, 40)], [0xc0, 0x10]);
  assert.deepEqual([...full.subarray(72, 74)], [0xc0, 0x36]);
  assert.deepEqual([...full.subarray(84, 86)], [0xc0, 0x21], "X2 rdata compresses into Y1");
  assert.deepEqual([...full.subarray(86, 88)], [0xc0, 0x21]);

  // Trim by a single byte: only the Y RRset may disappear.
  const trimmed = encode(m, full.length - 1);
  const back = decode(trimmed);
  assert.equal(back.header.tc, true, "TC set after trimming");
  assert.equal(back.answers.length, 2, "whole Y RRset removed atomically");
  assert.equal(text(back.answers[0]!.name), "x.example.com");
  assert.equal(text(back.answers[1]!.name), "x.example.com");
  assert.deepEqual(back.answers[0]!.rdata, { kind: "A", address: "192.0.2.2" });
  assert.deepEqual(back.answers[1]!.rdata, { kind: "CNAME", cname: host });
  // Counts in the raw header reflect the actual content.
  assert.equal((trimmed[6]! << 8) | trimmed[7]!, 2, "ANCOUNT");
  // The retained CNAME no longer references the removed Y1 bytes: it is
  // re-encoded as "host" + pointer to "example.com" in the question (offset 16).
  const hostLabel = findSubsequence(trimmed, [4, 104, 111, 115, 116]);
  assert.notEqual(hostLabel, -1);
  assert.deepEqual([...trimmed.subarray(hostLabel, hostLabel + 7)], [4, 104, 111, 115, 116, 0xc0, 0x10]);
  // No pointer in the trimmed packet targets the byte range the Y records
  // used to occupy: the packet is self-contained and shorter than before.
  assert.ok(trimmed.length < full.length);
  assert.equal(decode(trimmed).header.id, 7, "trimmed packet decodes standalone");
});

test("names first seen beyond the 14-bit pointer range are not truncated", () => {
  const m = msg();
  // Pad with a TXT record large enough to push subsequent offsets past 16383.
  const segments: Uint8Array[] = [];
  for (let i = 0; i < 65; i++) segments.push(new Uint8Array(255).fill(0x41));
  m.answers.push({ name: nameOf("pad", "example", "com"), type: RRType.TXT, class: 1, ttl: 0, rdata: { kind: "TXT", strings: segments } });
  const repeated = nameOf("repeat-name", "internal", "example", "com");
  m.answers.push(a(repeated, "192.0.2.10"));
  m.answers.push(a(repeated, "192.0.2.11"));

  const packet = encode(m);
  assert.ok(packet.length > 16384, `packet is ${packet.length} bytes`);
  const back = decode(packet);
  assert.equal(back.answers.length, 3);
  assert.deepEqual(back.answers[1]!.name, repeated);
  assert.deepEqual(back.answers[2]!.name, repeated);
  assert.deepEqual(back.answers[2]!.rdata, { kind: "A", address: "192.0.2.11" });

  // Byte-level: the second occurrence of the repeated name must start with a
  // real label, not a (truncated) pointer. Locate it after the first A record.
  const firstA = packet.indexOf(11 /* "repeat-name" length */, 16383);
  assert.notEqual(firstA, -1);
  const secondA = packet.indexOf(11, firstA + 1);
  assert.notEqual(secondA, -1);
  assert.notEqual(packet[secondA]! & 0xc0, 0xc0, "second occurrence is not a bare pointer");
  assert.equal(packet[secondA], 11);
  assert.equal(String.fromCharCode(...packet.subarray(secondA + 1, secondA + 12)), "repeat-name");
});

test("removal order is additional, then authority, then answer", () => {
  const m = msg();
  m.answers = [a(nameOf("a", "example", "com"), "192.0.2.1")];
  m.authorities = [{ name: nameOf("ns", "example", "com"), type: RRType.MX, class: 1, ttl: 0, rdata: { kind: "MX", preference: 5, exchange: nameOf("mail", "example", "com") } }];
  m.additionals = [{ name: nameOf("t", "example", "com"), type: RRType.TXT, class: 1, ttl: 0, rdata: { kind: "TXT", strings: [Uint8Array.from([1, 2, 3])] } }];

  const full = encode(m);
  // Budget that only forces the additional RRset out.
  const trimmed1 = encode(m, full.length - 1);
  const back1 = decode(trimmed1);
  assert.equal(back1.additionals.length, 0, "additional removed first");
  assert.equal(back1.authorities.length, 1, "authority kept");
  assert.equal(back1.answers.length, 1, "answer kept");
  assert.equal(back1.header.tc, true);

  // Budget that forces additional + authority out.
  const trimmed2 = encode(m, trimmed1.length - 1);
  const back2 = decode(trimmed2);
  assert.equal(back2.additionals.length, 0);
  assert.equal(back2.authorities.length, 0, "authority removed second");
  assert.equal(back2.answers.length, 1, "answer still kept");
  assert.equal(back2.header.tc, true);

  // Budget that forces everything out: header + question only.
  const trimmed3 = encode(m, trimmed2.length - 1);
  const back3 = decode(trimmed3);
  assert.equal(back3.answers.length, 0);
  assert.equal(back3.header.tc, true);
  assert.equal((trimmed3[6]! << 8) | trimmed3[7]!, 0);
  assert.equal((trimmed3[8]! << 8) | trimmed3[9]!, 0);
  assert.equal((trimmed3[10]! << 8) | trimmed3[11]!, 0);
});

test("within a section the RRset with the latest last occurrence goes first", () => {
  const m = msg();
  const o1 = nameOf("o1", "example", "com");
  const o2 = nameOf("o2", "example", "com");
  // Interleave: A(o1) A(o2) A(o1) A(o2). o2's last occurrence is later.
  m.answers = [a(o1, "192.0.2.1"), a(o2, "192.0.2.2"), a(o1, "192.0.2.3"), a(o2, "192.0.2.4")];
  const full = encode(m);
  const trimmed = encode(m, full.length - 1);
  const back = decode(trimmed);
  assert.equal(back.answers.length, 2, "o2 RRset removed atomically");
  assert.deepEqual(back.answers.map((r) => (r.rdata as { address: string }).address), ["192.0.2.1", "192.0.2.3"]);
  assert.ok(back.answers.every((r) => text(r.name) === "o1.example.com"));
  assert.equal(back.header.tc, true);
});

test("RRset membership ignores ASCII case and non-adjacency", () => {
  const m = msg();
  const upper = nameOf("X", "Example", "COM");
  const lower = nameOf("x", "example", "com");
  const other = nameOf("y", "example", "com");
  m.answers = [a(upper, "192.0.2.1"), a(other, "192.0.2.2"), a(lower, "192.0.2.3")];
  const full = encode(m);
  const trimmed = encode(m, full.length - 1);
  const back = decode(trimmed);
  // upper/lower are one RRset (latest last occurrence at index 2) -> removed.
  assert.equal(back.answers.length, 1);
  assert.equal(text(back.answers[0]!.name), "y.example.com");
  assert.equal(back.header.tc, true);
});

test("different types with the same owner are different RRsets", () => {
  const m = msg();
  const owner = nameOf("x", "example", "com");
  m.answers = [
    a(owner, "192.0.2.1"),
    { name: owner, type: RRType.TXT, class: 1, ttl: 0, rdata: { kind: "TXT", strings: [Uint8Array.from([9])] } },
  ];
  const full = encode(m);
  const trimmed = encode(m, full.length - 1);
  const back = decode(trimmed);
  // TXT comes last, so the TXT RRset is removed; the A RRset stays whole.
  assert.equal(back.answers.length, 1);
  assert.equal(back.answers[0]!.type, RRType.A);
});

test("TC is preserved when nothing is removed", () => {
  const m = msg();
  m.answers = [a(nameOf("a", "example", "com"), "192.0.2.1")];
  assert.equal(decode(encode(m)).header.tc, false);
  m.header.tc = true;
  assert.equal(decode(encode(m)).header.tc, true);
});

test("fails when header and question alone exceed the budget", () => {
  const m = msg();
  m.answers = [a(nameOf("a", "example", "com"), "192.0.2.1")];
  const headerAndQuestion = 12 + 17 + 4;
  assert.throws(() => encode(m, headerAndQuestion - 1), /fit|exceed|small/);
  assert.throws(() => encode(m, 5), /small/);
  // Exactly header+question works once all RRsets are gone.
  const bare = encode(m, headerAndQuestion);
  assert.equal(bare.length, headerAndQuestion);
  assert.equal(decode(bare).header.tc, true);
});
