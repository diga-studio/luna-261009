import type { Name } from "./types";

export const MAX_POINTER_OFFSET = 0x3fff; // 16383
export const MAX_NAME_LENGTH = 255; // including length bytes and root label
export const MAX_LABEL_LENGTH = 63;

export class DecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecodeError";
  }
}

function labelKey(label: Uint8Array): string {
  let out = "";
  for (let i = 0; i < label.length; i++) {
    out += String.fromCharCode(label[i]!);
  }
  return out;
}

/** Case-sensitive, collision-free key for a label suffix. */
export function suffixKey(name: Name, start: number): string {
  let key = "";
  for (let i = start; i < name.length; i++) {
    const label = name[i]!;
    key += label.length + ":" + labelKey(label) + ",";
  }
  return key;
}

export function validateName(name: Name): void {
  let total = 1; // root label
  for (const label of name) {
    if (label.length === 0) {
      throw new DecodeError("empty label inside name");
    }
    if (label.length > MAX_LABEL_LENGTH) {
      throw new DecodeError("label exceeds 63 bytes");
    }
    total += 1 + label.length;
  }
  if (total > MAX_NAME_LENGTH) {
    throw new DecodeError("expanded name exceeds 255 bytes");
  }
}

/**
 * Reads a possibly-compressed domain name at `offset`.
 * Returns the decoded labels and the offset of the first byte after the
 * name as stored in the packet (compression pointers do not advance it).
 */
export function readName(buf: Uint8Array, offset: number): { name: Name; nextOffset: number } {
  const name: Name = [];
  let pos = offset;
  let nextOffset = -1;
  let expanded = 1; // root label
  const visitedPointers = new Set<number>();
  for (;;) {
    if (pos >= buf.length) {
      throw new DecodeError("name runs past end of packet");
    }
    const len = buf[pos]!;
    if ((len & 0xc0) === 0xc0) {
      if (pos + 1 >= buf.length) {
        throw new DecodeError("truncated compression pointer");
      }
      const target = ((len & 0x3f) << 8) | buf[pos + 1]!;
      if (target >= pos) {
        throw new DecodeError("compression pointer does not point backwards");
      }
      if (visitedPointers.has(target)) {
        throw new DecodeError("compression pointer loop");
      }
      visitedPointers.add(target);
      if (nextOffset === -1) {
        nextOffset = pos + 2;
      }
      pos = target;
      continue;
    }
    if ((len & 0xc0) !== 0) {
      throw new DecodeError("invalid label marker bits");
    }
    if (len === 0) {
      if (nextOffset === -1) {
        nextOffset = pos + 1;
      }
      break;
    }
    if (pos + 1 + len > buf.length) {
      throw new DecodeError("label runs past end of packet");
    }
    expanded += 1 + len;
    if (expanded > MAX_NAME_LENGTH) {
      throw new DecodeError("expanded name exceeds 255 bytes");
    }
    name.push(buf.slice(pos + 1, pos + 1 + len));
    pos += 1 + len;
  }
  return { name, nextOffset };
}

export class ByteWriter {
  private bytes: number[] = [];

  get length(): number {
    return this.bytes.length;
  }

  u8(value: number): void {
    this.bytes.push(value & 0xff);
  }

  u16(value: number): void {
    this.bytes.push((value >>> 8) & 0xff, value & 0xff);
  }

  u32(value: number): void {
    this.bytes.push(
      (value >>> 24) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 8) & 0xff,
      value & 0xff,
    );
  }

  setU16At(offset: number, value: number): void {
    this.bytes[offset] = (value >>> 8) & 0xff;
    this.bytes[offset + 1] = value & 0xff;
  }

  raw(data: Uint8Array): void {
    for (const byte of data) {
      this.bytes.push(byte);
    }
  }

  toUint8Array(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

/**
 * ByteWriter with RFC 1035 name compression. Suffixes are matched
 * case-sensitively so sharing a pointer never alters a name's case.
 */
export class PacketWriter extends ByteWriter {
  private suffixOffsets = new Map<string, number>();

  writeName(name: Name, options?: { compress?: boolean }): void {
    validateName(name);
    const compress = options?.compress !== false;
    let pointerTarget = -1;
    if (compress) {
      for (let i = 0; i < name.length; i++) {
        const offset = this.suffixOffsets.get(suffixKey(name, i));
        if (offset !== undefined) {
          pointerTarget = offset;
          // Write labels [0, i) then a pointer to the suffix at i.
          this.writeLabelsAndRegister(name, i);
          this.u16(0xc000 | pointerTarget);
          return;
        }
      }
    }
    this.writeLabelsAndRegister(name, name.length);
    this.u8(0);
  }

  private writeLabelsAndRegister(name: Name, count: number): void {
    for (let i = 0; i < count; i++) {
      const offset = this.length;
      if (offset <= MAX_POINTER_OFFSET) {
        const key = suffixKey(name, i);
        if (!this.suffixOffsets.has(key)) {
          this.suffixOffsets.set(key, offset);
        }
      }
      const label = name[i]!;
      this.u8(label.length);
      this.raw(label);
    }
  }
}
