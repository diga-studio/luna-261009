import { matches, parseAddress, parseCidr } from "../src/ip";
import type { Group, Route } from "../src/types";

// Independent per-group evaluation used as the oracle for compile():
// evaluate each group with longest-prefix-match (default direct), then
// tunnel wins across groups.
export function referenceDecide(groups: Group[], address: string): Route {
  const addr = parseAddress(address);
  for (const group of groups) {
    let bestLen = -1;
    let route: Route = "direct";
    for (const rule of group) {
      const parsed = parseCidr(rule.cidr);
      if (parsed.prefixLen > bestLen && matches(parsed, addr)) {
        bestLen = parsed.prefixLen;
        route = rule.route;
      }
    }
    if (route === "tunnel") {
      return "tunnel";
    }
  }
  return "direct";
}
