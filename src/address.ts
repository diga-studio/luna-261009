import type { Family, ParsedPrefix } from "./types.js";

const IPV4_BITS = 32n;
const IPV6_BITS = 128n;

export function bitsOf(family: Family): bigint {
  return family === 4 ? IPV4_BITS : IPV6_BITS;
}

function parseIpv4(address: string): bigint | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value << 8n) | BigInt(octet);
  }
  return value;
}

function parseIpv6(address: string): bigint | null {
  if (address.includes(".")) {
    const lastColon = address.lastIndexOf(":");
    if (lastColon < 0) return null;
    const v4 = parseIpv4(address.slice(lastColon + 1));
    if (v4 === null) return null;
    const head = address.slice(0, lastColon + 1);
    const headValue = parseIpv6(head === "::" ? "::" : head + "0:0");
    if (headValue === null) return null;
    return headValue | v4;
  }
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const parseGroups = (text: string): number[] | null => {
    if (text === "") return [];
    const groups = text.split(":");
    const out: number[] = [];
    for (const group of groups) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
      out.push(parseInt(group, 16));
    }
    return out;
  };
  const left = parseGroups(halves[0]);
  if (left === null) return null;
  let groups: number[];
  if (halves.length === 2) {
    const right = parseGroups(halves[1]);
    if (right === null) return null;
    const missing = 8 - left.length - right.length;
    if (missing < 1) return null;
    groups = [...left, ...Array<number>(missing).fill(0), ...right];
  } else {
    if (left.length !== 8) return null;
    groups = left;
  }
  let value = 0n;
  for (const group of groups) {
    value = (value << 16n) | BigInt(group);
  }
  return value;
}

export function parseAddress(address: string): { family: Family; value: bigint } {
  const v4 = parseIpv4(address);
  if (v4 !== null) return { family: 4, value: v4 };
  const v6 = parseIpv6(address);
  if (v6 !== null) return { family: 6, value: v6 };
  throw new Error("invalid address: " + address);
}

export function parseCidr(cidr: string): ParsedPrefix {
  const slash = cidr.indexOf("/");
  if (slash < 0) throw new Error("missing prefix length: " + cidr);
  const { family, value } = parseAddress(cidr.slice(0, slash));
  const lenText = cidr.slice(slash + 1);
  if (!/^\d{1,3}$/.test(lenText)) throw new Error("invalid prefix length: " + cidr);
  const len = Number(lenText);
  const bits = Number(bitsOf(family));
  if (len > bits) throw new Error("prefix length out of range: " + cidr);
  const mask = len === 0 ? 0n : ((1n << BigInt(len)) - 1n) << BigInt(bits - len);
  if ((value & ~mask) !== 0n) throw new Error("cidr not aligned to network address: " + cidr);
  return { family, value, len };
}

function formatIpv4(value: bigint): string {
  const octets: string[] = [];
  for (let shift = 24n; shift >= 0n; shift -= 8n) {
    octets.push(((value >> shift) & 0xffn).toString());
  }
  return octets.join(".");
}

function formatIpv6(value: bigint): string {
  const groups: number[] = [];
  for (let shift = 112n; shift >= 0n; shift -= 16n) {
    groups.push(Number((value >> shift) & 0xffffn));
  }
  let bestStart = -1;
  let bestLen = 0;
  let curStart = -1;
  let curLen = 0;
  for (let i = 0; i <= groups.length; i++) {
    if (i < groups.length && groups[i] === 0) {
      if (curStart < 0) {
        curStart = i;
        curLen = 0;
      }
      curLen++;
      if (curLen > bestLen) {
        bestStart = curStart;
        bestLen = curLen;
      }
    } else {
      curStart = -1;
    }
  }
  if (bestLen < 2) {
    bestStart = -1;
  }
  const hex = groups.map((g) => g.toString(16));
  if (bestStart < 0) return hex.join(":");
  const left = hex.slice(0, bestStart).join(":");
  const right = hex.slice(bestStart + bestLen).join(":");
  return left + "::" + right;
}

export function formatCidr(family: Family, value: bigint, len: number): string {
  const text = family === 4 ? formatIpv4(value) : formatIpv6(value);
  return text + "/" + len;
}
