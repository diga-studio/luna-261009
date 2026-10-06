import { DnsName } from "../src/types";

/** Build a DnsName from string (latin1) or raw-buffer labels. */
export function name(...labels: (string | Buffer)[]): DnsName {
  return labels.map((l) => (typeof l === "string" ? Buffer.from(l, "latin1") : l));
}

/** Parse a hex string (whitespace ignored) into a Buffer. */
export function pkt(hex: string): Buffer {
  return Buffer.from(hex.replace(/\s+/g, ""), "hex");
}

/** Render a name as a printable string for assertions. */
export function nameText(n: DnsName): string {
  return n.map((l) => l.toString("latin1")).join(".");
}
