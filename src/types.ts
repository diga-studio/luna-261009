export type Route = "tunnel" | "direct";

export interface Rule {
  cidr: string;
  route: Route;
}

export type Family = 4 | 6;

export interface ParsedPrefix {
  family: Family;
  value: bigint;
  len: number;
}
