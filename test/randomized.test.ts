import { test } from "node:test";
import { equal } from "node:assert/strict";
import { compile } from "../src/compile";
import { decide } from "../src/decide";
import type { Group, Route, Rule } from "../src/types";
import { referenceDecide } from "./reference";

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomGroups(rand: () => number, family: 4 | 6): Group[] {
  const bits = family === 4 ? 32 : 128;
  const groups: Group[] = [];
  const groupCount = 1 + Math.floor(rand() * 3);
  for (let g = 0; g < groupCount; g++) {
    const rules: Rule[] = [];
    const seen = new Set<string>();
    const ruleCount = 1 + Math.floor(rand() * 6);
    for (let r = 0; r < ruleCount; r++) {
      const prefixLen = Math.floor(rand() * (bits + 1));
      const value =
        family === 4
          ? BigInt(Math.floor(rand() * 0x100000000))
          : BigInt(Math.floor(rand() * 0x100000000)) *
              340282366920938463463374607431768211456n +
            BigInt(Math.floor(rand() * 0x100000000)) *
              79228162514264337593543950336n +
            BigInt(Math.floor(rand() * 0x100000000)) * 4294967296n +
            BigInt(Math.floor(rand() * 0x100000000));
      const shift = BigInt(bits - prefixLen);
      const network = (value >> shift) << shift;
      let cidr: string;
      if (family === 4) {
        const parts: number[] = [];
        for (let i = 3; i >= 0; i--) {
          parts.push(Number((network >> BigInt(i * 8)) & 0xffn));
        }
        cidr = `${parts.join(".")}/${prefixLen}`;
      } else {
        const groups16: string[] = [];
        for (let i = 7; i >= 0; i--) {
          groups16.push(((network >> BigInt(i * 16)) & 0xffffn).toString(16));
        }
        cidr = `${groups16.join(":")}/${prefixLen}`;
      }
      if (seen.has(cidr)) {
        continue;
      }
      seen.add(cidr);
      const route: Route = rand() < 0.5 ? "tunnel" : "direct";
      rules.push({ cidr, route });
    }
    groups.push(rules);
  }
  return groups;
}

function randomAddress(rand: () => number, family: 4 | 6): string {
  if (family === 4) {
    return [0, 1, 2, 3].map(() => Math.floor(rand() * 256)).join(".");
  }
  const groups16: string[] = [];
  for (let i = 0; i < 8; i++) {
    groups16.push(Math.floor(rand() * 0x10000).toString(16));
  }
  return groups16.join(":");
}

test("randomized: compiled table matches per-group evaluation", () => {
  for (const family of [4, 6] as const) {
    const rand = mulberry32(family === 4 ? 1234 : 5678);
    for (let round = 0; round < 200; round++) {
      const groups = randomGroups(rand, family);
      const table = compile(groups);
      for (let probe = 0; probe < 20; probe++) {
        const address = randomAddress(rand, family);
        equal(
          decide(table, address),
          referenceDecide(groups, address),
          `family=${family} round=${round} address=${address} ` +
            `groups=${JSON.stringify(groups)} table=${JSON.stringify(table)}`,
        );
      }
    }
  }
});

test("randomized: probes concentrated near rule prefixes", () => {
  // Addresses near prefix boundaries are where off-by-one errors hide.
  for (const family of [4, 6] as const) {
    const rand = mulberry32(family === 4 ? 999 : 4242);
    for (let round = 0; round < 100; round++) {
      const groups = randomGroups(rand, family);
      const table = compile(groups);
      for (const group of groups) {
        for (const rule of group) {
          const base = rule.cidr.slice(0, rule.cidr.indexOf("/"));
          for (const address of [base]) {
            equal(
              decide(table, address),
              referenceDecide(groups, address),
              `family=${family} address=${address}`,
            );
          }
        }
      }
    }
  }
});
