import { DnsError } from "./errors";
import { DnsName } from "./types";

export const MAX_NAME_LENGTH = 255;
export const MAX_LABEL_LENGTH = 63;
export const MAX_POINTER_OFFSET = 16383;

export interface ReadNameResult {
  name: DnsName;
  /** Bytes consumed at the original offset (a pointer counts as 2 and
   *  terminates consumption; jumped-to bytes are not counted). */
  consumed: number;
}

/** Decode a (possibly compressed) domain name starting at `offset`. */
export function readName(packet: Buffer, offset: number): ReadNameResult {
  const labels: DnsName = [];
  const visitedPointers = new Set<number>();
  let pos = offset;
  let consumed = 0;
  let jumped = false;
  let expanded = 1; // root terminator

  for (;;) {
    if (pos >= packet.length) {
      throw new DnsError("name extends past end of packet");
    }
    const len = packet[pos]!;
    if ((len & 0xc0) === 0xc0) {
      if (pos + 1 >= packet.length) {
        throw new DnsError("truncated compression pointer");
      }
      const target = ((len & 0x3f) << 8) | packet[pos + 1]!;
      if (target >= pos) {
        throw new DnsError("compression pointer does not refer to an earlier offset");
      }
      if (visitedPointers.has(pos)) {
        throw new DnsError("compression pointer loop");
      }
      visitedPointers.add(pos);
      if (!jumped) {
        consumed += 2;
        jumped = true;
      }
      pos = target;
      continue;
    }
    if ((len & 0xc0) !== 0) {
      throw new DnsError("illegal label marker bits");
    }
    if (len === 0) {
      if (!jumped) {
        consumed += 1;
      }
      return { name: labels, consumed };
    }
    if (pos + 1 + len > packet.length) {
      throw new DnsError("label extends past end of packet");
    }
    expanded += 1 + len;
    if (expanded > MAX_NAME_LENGTH) {
      throw new DnsError("expanded name exceeds 255 bytes");
    }
    labels.push(Buffer.from(packet.subarray(pos + 1, pos + 1 + len)));
    if (!jumped) {
      consumed += 1 + len;
    }
    pos += 1 + len;
  }
}

/** Validate label/count/length limits of a name; throws on violation. */
export function validateName(name: DnsName): void {
  let total = 1;
  for (const label of name) {
    if (label.length === 0) {
      throw new DnsError("empty label inside name");
    }
    if (label.length > MAX_LABEL_LENGTH) {
      throw new DnsError("label exceeds 63 bytes");
    }
    total += 1 + label.length;
  }
  if (total > MAX_NAME_LENGTH) {
    throw new DnsError("name exceeds 255 bytes on the wire");
  }
}

/** Wire length in bytes of an uncompressed name (length bytes + root). */
export function nameWireLength(name: DnsName): number {
  validateName(name);
  let total = 1;
  for (const label of name) {
    total += 1 + label.length;
  }
  return total;
}

function suffixKey(name: DnsName, start: number): string {
  const parts: Buffer[] = [];
  for (let i = start; i < name.length; i++) {
    const label = name[i]!;
    parts.push(Buffer.from([label.length]), label);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts).toString("latin1");
}

/** Incremental name encoder with compression-suffix tracking.
 *  Suffix matching is case-sensitive: names are never case-folded to
 *  reuse a pointer. Only offsets <= 16383 are registered. */
export class NameEncoder {
  private readonly suffixes = new Map<string, number>();

  /** Encode `name` to be placed at `offset` in the packet. When
   *  `allowCompression` is false the name is written in full (its
   *  suffixes are still registered as compression targets). */
  encode(name: DnsName, allowCompression: boolean, offset: number): Buffer {
    validateName(name);
    let pointerAt = -1;
    let pointerTarget = 0;
    for (let i = 0; i < name.length; i++) {
      const target = this.suffixes.get(suffixKey(name, i));
      if (target !== undefined) {
        pointerAt = i;
        pointerTarget = target;
        break;
      }
    }
    const usePointer = allowCompression && pointerAt >= 0;
    const labelsToWrite = usePointer ? pointerAt : name.length;
    const parts: Buffer[] = [];
    let pos = offset;
    for (let i = 0; i < labelsToWrite; i++) {
      const label = name[i]!;
      parts.push(Buffer.from([label.length]), label);
      if (pos <= MAX_POINTER_OFFSET) {
        const key = suffixKey(name, i);
        if (!this.suffixes.has(key)) {
          this.suffixes.set(key, pos);
        }
      }
      pos += 1 + label.length;
    }
    if (usePointer) {
      const ptr = Buffer.alloc(2);
      ptr.writeUInt16BE(0xc000 | pointerTarget, 0);
      parts.push(ptr);
    } else {
      parts.push(Buffer.from([0]));
    }
    return Buffer.concat(parts);
  }
}
