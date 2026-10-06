import { bitsOf, formatCidr, parseCidr } from "./address.js";
import type { Family, Route, Rule } from "./types.js";

interface TrieNode {
  child: (TrieNode | null)[];
  decisions: Map<number, Route>;
  final: Route;
}

function makeNode(): TrieNode {
  return { child: [null, null], decisions: new Map(), final: "direct" };
}

function insert(root: TrieNode, bits: bigint, value: bigint, len: number, group: number, route: Route): void {
  let node = root;
  for (let i = 0; i < len; i++) {
    const bit = Number((value >> (bits - 1n - BigInt(i))) & 1n);
    const next = node.child[bit];
    if (next === null) {
      const created = makeNode();
      node.child[bit] = created;
      node = created;
    } else {
      node = next;
    }
  }
  node.decisions.set(group, route);
}

function resolve(node: TrieNode, inherited: Map<number, Route>): void {
  const effective = new Map(inherited);
  for (const [group, route] of node.decisions) {
    effective.set(group, route);
  }
  let final: Route = "direct";
  for (const route of effective.values()) {
    if (route === "tunnel") {
      final = "tunnel";
      break;
    }
  }
  node.final = final;
  for (const child of node.child) {
    if (child !== null) resolve(child, effective);
  }
}

function emit(
  node: TrieNode,
  bits: bigint,
  value: bigint,
  len: number,
  parentFinal: Route,
  family: Family,
  out: Rule[],
): void {
  if (node.final !== parentFinal) {
    out.push({ cidr: formatCidr(family, value, len), route: node.final });
  }
  for (let bit = 0; bit < 2; bit++) {
    const child = node.child[bit];
    if (child !== null) {
      const childValue = value | (BigInt(bit) << (bits - 1n - BigInt(len)));
      emit(child, bits, childValue, len + 1, node.final, family, out);
    }
  }
}

function compileFamily(family: Family, groups: Rule[][]): Rule[] {
  const root = makeNode();
  const bits = bitsOf(family);
  let any = false;
  groups.forEach((rules, group) => {
    for (const rule of rules) {
      const parsed = parseCidr(rule.cidr);
      if (parsed.family !== family) continue;
      insert(root, bits, parsed.value, parsed.len, group, rule.route);
      any = true;
    }
  });
  if (!any) return [];
  resolve(root, new Map());
  const out: Rule[] = [];
  emit(root, bits, 0n, 0, "direct", family, out);
  return out;
}

export function compile(groups: Rule[][]): Rule[] {
  const v4 = compileFamily(4, groups);
  const v6 = compileFamily(6, groups);
  return [...v4, ...v6];
}
