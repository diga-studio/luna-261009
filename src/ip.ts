export type Family = 4 | 6;

export interface ParsedAddress {
  family: Family;
  value: bigint;
  bits: number;
}

export interface ParsedCidr {
  family: Family;
  network: bigint;
  prefixLen: number;
  bits: number;
}

function parseIpv4(input: string): bigint {
  const parts = input.split(".");
  if (parts.length !== 4) {
    throw new Error(`invalid IPv4 address: ${input}`);
  }
  let value = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      throw new Error(`invalid IPv4 address: ${input}`);
    }
    const octet = Number(part);
    if (octet > 255) {
      throw new Error(`invalid IPv4 address: ${input}`);
    }
    value = (value << 8n) | BigInt(octet);
  }
  return value;
}

function parseIpv6(input: string): bigint {
  const zones = input.split("%");
  if (zones.length > 2) {
    throw new Error(`invalid IPv6 address: ${input}`);
  }
  const body = zones[0];
  const halves = body.split("::");
  if (halves.length > 2) {
    throw new Error(`invalid IPv6 address: ${input}`);
  }

  const parseGroup = (group: string): bigint => {
    if (group.includes(".")) {
      const lastColon = group.lastIndexOf(":");
      const head = lastColon === -1 ? "" : group.slice(0, lastColon + 1);
      if (head !== "") {
        throw new Error(`invalid IPv6 address: ${input}`);
      }
      const v4 = parseIpv4(group.slice(lastColon + 1));
      return v4;
    }
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) {
      throw new Error(`invalid IPv6 address: ${input}`);
    }
    return BigInt(parseInt(group, 16));
  };

  const expandSide = (side: string): bigint[] =>
    side === "" ? [] : side.split(":").map(parseGroup);

  const head = expandSide(halves[0]);
  const tail = halves.length === 2 ? expandSide(halves[1]) : [];

  // An embedded IPv4 group contributes 32 bits, i.e. two 16-bit groups.
  const groupCountOf = (side: string, groups: bigint[]): number => {
    if (side.includes(".")) {
      return groups.length + 1;
    }
    return groups.length;
  };
  const headCount = groupCountOf(halves[0], head);
  const tailCount = halves.length === 2 ? groupCountOf(halves[1], tail) : 0;

  let groups: bigint[];
  if (halves.length === 2) {
    const missing = 8 - headCount - tailCount;
    if (missing < 0) {
      throw new Error(`invalid IPv6 address: ${input}`);
    }
    groups = [...head, ...new Array<bigint>(missing).fill(0n), ...tail];
  } else {
    if (headCount !== 8) {
      throw new Error(`invalid IPv6 address: ${input}`);
    }
    groups = head;
  }

  // Split a trailing embedded-IPv4 group (32 bits) into two 16-bit groups.
  if (body.includes(".")) {
    const v4 = groups[groups.length - 1];
    groups = [...groups.slice(0, -1), (v4 >> 16n) & 0xffffn, v4 & 0xffffn];
  }

  if (groups.length !== 8) {
    throw new Error(`invalid IPv6 address: ${input}`);
  }
  let value = 0n;
  for (const group of groups) {
    value = (value << 16n) | group;
  }
  return value;
}

export function parseAddress(input: string): ParsedAddress {
  if (input.includes(":")) {
    return { family: 6, value: parseIpv6(input), bits: 128 };
  }
  return { family: 4, value: parseIpv4(input), bits: 32 };
}

export function parseCidr(cidr: string): ParsedCidr {
  const slash = cidr.indexOf("/");
  if (slash === -1 || cidr.indexOf("/", slash + 1) !== -1) {
    throw new Error(`invalid CIDR: ${cidr}`);
  }
  const addr = parseAddress(cidr.slice(0, slash));
  const prefixText = cidr.slice(slash + 1);
  if (!/^\d{1,3}$/.test(prefixText)) {
    throw new Error(`invalid CIDR: ${cidr}`);
  }
  const prefixLen = Number(prefixText);
  if (prefixLen > addr.bits) {
    throw new Error(`invalid CIDR: ${cidr}`);
  }
  const shift = BigInt(addr.bits - prefixLen);
  const mask = shift === 0n ? 0n : (1n << shift) - 1n;
  if ((addr.value & mask) !== 0n) {
    throw new Error(`CIDR not aligned to network address: ${cidr}`);
  }
  return {
    family: addr.family,
    network: addr.value,
    prefixLen,
    bits: addr.bits,
  };
}

export function matches(cidr: ParsedCidr, addr: ParsedAddress): boolean {
  if (cidr.family !== addr.family) {
    return false;
  }
  const shift = BigInt(cidr.bits - cidr.prefixLen);
  return cidr.network >> shift === addr.value >> shift;
}
