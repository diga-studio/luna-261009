import { DecodeError } from "./wire";

export function formatIPv4(bytes: Uint8Array): string {
  return `${bytes[0]}.${bytes[1]}.${bytes[2]}.${bytes[3]}`;
}

export function parseIPv4(address: string): Uint8Array {
  const parts = address.split(".");
  if (parts.length !== 4) {
    throw new DecodeError(`invalid IPv4 address: ${address}`);
  }
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const part = parts[i]!;
    if (!/^\d{1,3}$/.test(part)) {
      throw new DecodeError(`invalid IPv4 address: ${address}`);
    }
    const value = Number(part);
    if (value > 255) {
      throw new DecodeError(`invalid IPv4 address: ${address}`);
    }
    out[i] = value;
  }
  return out;
}

export function formatIPv6(bytes: Uint8Array): string {
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) {
    groups.push(((bytes[i]! << 8) | bytes[i + 1]!).toString(16));
  }
  return groups.join(":");
}

export function parseIPv6(address: string): Uint8Array {
  const out = new Uint8Array(16);
  const halves = address.split("::");
  if (halves.length > 2) {
    throw new DecodeError(`invalid IPv6 address: ${address}`);
  }
  const head = halves[0] === "" ? [] : halves[0]!.split(":");
  const tail = halves.length === 2 ? (halves[1] === "" ? [] : halves[1]!.split(":")) : [];
  if (halves.length === 1 && head.length !== 8) {
    throw new DecodeError(`invalid IPv6 address: ${address}`);
  }
  if (head.length + tail.length > 8 || (halves.length === 2 && head.length + tail.length === 8)) {
    throw new DecodeError(`invalid IPv6 address: ${address}`);
  }
  const groups: number[] = [];
  const parseGroup = (text: string): number => {
    if (!/^[0-9a-fA-F]{1,4}$/.test(text)) {
      throw new DecodeError(`invalid IPv6 address: ${address}`);
    }
    return parseInt(text, 16);
  };
  for (const group of head) groups.push(parseGroup(group));
  const zeros = 8 - head.length - tail.length;
  for (let i = 0; i < zeros; i++) groups.push(0);
  for (const group of tail) groups.push(parseGroup(group));
  for (let i = 0; i < 8; i++) {
    out[i * 2] = (groups[i]! >>> 8) & 0xff;
    out[i * 2 + 1] = groups[i]! & 0xff;
  }
  return out;
}
