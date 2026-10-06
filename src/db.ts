import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS customers (
  customer_id TEXT PRIMARY KEY,
  last_purchase_at INTEGER,
  cart_nonempty INTEGER NOT NULL,
  cart_updated_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  segment TEXT NOT NULL,
  scheduled_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  send_started_at INTEGER,
  expires_at INTEGER
);

CREATE TABLE IF NOT EXISTS recipients (
  campaign_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  delivered INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (campaign_id, customer_id)
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  UNIQUE (campaign_id, customer_id)
);
`;

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}
