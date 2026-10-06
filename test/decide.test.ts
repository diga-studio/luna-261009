import { test } from "node:test";
import { equal, throws } from "node:assert/strict";
import { decide } from "../src/decide";

test("empty table defaults to direct", () => {
  equal(decide([], "10.0.0.1"), "direct");
  equal(decide([], "::1"), "direct");
});

test("no matching rule defaults to direct", () => {
  const table = [{ cidr: "10.0.0.0/8", route: "tunnel" as const }];
  equal(decide(table, "192.168.0.1"), "direct");
});

test("longest prefix wins regardless of rule order", () => {
  const table = [
    { cidr: "10.1.0.0/16", route: "direct" as const },
    { cidr: "10.0.0.0/8", route: "tunnel" as const },
  ];
  equal(decide(table, "10.1.0.1"), "direct");
  equal(decide(table, "10.2.0.1"), "tunnel");
});

test("full-length prefixes match exactly one address", () => {
  const table = [
    { cidr: "10.0.0.1/32", route: "tunnel" as const },
    { cidr: "2001:db8::1/128", route: "tunnel" as const },
  ];
  equal(decide(table, "10.0.0.1"), "tunnel");
  equal(decide(table, "10.0.0.2"), "direct");
  equal(decide(table, "2001:db8::1"), "tunnel");
  equal(decide(table, "2001:db8::2"), "direct");
});

test("rejects malformed input", () => {
  throws(() => decide([], "10.0.0.256"));
  throws(() => decide([], "10.0.0"));
  throws(() => decide([], "2001:::1"));
  throws(() => decide([{ cidr: "10.0.0.1/8", route: "tunnel" }], "10.0.0.1"));
  throws(() => decide([{ cidr: "10.0.0.0/33", route: "tunnel" }], "10.0.0.1"));
});
