import { parseCidr } from "./ip";
import type { ParsedCidr } from "./ip";
import type { Group, Route, Rule } from "./types";

interface ParsedRule {
  parsed: ParsedCidr;
  route: Route;
}

interface UnionEntry {
  parsed: ParsedCidr;
  cidr: string;
}

function prefixKey(parsed: ParsedCidr): string {
  return `${parsed.family}:${parsed.network.toString(16)}/${parsed.prefixLen}`;
}

function sizeOf(parsed: ParsedCidr): bigint {
  return 1n << BigInt(parsed.bits - parsed.prefixLen);
}

function contains(outer: ParsedCidr, inner: ParsedCidr): boolean {
  if (outer.family !== inner.family || outer.prefixLen > inner.prefixLen) {
    return false;
  }
  const shift = BigInt(outer.bits - outer.prefixLen);
  return outer.network >> shift === inner.network >> shift;
}

// Longest-prefix-match evaluation of a single group at one address
// (given as family + bits). Longest matching prefix wins, default direct.
function evaluateGroup(
  group: ParsedRule[],
  family: number,
  value: bigint,
): Route {
  let bestLen = -1;
  let route: Route = "direct";
  for (const rule of group) {
    if (rule.parsed.family !== family || rule.parsed.prefixLen <= bestLen) {
      continue;
    }
    const shift = BigInt(rule.parsed.bits - rule.parsed.prefixLen);
    if (rule.parsed.network >> shift === value >> shift) {
      bestLen = rule.parsed.prefixLen;
      route = rule.route;
    }
  }
  return route;
}

export function compile(groups: Group[]): Rule[] {
  const parsedGroups: ParsedRule[][] = groups.map((group) =>
    group.map((rule) => ({ parsed: parseCidr(rule.cidr), route: rule.route })),
  );

  // Union of every prefix appearing in any group; first spelling wins.
  const union = new Map<string, UnionEntry>();
  for (let g = 0; g < groups.length; g++) {
    for (let r = 0; r < groups[g].length; r++) {
      const { parsed } = parsedGroups[g][r];
      const key = prefixKey(parsed);
      if (!union.has(key)) {
        union.set(key, { parsed, cidr: groups[g][r].cidr });
      }
    }
  }

  const entries = [...union.values()].sort((a, b) => {
    if (a.parsed.family !== b.parsed.family) {
      return a.parsed.family - b.parsed.family;
    }
    if (a.parsed.network !== b.parsed.network) {
      return a.parsed.network < b.parsed.network ? -1 : 1;
    }
    return a.parsed.prefixLen - b.parsed.prefixLen;
  });

  // Every address whose longest union prefix is P matches exactly P and P's
  // ancestors in every group, so one representative address from
  // "P minus its descendant union prefixes" determines the route for the
  // whole region. The representative must dodge those descendants: P's own
  // network address may lie inside a longer union prefix with a different
  // route.
  const table: Rule[] = [];
  for (const entry of entries) {
    const { parsed } = entry;
    let candidate = parsed.network;
    const end = parsed.network + sizeOf(parsed);
    for (const other of entries) {
      if (other.parsed.prefixLen <= parsed.prefixLen) {
        continue;
      }
      if (!contains(parsed, other.parsed)) {
        continue;
      }
      const descendant = other.parsed;
      if (candidate >= descendant.network && candidate < descendant.network + sizeOf(descendant)) {
        candidate = descendant.network + sizeOf(descendant);
      }
    }
    if (candidate >= end) {
      // Longer union prefixes cover P entirely; P's route is never consulted.
      continue;
    }
    let route: Route = "direct";
    for (const group of parsedGroups) {
      if (evaluateGroup(group, parsed.family, candidate) === "tunnel") {
        route = "tunnel";
        break;
      }
    }
    table.push({ cidr: entry.cidr, route });
  }

  table.sort((a, b) => {
    const pa = parseCidr(a.cidr);
    const pb = parseCidr(b.cidr);
    if (pa.family !== pb.family) {
      return pa.family - pb.family;
    }
    if (pa.prefixLen !== pb.prefixLen) {
      return pa.prefixLen - pb.prefixLen;
    }
    return pa.network < pb.network ? -1 : pa.network > pb.network ? 1 : 0;
  });
  return table;
}
