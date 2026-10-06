import { test } from "node:test";
import { equal } from "node:assert/strict";
import { compile } from "../src/compile";
import { decide } from "../src/decide";
import type { Group } from "../src/types";
import { referenceDecide } from "./reference";

// Group A: three levels of nested exceptions.
//   10.0.0.0/8      tunnel
//   10.1.0.0/16     direct   (hole in the tunnel)
//   10.1.2.0/24     tunnel   (exception inside the hole)
//   10.1.2.128/25   direct   (exception inside the exception)
const groupA: Group = [
  { cidr: "10.0.0.0/8", route: "tunnel" },
  { cidr: "10.1.0.0/16", route: "direct" },
  { cidr: "10.1.2.0/24", route: "tunnel" },
  { cidr: "10.1.2.128/25", route: "direct" },
];

// Group B: tunnels only the lower half of A's /16 direct hole.
const groupB: Group = [{ cidr: "10.1.0.0/17", route: "tunnel" }];

test("ipv4: nested exceptions within a single group", () => {
  const table = compile([groupA]);
  const cases: Array<[string, string]> = [
    // Outside any rule and outside the /8.
    ["9.255.255.255", "direct"],
    ["11.0.0.0", "direct"],
    // /8 tunnel, including both boundary addresses.
    ["10.0.0.0", "tunnel"],
    ["10.0.255.255", "tunnel"],
    ["10.255.255.255", "tunnel"],
    // /16 direct hole, including boundaries.
    ["10.1.0.0", "direct"],
    ["10.1.1.255", "direct"],
    ["10.1.3.0", "direct"],
    ["10.1.255.255", "direct"],
    // Just outside the hole is tunnel again.
    ["10.2.0.0", "tunnel"],
    // /24 tunnel exception inside the hole, including boundaries.
    ["10.1.2.0", "tunnel"],
    ["10.1.2.127", "tunnel"],
    // /25 direct exception inside the /24, including boundaries.
    ["10.1.2.128", "direct"],
    ["10.1.2.200", "direct"],
    ["10.1.2.255", "direct"],
  ];
  for (const [address, expected] of cases) {
    equal(decide(table, address), expected, `decide(${address})`);
    equal(referenceDecide([groupA], address), expected, `reference(${address})`);
  }
});

test("ipv4: another group's tunnel covers part of the direct hole", () => {
  const groups = [groupA, groupB];
  const table = compile(groups);
  const cases: Array<[string, string]> = [
    // Lower half of the /16 hole: A says direct, B says tunnel -> tunnel.
    ["10.1.0.0", "tunnel"],
    ["10.1.0.1", "tunnel"],
    ["10.1.127.255", "tunnel"],
    // Upper half of the hole: only A's direct applies -> direct.
    ["10.1.128.0", "direct"],
    ["10.1.200.50", "direct"],
    ["10.1.255.255", "direct"],
    // A's /24 tunnel exception sits inside B's /17 -> tunnel.
    ["10.1.2.0", "tunnel"],
    ["10.1.2.127", "tunnel"],
    // A's innermost /25 direct hole cannot override B's tunnel.
    ["10.1.2.128", "tunnel"],
    ["10.1.2.255", "tunnel"],
    // Outside the hole entirely.
    ["10.2.0.0", "tunnel"],
    ["10.255.255.255", "tunnel"],
    ["11.0.0.0", "direct"],
  ];
  for (const [address, expected] of cases) {
    equal(decide(table, address), expected, `decide(${address})`);
    equal(referenceDecide(groups, address), expected, `reference(${address})`);
  }
});

test("ipv4: compiled table matches per-group evaluation on a boundary sweep", () => {
  const groups = [groupA, groupB];
  const table = compile(groups);
  const octets = [0, 1, 2, 126, 127, 128, 129, 254, 255];
  for (const third of octets) {
    for (const fourth of octets) {
      const address = `10.1.${third}.${fourth}`;
      equal(
        decide(table, address),
        referenceDecide(groups, address),
        `mismatch at ${address}`,
      );
    }
  }
});

// Group C: tunnel everything, carve out 2001:db8::/32.
// Group D: re-tunnel one /48 inside that carve-out.
const groupC: Group = [
  { cidr: "::/0", route: "tunnel" },
  { cidr: "2001:db8::/32", route: "direct" },
];
const groupD: Group = [{ cidr: "2001:db8:ffff::/48", route: "tunnel" }];

// Group E: /127 and /128 exceptions inside a /64.
const groupE: Group = [
  { cidr: "2001:db8:1::/64", route: "tunnel" },
  { cidr: "2001:db8:1::fffe/127", route: "direct" },
  { cidr: "2001:db8:1::ffff/128", route: "tunnel" },
];

test("ipv6: /0 default tunnel with a /32 hole and a /48 exception", () => {
  const groups = [groupC, groupD];
  const table = compile(groups);
  const cases: Array<[string, string]> = [
    // /0 tunnel covers everything else.
    ["::", "tunnel"],
    ["::1", "tunnel"],
    ["2001:db7:ffff::1", "tunnel"],
    ["ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "tunnel"],
    // /32 direct hole, including both boundaries.
    ["2001:db8::", "direct"],
    ["2001:db8:1:2:3:4:5:6", "direct"],
    ["2001:db8:ffff:ffff:ffff:ffff:ffff:ffff", "tunnel"], // /48 exception
    ["2001:db8:fffe:ffff:ffff:ffff:ffff:ffff", "direct"], // just below /48
    ["2001:db8:ffff::", "tunnel"], // /48 lower boundary
    // Just outside the /32 hole.
    ["2001:db7:ffff:ffff:ffff:ffff:ffff:ffff", "tunnel"],
    ["2001:db9::", "tunnel"],
  ];
  for (const [address, expected] of cases) {
    equal(decide(table, address), expected, `decide(${address})`);
    equal(referenceDecide(groups, address), expected, `reference(${address})`);
  }
});

test("ipv6: /127 and /128 exceptions inside a /64", () => {
  const table = compile([groupE]);
  const cases: Array<[string, string]> = [
    ["2001:db8:1::", "tunnel"], // /64 lower boundary
    ["2001:db8:1::1", "tunnel"],
    ["2001:db8:1::fffd", "tunnel"], // just below the /127 hole
    ["2001:db8:1::fffe", "direct"], // /127 lower boundary
    ["2001:db8:1::ffff", "tunnel"], // /128 exception
    ["2001:db8:1::1:0", "tunnel"], // just above the /127 hole
    ["2001:db8:1::ffff:ffff:ffff:ffff", "tunnel"], // /64 upper boundary
    ["2001:db8:1:1::", "direct"], // outside the /64
    ["2001:db8:2::", "direct"],
  ];
  for (const [address, expected] of cases) {
    equal(decide(table, address), expected, `decide(${address})`);
    equal(referenceDecide([groupE], address), expected, `reference(${address})`);
  }
});

test("ipv6: compiled table matches per-group evaluation on a boundary sweep", () => {
  const groups = [groupC, groupD, groupE];
  const table = compile(groups);
  const probes = [
    "::",
    "::1",
    "2001:db8::",
    "2001:db8::1",
    "2001:db8:fffe:ffff:ffff:ffff:ffff:ffff",
    "2001:db8:ffff::",
    "2001:db8:ffff:ffff:ffff:ffff:ffff:ffff",
    "2001:db8:1::fffd",
    "2001:db8:1::fffe",
    "2001:db8:1::ffff",
    "2001:db8:1::1:0",
    "2001:db8:1::ffff:ffff:ffff:ffff",
    "2001:db8:1:1::",
    "ffff::1",
  ];
  for (const address of probes) {
    equal(
      decide(table, address),
      referenceDecide(groups, address),
      `mismatch at ${address}`,
    );
  }
});

test("address families are independent", () => {
  const v4Only = compile([[{ cidr: "0.0.0.0/0", route: "tunnel" }]]);
  equal(decide(v4Only, "1.2.3.4"), "tunnel");
  equal(decide(v4Only, "::1"), "direct");

  const v6Only = compile([[{ cidr: "::/0", route: "tunnel" }]]);
  equal(decide(v6Only, "::1"), "tunnel");
  equal(decide(v6Only, "1.2.3.4"), "direct");
});

test("empty input", () => {
  equal(compile([]).length, 0);
  equal(decide(compile([[]]), "10.0.0.1"), "direct");
});
