import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decode,
  encode,
  DnsError,
  DnsMessage,
  ResourceRecord,
  RRType,
} from "../src/index";
import { name, pkt } from "./helpers";

function baseMessage(): DnsMessage {
  return {
    header: {
      id: 0xbeef,
      qr: true,
      opcode: 0,
      aa: true,
      tc: false,
      rd: true,
      ra: true,
      z: 0,
      rcode: 0,
    },
    question: { name: name("www", "Example", "com"), qtype: 1, qclass: 1 },
    answers: [],
    authorities: [],
    additionals: [],
  };
}

test("round-trips all seven record types with raw bytes intact", () => {
  const msg = baseMessage();
  msg.answers = [
    {
      name: name("www", "Example", "com"),
      type: RRType.A,
      class: 1,
      ttl: 300,
      rdata: { type: RRType.A, address: Buffer.from([192, 0, 2, 1]) },
    },
    {
      name: name("www", "Example", "com"),
      type: RRType.AAAA,
      class: 1,
      ttl: 300,
      rdata: {
        type: RRType.AAAA,
        address: Buffer.from("20010db8000000000000000000000001", "hex"),
      },
    },
    {
      name: name("alias", "Example", "com"),
      type: RRType.CNAME,
      class: 1,
      ttl: 60,
      rdata: { type: RRType.CNAME, target: name("www", "Example", "com") },
    },
    {
      name: name("Example", "com"),
      type: RRType.MX,
      class: 1,
      ttl: 60,
      rdata: {
        type: RRType.MX,
        preference: 10,
        exchange: name("mail", "Example", "com"),
      },
    },
    {
      name: name("www", "Example", "com"),
      type: RRType.TXT,
      class: 1,
      ttl: 60,
      rdata: {
        type: RRType.TXT,
        strings: [
          Buffer.from("v=spf1 -all", "latin1"),
          Buffer.from([0x00, 0x01, 0xff, 0x2e]),
          Buffer.alloc(0),
        ],
      },
    },
    {
      name: name("4", "3", "2", "1", "in-addr", "arpa"),
      type: RRType.PTR,
      class: 1,
      ttl: 60,
      rdata: { type: RRType.PTR, target: name("host", "Example", "com") },
    },
    {
      name: name("_sip", "_tcp", "Example", "com"),
      type: RRType.SRV,
      class: 1,
      ttl: 60,
      rdata: {
        type: RRType.SRV,
        priority: 1,
        weight: 5,
        port: 5060,
        target: name("sip", "Example", "com"),
      },
    },
  ];
  msg.authorities = [
    {
      name: name("Example", "com"),
      type: RRType.TXT,
      class: 1,
      ttl: 1,
      rdata: { type: RRType.TXT, strings: [Buffer.from("auth", "latin1")] },
    },
  ];
  msg.additionals = [
    {
      name: name("extra", "Example", "com"),
      type: RRType.A,
      class: 1,
      ttl: 2,
      rdata: { type: RRType.A, address: Buffer.from([10, 0, 0, 1]) },
    },
  ];

  const packet = encode(msg);
  // Header counts reflect actual content.
  assert.equal(packet.readUInt16BE(4), 1);
  assert.equal(packet.readUInt16BE(6), 7);
  assert.equal(packet.readUInt16BE(8), 1);
  assert.equal(packet.readUInt16BE(10), 1);

  const back = decode(packet);
  assert.deepEqual(back, msg);
});

test("uses compression pointers for repeated suffixes", () => {
  const msg = baseMessage();
  msg.answers = [
    {
      name: name("www", "Example", "com"),
      type: RRType.A,
      class: 1,
      ttl: 1,
      rdata: { type: RRType.A, address: Buffer.from([1, 1, 1, 1]) },
    },
    {
      name: name("www", "Example", "com"),
      type: RRType.A,
      class: 1,
      ttl: 1,
      rdata: { type: RRType.A, address: Buffer.from([2, 2, 2, 2]) },
    },
  ];
  const packet = encode(msg);
  // The question name occupies 12..29; the first answer owner must be a
  // 2-byte pointer to offset 12 (0xC00C).
  const qnameLen = 1 + 3 + 1 + 7 + 1 + 3 + 1;
  const firstOwner = 12 + qnameLen + 4;
  assert.equal(packet.readUInt16BE(firstOwner), 0xc00c);
  // Second answer owner is also a pointer to offset 12.
  const secondOwner = firstOwner + 2 + 10 + 4;
  assert.equal(packet.readUInt16BE(secondOwner), 0xc00c);
  assert.deepEqual(decode(packet), msg);
});

test("never folds case to share a compression pointer", () => {
  const msg = baseMessage();
  msg.question = { name: name("WWW", "Example", "COM"), qtype: 1, qclass: 1 };
  msg.answers = [
    {
      name: name("www", "Example", "COM"),
      type: RRType.A,
      class: 1,
      ttl: 1,
      rdata: { type: RRType.A, address: Buffer.from([1, 1, 1, 1]) },
    },
  ];
  const packet = encode(msg);
  // Owner must be written as literal 'www' + pointer to 'Example.COM'
  // (offset 16), not as a pointer to the question's 'WWW...'.
  const qnameLen = 1 + 3 + 1 + 7 + 1 + 3 + 1;
  const owner = 12 + qnameLen + 4;
  assert.equal(packet[owner], 3);
  assert.equal(packet.subarray(owner + 1, owner + 4).toString("latin1"), "www");
  assert.equal(packet.readUInt16BE(owner + 4), 0xc000 | 16);
  const back = decode(packet);
  assert.deepEqual(back.answers[0]!.name, name("www", "Example", "COM"));
});

test("SRV target is written without compression", () => {
  const msg = baseMessage();
  msg.answers = [
    {
      name: name("_sip", "_tcp", "Example", "com"),
      type: RRType.SRV,
      class: 1,
      ttl: 1,
      rdata: {
        type: RRType.SRV,
        priority: 0,
        weight: 0,
        port: 5060,
        target: name("www", "Example", "com"),
      },
    },
  ];
  const packet = encode(msg);
  const decoded = decode(packet);
  assert.deepEqual(decoded, msg);
  // Locate the SRV rdata: walk past header + question + owner + fixed 10.
  // The target starts with a literal label length (3, 'www'), not 0xC0.
  const qnameLen = 1 + 3 + 1 + 7 + 1 + 3 + 1;
  let pos = 12 + qnameLen + 4;
  // owner: 04 _sip 04 _tcp + ptr(2)
  pos += 5 + 5 + 2;
  const rdlength = packet.readUInt16BE(pos + 8);
  const rdataStart = pos + 10;
  assert.equal(packet[rdataStart + 6], 3);
  assert.equal(
    packet.subarray(rdataStart + 7, rdataStart + 10).toString("latin1"),
    "www",
  );
  assert.notEqual(packet[rdataStart + 6]! & 0xc0, 0xc0);
  // Full uncompressed target: 6 + (1+3)+(1+7)+(1+3)+1.
  assert.equal(rdlength, 6 + 17);
});

test("rejects unsupported types, bad sizes and oversized names", () => {
  const msg = baseMessage();
  const badType = {
    name: name("www", "Example", "com"),
    type: 99 as RRType,
    class: 1,
    ttl: 1,
    rdata: { type: 99, raw: Buffer.alloc(1) } as never,
  } as ResourceRecord;
  msg.answers = [badType];
  assert.throws(() => encode(msg), DnsError);

  const badA = baseMessage();
  badA.answers = [
    {
      name: name("www", "Example", "com"),
      type: RRType.A,
      class: 1,
      ttl: 1,
      rdata: { type: RRType.A, address: Buffer.from([1, 2, 3]) },
    },
  ];
  assert.throws(() => encode(badA), DnsError);

  const longLabel = baseMessage();
  longLabel.question = { name: [Buffer.alloc(64, 0x61)], qtype: 1, qclass: 1 };
  assert.throws(() => encode(longLabel), DnsError);

  const longName = baseMessage();
  longName.question = {
    name: Array.from({ length: 4 }, () => Buffer.alloc(63, 0x62)),
    qtype: 1,
    qclass: 1,
  };
  assert.throws(() => encode(longName), DnsError);

  const longTxt = baseMessage();
  longTxt.answers = [
    {
      name: name("www", "Example", "com"),
      type: RRType.TXT,
      class: 1,
      ttl: 1,
      rdata: { type: RRType.TXT, strings: [Buffer.alloc(256)] },
    },
  ];
  assert.throws(() => encode(longTxt), DnsError);
});

test("fails when header plus question cannot fit", () => {
  const msg = baseMessage();
  assert.throws(() => encode(msg, 10), DnsError);
  assert.throws(() => encode(msg, 12 + 17 + 4 - 1), DnsError);
  // Exactly header + question fits.
  const exact = encode(msg, 12 + 17 + 4);
  assert.equal(exact.length, 12 + 17 + 4);
  assert.deepEqual(decode(exact), msg);
});

test("decodes a packet encoded from a minimal query", () => {
  const msg: DnsMessage = {
    header: {
      id: 1,
      qr: false,
      opcode: 0,
      aa: false,
      tc: false,
      rd: true,
      ra: false,
      z: 0,
      rcode: 0,
    },
    question: { name: name("example", "com"), qtype: 1, qclass: 1 },
    answers: [],
    authorities: [],
    additionals: [],
  };
  const packet = encode(msg);
  assert.equal(packet.length, 12 + 13 + 4);
  assert.equal(packet.readUInt16BE(0), 1);
  assert.equal(packet.readUInt16BE(2), 0x0100);
  assert.deepEqual(decode(packet), msg);
});
