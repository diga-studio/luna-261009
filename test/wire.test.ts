import test from "node:test";
import assert from "node:assert/strict";
import { decode, RRType } from "../src/index";

function header(id: number, flags: number, qd: number, an: number, ns: number, ar: number): number[] {
  return [
    id >> 8, id & 0xff, flags >> 8, flags & 0xff,
    qd >> 8, qd & 0xff, an >> 8, an & 0xff,
    ns >> 8, ns & 0xff, ar >> 8, ar & 0xff,
  ];
}

function label(text: string): number[] {
  return [text.length, ...[...text].map((ch) => ch.charCodeAt(0))];
}

// Hand-assembled packet with nested compression pointers.
// Offset map:
//  12: qname 3www 7example 3com 0   ("www"@13, "example"@17, "com"@25, root@28)
//  29: qtype/qclass
//  33: answer owner = ptr->12
//  45: answer rdata = 3cdn ptr->16   ("cdn"@46, nested ptr->16 "example")
//  51: additional owner = 3sub ptr->45 (pointer to a name that itself ends in a pointer)
function nestedPointerPacket(): Uint8Array {
  const bytes: number[] = [
    ...header(0x0042, 0x8180, 1, 1, 0, 1),
    ...label("www"), ...label("example"), ...label("com"), 0,
    0, RRType.A, 0, 1,
    // answer: CNAME www.example.com -> cdn.example.com
    0xc0, 0x0c,
    0, RRType.CNAME, 0, 1, 0, 0, 0, 60, 0, 6,
    ...label("cdn"), 0xc0, 0x10,
    // additional: A sub.cdn.example.com -> 127.0.0.1
    ...label("sub"), 0xc0, 0x2d,
    0, RRType.A, 0, 1, 0, 0, 0, 0, 0, 4,
    127, 0, 0, 1,
  ];
  // Sanity-check the hand-computed offsets.
  assert.equal(bytes.length, 71);
  assert.equal(bytes[12], 3);
  assert.equal(bytes[16], 7);
  assert.equal(bytes[33], 0xc0);
  assert.equal(bytes[45], 3);
  assert.equal(bytes[49], 0xc0);
  assert.equal(bytes[51], 3);
  assert.equal(bytes[55], 0xc0);
  return Uint8Array.from(bytes);
}

test("decodes nested compression pointers exactly", () => {
  const msg = decode(nestedPointerPacket());
  const text = (labels: Uint8Array[]) => labels.map((l) => String.fromCharCode(...l)).join(".");
  assert.equal(msg.header.id, 0x42);
  assert.equal(text(msg.question.qname), "www.example.com");
  assert.equal(msg.answers.length, 1);
  assert.equal(msg.answers[0]!.type, RRType.CNAME);
  assert.equal(text(msg.answers[0]!.name), "www.example.com");
  assert.equal(text((msg.answers[0]!.rdata as { cname: Uint8Array[] }).cname), "cdn.example.com");
  assert.equal(msg.additionals.length, 1);
  assert.equal(text(msg.additionals[0]!.name), "sub.cdn.example.com");
  assert.deepEqual(msg.additionals[0]!.rdata, { kind: "A", address: "127.0.0.1" });
});

test("rejects a compression pointer that targets itself", () => {
  const packet = Uint8Array.from([
    ...header(1, 0x0100, 1, 0, 0, 0),
    0xc0, 0x0c, // qname points at its own offset
    0, 1, 0, 1,
  ]);
  assert.throws(() => decode(packet), /pointer/);
});

test("rejects a forward pointer loop between two offsets", () => {
  const packet = Uint8Array.from([
    ...header(1, 0x0100, 1, 0, 0, 0),
    0xc0, 0x0e, // 12 -> 14
    0xc0, 0x0c, // 14 -> 12
    0, 1, 0, 1,
  ]);
  assert.throws(() => decode(packet), /pointer/);
});

test("rejects invalid label marker bits", () => {
  const packet = Uint8Array.from([
    ...header(1, 0x0100, 1, 0, 0, 0),
    0x40, 0x00, 0, // 0x40 marker is reserved
    0, 1, 0, 1,
  ]);
  assert.throws(() => decode(packet), /marker/);
});

test("rejects an A record with wrong RDLENGTH", () => {
  const packet = Uint8Array.from([
    ...header(1, 0x8180, 1, 1, 0, 0),
    ...label("a"), 0, 0, 1, 0, 1,
    0xc0, 0x0c, 0, RRType.A, 0, 1, 0, 0, 0, 0, 0, 5,
    1, 2, 3, 4, 5,
  ]);
  assert.throws(() => decode(packet), /RDLENGTH/);
});

test("rejects a CNAME whose RDATA does not fill RDLENGTH", () => {
  const packet = Uint8Array.from([
    ...header(1, 0x8180, 1, 1, 0, 0),
    ...label("a"), 0, 0, 1, 0, 1,
    0xc0, 0x0c, 0, RRType.CNAME, 0, 1, 0, 0, 0, 0, 0, 3,
    0xc0, 0x0c, 0, // name takes 2 bytes, RDLENGTH claims 3
  ]);
  assert.throws(() => decode(packet), /RDLENGTH/);
});

test("rejects RDATA running past the end of the packet", () => {
  const packet = Uint8Array.from([
    ...header(1, 0x8180, 1, 1, 0, 0),
    ...label("a"), 0, 0, 1, 0, 1,
    0xc0, 0x0c, 0, RRType.A, 0, 1, 0, 0, 0, 0, 0, 4,
    1, 2, // only 2 of 4 bytes present
  ]);
  assert.throws(() => decode(packet), /past end/);
});

test("rejects a TXT segment that overruns RDLENGTH", () => {
  const packet = Uint8Array.from([
    ...header(1, 0x8180, 1, 1, 0, 0),
    ...label("a"), 0, 0, 1, 0, 1,
    0xc0, 0x0c, 0, RRType.TXT, 0, 1, 0, 0, 0, 0, 0, 3,
    5, 65, 66, // segment claims 5 bytes, only 2 remain
  ]);
  assert.throws(() => decode(packet), /TXT/);
});

test("rejects an over-long name expanded through pointers", () => {
  // qname at offset 12: one 63-byte label + root (65 bytes expanded).
  // Answer owner: three 63-byte labels + pointer to offset 12, expanding to
  // 64*3 + 65 = 257 bytes, which exceeds the 255-byte limit.
  const qname = [63, ...new Array(63).fill(0x61), 0];
  const owner = [
    63, ...new Array(63).fill(0x62),
    63, ...new Array(63).fill(0x63),
    63, ...new Array(63).fill(0x64),
    0xc0, 0x0c,
  ];
  const packet = Uint8Array.from([
    ...header(1, 0x8180, 1, 1, 0, 0),
    ...qname, 0, 1, 0, 1,
    ...owner, 0, RRType.A, 0, 1, 0, 0, 0, 0, 0, 4, 1, 2, 3, 4,
  ]);
  assert.throws(() => decode(packet), /255/);
});
