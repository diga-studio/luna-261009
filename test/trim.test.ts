import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decode,
  encode,
  DnsMessage,
  ResourceRecord,
  RRType,
} from "../src/index";
import { name, nameText } from "./helpers";

function header(tc = false): DnsMessage["header"] {
  return {
    id: 0x42,
    qr: true,
    opcode: 0,
    aa: false,
    tc,
    rd: true,
    ra: true,
    z: 0,
    rcode: 0,
  };
}

function aRecord(owner: ReturnType<typeof name>, addr: number[]): ResourceRecord {
  return {
    name: owner,
    type: RRType.A,
    class: 1,
    ttl: 300,
    rdata: { type: RRType.A, address: Buffer.from(addr) },
  };
}

test("interleaved RRsets: later set removed whole, kept records intact", () => {
  // Answers interleave two A RRsets (x.q.com, y.q.com) and a TXT singleton
  // whose owner sub.y.q.com compresses against y.q.com written by the set
  // that will be removed.
  const txtRecord: ResourceRecord = {
    name: name("sub", "y", "q", "com"),
    type: RRType.TXT,
    class: 1,
    ttl: 60,
    rdata: {
      type: RRType.TXT,
      strings: [Buffer.from("keep me", "latin1"), Buffer.from([0, 1, 255])],
    },
  };
  const msg: DnsMessage = {
    header: header(),
    question: { name: name("q", "com"), qtype: 1, qclass: 1 },
    answers: [
      aRecord(name("x", "q", "com"), [1, 1, 1, 1]),
      aRecord(name("y", "q", "com"), [2, 2, 2, 2]),
      txtRecord,
      aRecord(name("x", "q", "com"), [1, 1, 1, 2]),
      aRecord(name("y", "q", "com"), [2, 2, 2, 3]),
    ],
    authorities: [],
    additionals: [],
  };

  const full = encode(msg);
  assert.equal(full.readUInt16BE(6), 5);
  // Sanity: without trimming the TXT owner really does use a compression
  // pointer to the y.q.com written by the second answer.
  const decoded = decode(full);
  assert.equal(nameText(decoded.answers[2]!.name), "sub.y.q.com");

  // Force exactly one RRset out: the y.q.com set has the latest last
  // occurrence, so it must go first, as a whole.
  const trimmed = encode(msg, full.length - 1);
  assert.ok(trimmed.length < full.length);

  // TC bit set in the raw flags, answer count is 3.
  const flags = trimmed.readUInt16BE(2);
  assert.equal((flags & 0x0200) !== 0, true);
  assert.equal(trimmed.readUInt16BE(6), 3);

  const out = decode(trimmed);
  assert.equal(out.header.tc, true);
  assert.equal(out.answers.length, 3);
  // Both y.q.com A records are gone; nothing of the set remains.
  assert.ok(
    out.answers.every((r) => nameText(r.name) !== "y.q.com"),
  );
  // Kept records keep their relative order and exact content.
  assert.equal(nameText(out.answers[0]!.name), "x.q.com");
  assert.deepEqual(out.answers[0]!.rdata, {
    type: RRType.A,
    address: Buffer.from([1, 1, 1, 1]),
  });
  assert.equal(nameText(out.answers[1]!.name), "sub.y.q.com");
  assert.deepEqual(out.answers[1]!.rdata, {
    type: RRType.TXT,
    strings: [Buffer.from("keep me", "latin1"), Buffer.from([0, 1, 255])],
  });
  assert.equal(nameText(out.answers[2]!.name), "x.q.com");
  assert.deepEqual(out.answers[2]!.rdata, {
    type: RRType.A,
    address: Buffer.from([1, 1, 1, 2]),
  });
  // The kept TXT owner lost its old compression target; the re-encoded
  // packet must still decode to the same name (verified above) and every
  // pointer in it must be valid, which decode() enforces.
});

test("trims Additional before Authority before Answer", () => {
  const msg: DnsMessage = {
    header: header(),
    question: { name: name("q", "com"), qtype: 1, qclass: 1 },
    answers: [aRecord(name("a", "q", "com"), [1, 0, 0, 1])],
    authorities: [
      {
        name: name("ns", "q", "com"),
        type: RRType.PTR,
        class: 1,
        ttl: 1,
        rdata: { type: RRType.PTR, target: name("q", "com") },
      },
    ],
    additionals: [
      aRecord(name("extra", "q", "com"), [9, 9, 9, 9]),
      aRecord(name("extra", "q", "com"), [9, 9, 9, 8]),
    ],
  };
  const full = encode(msg);
  const trimmed = encode(msg, full.length - 1);
  const out = decode(trimmed);
  // Only the additional RRset (both members) was removed.
  assert.equal(out.additionals.length, 0);
  assert.equal(out.authorities.length, 1);
  assert.equal(out.answers.length, 1);
  assert.equal(trimmed.readUInt16BE(10), 0);
  assert.equal(trimmed.readUInt16BE(8), 1);
  assert.equal(trimmed.readUInt16BE(6), 1);
  assert.equal(out.header.tc, true);
});

test("preserves TC when nothing is removed", () => {
  const msg: DnsMessage = {
    header: header(true),
    question: { name: name("q", "com"), qtype: 1, qclass: 1 },
    answers: [aRecord(name("a", "q", "com"), [1, 0, 0, 1])],
    authorities: [],
    additionals: [],
  };
  const out = decode(encode(msg));
  assert.equal(out.header.tc, true);

  const msg2 = { ...msg, header: header(false) };
  const out2 = decode(encode(msg2));
  assert.equal(out2.header.tc, false);
});

test("removes multiple RRsets until the message fits, then stops", () => {
  const msg: DnsMessage = {
    header: header(),
    question: { name: name("q", "com"), qtype: 1, qclass: 1 },
    answers: [],
    authorities: [],
    additionals: [
      aRecord(name("one", "q", "com"), [1, 1, 1, 1]),
      aRecord(name("two", "q", "com"), [2, 2, 2, 2]),
      aRecord(name("three", "q", "com"), [3, 3, 3, 3]),
    ],
  };
  const full = encode(msg);
  // Budget that only fits after dropping two of the three singleton sets
  // (each record is 2+10+4 = 16 bytes after the first writes its name).
  const perRecord = 16;
  const budget = full.length - 2 * perRecord - 1;
  const trimmed = encode(msg, budget);
  const out = decode(trimmed);
  // 'three' (latest last occurrence) goes first, then 'two'.
  assert.equal(out.additionals.length, 1);
  assert.equal(nameText(out.additionals[0]!.name), "one.q.com");
  assert.equal(out.header.tc, true);
});

test("repeated name beyond the 16KiB pointer range stays correct", () => {
  const msg: DnsMessage = {
    header: header(),
    question: { name: name("start", "example"), qtype: 1, qclass: 1 },
    answers: [],
    authorities: [],
    additionals: [],
  };
  // Push the offset past 16383 with unique-owner TXT records.
  for (let i = 0; i < 70; i++) {
    msg.answers.push({
      name: name(`pad${i}`, "example"),
      type: RRType.TXT,
      class: 1,
      ttl: 0,
      rdata: { type: RRType.TXT, strings: [Buffer.alloc(250, i & 0xff)] },
    });
  }
  // This name appears for the first time beyond offset 16383...
  msg.answers.push(aRecord(name("repeat", "example"), [7, 7, 7, 7]));
  // ...and is repeated again later, where no pointer can reach the first
  // occurrence.
  msg.answers.push(aRecord(name("repeat", "example"), [7, 7, 7, 8]));

  const packet = encode(msg);
  assert.ok(packet.length > 16384, `packet is ${packet.length} bytes`);

  // The label 'repeat' must appear literally somewhere beyond 16383:
  // the second occurrence cannot be a pointer to the first.
  const repeatLabel = Buffer.concat([
    Buffer.from([6]),
    Buffer.from("repeat", "latin1"),
  ]);
  const firstIdx = packet.indexOf(repeatLabel);
  assert.ok(firstIdx > 16383, `first 'repeat' label at ${firstIdx}`);
  const secondIdx = packet.indexOf(repeatLabel, firstIdx + 1);
  assert.ok(secondIdx > firstIdx, "second occurrence written literally");

  const out = decode(packet);
  assert.equal(out.answers.length, 72);
  const last = out.answers[71]!;
  assert.equal(nameText(last.name), "repeat.example");
  assert.deepEqual(last.rdata, {
    type: RRType.A,
    address: Buffer.from([7, 7, 7, 8]),
  });
  const prev = out.answers[70]!;
  assert.equal(nameText(prev.name), "repeat.example");
  // All padding records survive with their exact byte content.
  for (let i = 0; i < 70; i++) {
    const r = out.answers[i]!;
    assert.equal(nameText(r.name), `pad${i}.example`);
    if (r.rdata.type === RRType.TXT) {
      assert.deepEqual(r.rdata.strings, [Buffer.alloc(250, i & 0xff)]);
    } else {
      assert.fail("expected TXT");
    }
  }
});
