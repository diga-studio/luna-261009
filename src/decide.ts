import { matches, parseAddress, parseCidr } from "./ip";
import type { Route, Rule } from "./types";

export function decide(table: Rule[], address: string): Route {
  const addr = parseAddress(address);
  let bestLen = -1;
  let route: Route = "direct";
  for (const rule of table) {
    const parsed = parseCidr(rule.cidr);
    if (parsed.prefixLen <= bestLen) {
      continue;
    }
    if (matches(parsed, addr)) {
      bestLen = parsed.prefixLen;
      route = rule.route;
    }
  }
  return route;
}
