export type Route = "tunnel" | "direct";

export interface Rule {
  cidr: string;
  route: Route;
}

export type Group = Rule[];
