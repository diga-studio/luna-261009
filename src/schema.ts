/** SQLite 表结构：文档当前版本指针、版本、块原文、块-词项倒排。 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS documents (
  kb_id TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  current_version_id INTEGER,
  active_chunks INTEGER NOT NULL DEFAULT 0,
  active_len INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (kb_id, doc_id)
);

CREATE TABLE IF NOT EXISTS versions (
  version_id INTEGER PRIMARY KEY AUTOINCREMENT,
  kb_id TEXT NOT NULL,
  doc_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chunks (
  version_id INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  text TEXT NOT NULL,
  len INTEGER NOT NULL,
  PRIMARY KEY (version_id, seq)
);

-- 每个 (version_id, term, seq) 一行，tf 为该词项在块中的出现次数，len 为块词项数。
-- WITHOUT ROWID 聚簇表：检索按 (version_id, term) 定点扫描，无需回表。
CREATE TABLE IF NOT EXISTS chunk_terms (
  version_id INTEGER NOT NULL,
  term TEXT NOT NULL,
  seq INTEGER NOT NULL,
  tf INTEGER NOT NULL,
  len INTEGER NOT NULL,
  PRIMARY KEY (version_id, term, seq)
) WITHOUT ROWID;
`;
