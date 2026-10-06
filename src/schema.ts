/** SQLite 建表语句。messages.id 自增，即成功入队的确定先后关系。 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payload TEXT NOT NULL,
  priority INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS deliveries (
  group_name TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  receipt TEXT,
  lease_expires_at INTEGER,
  PRIMARY KEY (group_name, message_id)
);
CREATE INDEX IF NOT EXISTS idx_deliveries_claim
  ON deliveries (group_name, state, lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_deliveries_sweep
  ON deliveries (state, lease_expires_at);
`;

export const META_GROUPS_KEY = 'groups';
