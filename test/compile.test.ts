import { test } from "node:test";
import assert from "node:assert/strict";
import { compile, decide, type Rule, type Route } from "../src/index.js";
import { formatCidr, parseAddress } from "../src/address.js";

function referenceDecide(groups: Rule[][], address: string): Route {
  for (const group of groups) {
    let best: Rule | null = null;
    let bestLen = -1;
    for (const rule of group) {
      const slash = rule.cidr.lastIndexOf("/");
      const len = Number(rule.cidr.slice(slash + 1));
      if (len <= bestLen) continue;
      if (matches(rule.cidr, address)) {
        best = rule;
        bestLen = len;
      }
    }
    if (best !== null && (best as Rule).route === "tunnel") return "tunnel";
  }
  return "direct";
}

function matches(cidr: string, address: string): boolean {
  return decide([{ cidr, route: "tunnel" }], address) === "tunnel";
}

function assertConsistent(groups: Rule[][], addresses: string[]): void {
  const table = compile(groups);
  for (const address of addresses) {
    assert.equal(
      decide(table, address),
      referenceDecide(groups, address),
      "mismatch for " + address,
    );
  }
}

test("empty input yields empty table and direct default", () => {
  assert.deepEqual(compile([]), []);
  assert.deepEqual(compile([[]]), []);
  assert.equal(decide([], "1.2.3.4"), "direct");
  assert.equal(decide([], "::1"), "direct");
});

test("same group: three levels of nested exceptions", () => {
  const groups: Rule[][] = [
    [
      { cidr: "10.0.0.0/8", route: "tunnel" },
      { cidr: "10.1.0.0/16", route: "direct" },
      { cidr: "10.1.2.0/24", route: "tunnel" },
      { cidr: "10.1.2.128/25", route: "direct" },
    ],
  ];
  const table = compile(groups);
  const cases: [string, Route][] = [
    ["9.255.255.255", "direct"],
    ["10.0.0.0", "tunnel"],
    ["10.0.255.255", "tunnel"],
    ["10.1.0.0", "direct"],
    ["10.1.1.255", "direct"],
    ["10.1.2.0", "tunnel"],
    ["10.1.2.127", "tunnel"],
    ["10.1.2.128", "direct"],
    ["10.1.2.255", "direct"],
    ["10.1.3.0", "direct"],
    ["10.1.255.255", "direct"],
    ["10.2.0.0", "tunnel"],
    ["10.255.255.255", "tunnel"],
    ["11.0.0.0", "direct"],
  ];
  for (const [address, expected] of cases) {
    assert.equal(decide(table, address), expected, address);
  }
  assertConsistent(groups, cases.map(([a]) => a));
});

test("cross-group: direct of another group cannot punch a hole, tunnel covers part of a direct hole", () => {
  const groups: Rule[][] = [
    [
      { cidr: "10.0.0.0/8", route: "tunnel" },
      { cidr: "10.1.0.0/16", route: "direct" },
    ],
    [
      { cidr: "10.1.2.0/24", route: "tunnel" },
      { cidr: "10.2.0.0/16", route: "direct" },
    ],
  ];
  const table = compile(groups);
  const cases: [string, Route][] = [
    // inside group A tunnel, group B direct must not override
    ["10.2.0.0", "tunnel"],
    ["10.2.255.255", "tunnel"],
    ["10.3.0.0", "tunnel"],
    // group B tunnel covers part of group A's direct hole
    ["10.1.1.255", "direct"],
    ["10.1.2.0", "tunnel"],
    ["10.1.2.255", "tunnel"],
    ["10.1.3.0", "direct"],
    ["10.1.255.255", "direct"],
    // hole edges
    ["10.0.255.255", "tunnel"],
    ["10.1.0.0", "direct"],
    // outside everything
    ["192.168.0.1", "direct"],
  ];
  for (const [address, expected] of cases) {
    assert.equal(decide(table, address), expected, address);
  }
  assertConsistent(groups, cases.map(([a]) => a));
});

test("compiled table is minimal for a simple nested case", () => {
  const table = compile([
    [
      { cidr: "10.0.0.0/8", route: "tunnel" },
      { cidr: "10.1.0.0/16", route: "direct" },
    ],
  ]);
  assert.deepEqual(
    [...table].sort((a, b) => a.cidr.localeCompare(b.cidr)),
    [
      { cidr: "10.0.0.0/8", route: "tunnel" },
      { cidr: "10.1.0.0/16", route: "direct" },
    ],
  );
});

test("ipv6: /0, /127 and /128 with nested exceptions across groups", () => {
  const groups: Rule[][] = [
    [
      { cidr: "::/0", route: "tunnel" },
      { cidr: "2001:db8::/32", route: "direct" },
    ],
    [
      { cidr: "2001:db8:ffff::/48", route: "tunnel" },
      { cidr: "2001:db8:ffff:ffff:ffff:ffff:ffff:fffe/127", route: "direct" },
      { cidr: "2001:db8:ffff:ffff:ffff:ffff:ffff:ffff/128", route: "tunnel" },
    ],
  ];
  const table = compile(groups);
  const cases: [string, Route][] = [
    ["::", "tunnel"],
    ["::1", "tunnel"],
    ["ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "tunnel"],
    // group A direct hole
    ["2001:db8::", "direct"],
    ["2001:db8:fffe:ffff:ffff:ffff:ffff:ffff", "direct"],
    // group B tunnel inside the hole
    ["2001:db8:ffff::", "tunnel"],
    ["2001:db8:ffff:ffff:ffff:ffff:ffff:fffd", "tunnel"],
    // /127 direct hole inside group B tunnel
    ["2001:db8:ffff:ffff:ffff:ffff:ffff:fffe", "direct"],
    // /128 tunnel inside the /127 direct hole
    ["2001:db8:ffff:ffff:ffff:ffff:ffff:ffff", "tunnel"],
    // just outside the /48
    ["2001:db8:fffe::", "direct"],
    ["2001:db8:1::", "direct"],
  ];
  for (const [address, expected] of cases) {
    assert.equal(decide(table, address), expected, address);
  }
  assertConsistent(groups, cases.map(([a]) => a));
});

test("ipv4 and ipv6 families are independent", () => {
  const groups: Rule[][] = [
    [{ cidr: "0.0.0.0/0", route: "tunnel" }],
    [{ cidr: "::/0", route: "direct" }],
  ];
  const table = compile(groups);
  assert.equal(decide(table, "8.8.8.8"), "tunnel");
  assert.equal(decide(table, "2606:4700:4700::1111"), "direct");
});

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomIpv4(rand: () => number): string {
  const octets = [0, 0, 0, 0].map(() => Math.floor(rand() * 256));
  return octets.join(".");
}

function randomIpv6(rand: () => number): string {
  const groups = [0, 0, 0, 0, 0, 0, 0, 0].map(() =>
    Math.floor(rand() * 65536).toString(16),
  );
  return groups.join(":");
}

function randomCidr(rand: () => number, family: 4 | 6): string {
  const bits = family === 4 ? 32 : 128;
  const len = Math.floor(rand() * (bits + 1));
  const address = family === 4 ? randomIpv4(rand) : randomIpv6(rand);
  const { value } = parseAddress(address);
  const mask = len === 0 ? 0n : ((1n << BigInt(len)) - 1n) << BigInt(bits - len);
  return formatCidr(family, value & mask, len);
}

test("randomized differential test: compiled table matches per-group evaluation", () => {
  const rand = mulberry32(20261009);
  for (let round = 0; round < 50; round++) {
    const groupCount = 1 + Math.floor(rand() * 3);
    const groups: Rule[][] = [];
    for (let g = 0; g < groupCount; g++) {
      const rules: Rule[] = [];
      const seen = new Set<string>();
      const ruleCount = Math.floor(rand() * 6);
      for (let r = 0; r < ruleCount; r++) {
        const family = rand() < 0.5 ? 4 : 6;
        const cidr = randomCidr(rand, family);
        if (seen.has(cidr)) continue;
        seen.add(cidr);
        rules.push({ cidr, route: rand() < 0.5 ? "tunnel" : "direct" });
      }
      groups.push(rules);
    }
    const addresses: string[] = [];
    for (let a = 0; a < 40; a++) {
      addresses.push(rand() < 0.5 ? randomIpv4(rand) : randomIpv6(rand));
    }
    // also probe the network/broadcast edges of every rule
    for (const group of groups) {
      for (const rule of group) {
        addresses.push(rule.cidr.slice(0, rule.cidr.lastIndexOf("/")));
      }
    }
    assertConsistent(groups, addresses);
  }
});
