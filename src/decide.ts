import { bitsOf, parseAddress, parseCidr } from "./address.js";
import type { Rule, Route } from "./types.js";

export function decide(table: Rule[], address: string): Route {
  const { family, value } = parseAddress(address);
  const bits = bitsOf(family);
  let best: Route = "direct";
  let bestLen = -1;
  for (const rule of table) {
    const parsed = parseCidr(rule.cidr);
    if (parsed.family !== family || parsed.len <= bestLen) continue;
    const shift = bits - BigInt(parsed.len);
    if ((value >> shift) === (parsed.value >> shift)) {
      best = rule.route;
      bestLen = parsed.len;
    }
  }
  return best;
}
