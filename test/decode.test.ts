import { test } from "node:test";
import assert from "node:assert/strict";
import { decode, DnsError, RRType } from "../src/index";
import { name, nameText, pkt } from "./helpers";

// Handwritten packet with nested compression pointers.
// 12: question www.example.com A IN
// 33: answer  A     www.example.com(ptr 12)  1.2.3.4
// 49: answer  MX    mail.example.com(mail + ptr 16) pref 10, exchange ptr 12
// 70: additional PTR owner ptr 49 (nested: points to a name that itself
//     contains a pointer), target ptr 12
const NESTED = pkt(`
  1234 8180 0001 0002 0000 0001
  03 777777 07 6578616d706c65 03 636f6d 00
  0001 0001
  c00c 0001 0001 0000012c 0004 01020304
  04 6d61696c c010 000f 0001 0000012c 0004 000a c00c
  c031 000c 0001 00000000 0002 c00c
`);

test("decodes handwritten packet with nested compression pointers", () => {
  const msg = decode(NESTED);
  assert.equal(msg.header.id, 0x1234);
  assert.equal(msg.header.qr, true);
  assert.equal(msg.header.rd, true);
  assert.equal(msg.header.ra, true);
  assert.equal(msg.header.tc, false);
  assert.equal(msg.header.rcode, 0);
  assert.equal(nameText(msg.question.name), "www.example.com");
  assert.equal(msg.question.qtype, 1);
  assert.equal(msg.question.qclass, 1);

  assert.equal(msg.answers.length, 2);
  const a = msg.answers[0]!;
  assert.equal(nameText(a.name), "www.example.com");
  assert.equal(a.type, RRType.A);
  assert.equal(a.ttl, 300);
  assert.deepEqual(a.rdata, { type: RRType.A, address: Buffer.from([1, 2, 3, 4]) });

  const mx = msg.answers[1]!;
  assert.equal(nameText(mx.name), "mail.example.com");
  assert.equal(mx.type, RRType.MX);
  assert.deepEqual(mx.rdata, {
    type: RRType.MX,
    preference: 10,
    exchange: name("www", "example", "com"),
  });

  assert.equal(msg.authorities.length, 0);
  assert.equal(msg.additionals.length, 1);
  const ptr = msg.additionals[0]!;
  assert.equal(nameText(ptr.name), "mail.example.com");
  assert.equal(ptr.type, RRType.PTR);
  assert.deepEqual(ptr.rdata, {
    type: RRType.PTR,
    target: name("www", "example", "com"),
  });
});

test("label bytes with dots, zero bytes and non-ASCII survive decoding", () => {
  const packet = pkt(`
    0001 0000 0001 0000 0000 0000
    03 002eff 00
    0001 0001
  `);
  const msg = decode(packet);
  assert.deepEqual(msg.question.name, [Buffer.from([0x00, 0x2e, 0xff])]);
});

test("rejects self-referencing compression pointer", () => {
  const packet = pkt(`
    0001 0000 0001 0000 0000 0000
    c00c
    0001 0001
  `);
  assert.throws(() => decode(packet), DnsError);
});

test("rejects forward compression pointer", () => {
  const packet = pkt(`
    0001 0000 0001 0000 0000 0000
    c010 0001 0001
    01 61 00
  `);
  assert.throws(() => decode(packet), DnsError);
});

test("rejects pointer loop across two offsets", () => {
  // name at 12: 'a' + ptr 16; bytes at 16: ptr 14 (offset 14 holds c0,
  // 17 holds 0e -> 14 points at the c0 of the first pointer) — both
  // pointers reference earlier offsets, but following them cycles.
  const packet = pkt(`
    0001 0000 0001 0000 0000 0000
    01 61 c010
    0001 0001
  `);
  // offset 16 is inside the question fixed fields; craft explicitly:
  // 12: 01 61 c0 10 -> ptr to 16; 16: 00 01 ... not a pointer. Use a
  // dedicated layout instead: question name ptr 14, at 14: ptr 12.
  const loop = pkt(`
    0001 0000 0001 0000 0000 0000
    c00e c00c
    0001 0001
  `);
  assert.throws(() => decode(packet), DnsError);
  assert.throws(() => decode(loop), DnsError);
});

test("rejects illegal label marker bits", () => {
  const packet = pkt(`
    0001 0000 0001 0000 0000 0000
    40 6161 00
    0001 0001
  `);
  assert.throws(() => decode(packet), DnsError);
});

test("rejects A record with wrong RDLENGTH", () => {
  const packet = pkt(`
    0001 8180 0001 0001 0000 0000
    03 777777 07 6578616d706c65 03 636f6d 00
    0001 0001
    c00c 0001 0001 00000000 0005 0102030405
  `);
  assert.throws(() => decode(packet), DnsError);
});

test("rejects RDLENGTH overrunning the packet", () => {
  const packet = pkt(`
    0001 8180 0001 0001 0000 0000
    03 777777 07 6578616d706c65 03 636f6d 00
    0001 0001
    c00c 0001 0001 00000000 0006 01020304
  `);
  assert.throws(() => decode(packet), DnsError);
});

test("rejects CNAME RDATA whose name length disagrees with RDLENGTH", () => {
  const packet = pkt(`
    0001 8180 0001 0001 0000 0000
    03 777777 07 6578616d706c65 03 636f6d 00
    0001 0001
    c00c 0005 0001 00000000 0003 c00c
  `);
  assert.throws(() => decode(packet), DnsError);
});

test("rejects TXT segment overrunning RDATA", () => {
  const packet = pkt(`
    0001 8180 0001 0001 0000 0000
    03 777777 07 6578616d706c65 03 636f6d 00
    0001 0001
    c00c 0010 0001 00000000 0003 054141
  `);
  assert.throws(() => decode(packet), DnsError);
});

test("rejects truncated header, missing question and unsupported types", () => {
  assert.throws(() => decode(pkt("0001 0000 00")), DnsError);
  assert.throws(
    () => decode(pkt("0001 0000 0000 0000 0000 0000")),
    DnsError,
  );
  const unsupported = pkt(`
    0001 8180 0001 0001 0000 0000
    03 777777 07 6578616d706c65 03 636f6d 00
    0001 0001
    c00c 0063 0001 00000000 0001 00
  `);
  assert.throws(() => decode(unsupported), DnsError);
});

test("rejects expanded name longer than 255 bytes", () => {
  // question name: long label chain, then a pointer back to 12 making the
  // expansion exceed 255 bytes.
  const label = "3f" + "61".repeat(63);
  const parts = [label, label, label, label];
  const qname = parts.join(" ") + " c00c";
  const packet = pkt(`
    0001 0000 0001 0000 0000 0000
    ${qname}
    0001 0001
  `);
  assert.throws(() => decode(packet), DnsError);
});
