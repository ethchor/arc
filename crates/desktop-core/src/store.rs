//! Local offline cache (docs/12 §12.2). Stores the server's ciphertext envelopes — never
//! plaintext — so even plain SQLite keeps zero-knowledge at rest. Production builds swap the
//! `rusqlite` feature to `bundled-sqlcipher` for file-level encryption, with the DB key
//! wrapped under the keychain device key.

use arc_vault_crypto::Envelope;
use rusqlite::{params, Connection};

pub struct CachedItem {
    pub item_id: String,
    pub ciphertext: Envelope,
    pub wrapped_item_key: Envelope,
    pub version: i64,
    pub key_version: i64,
    pub seq: i64,
}

pub struct CipherCache {
    conn: Connection,
}

impl CipherCache {
    pub fn open(path: &str) -> rusqlite::Result<Self> {
        Self::init(Connection::open(path)?)
    }

    pub fn open_in_memory() -> rusqlite::Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> rusqlite::Result<Self> {
        conn.execute(
            "CREATE TABLE IF NOT EXISTS items (
                vault_id TEXT NOT NULL,
                item_id TEXT NOT NULL,
                ciphertext TEXT NOT NULL,
                wrapped_item_key TEXT NOT NULL,
                version INTEGER NOT NULL,
                key_version INTEGER NOT NULL,
                seq INTEGER NOT NULL,
                PRIMARY KEY (vault_id, item_id)
            )",
            [],
        )?;
        Ok(Self { conn })
    }

    pub fn upsert(&self, vault_id: &str, item: &CachedItem) -> rusqlite::Result<()> {
        self.conn.execute(
            "INSERT OR REPLACE INTO items
                (vault_id, item_id, ciphertext, wrapped_item_key, version, key_version, seq)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                vault_id,
                item.item_id,
                serde_json::to_string(&item.ciphertext).unwrap(),
                serde_json::to_string(&item.wrapped_item_key).unwrap(),
                item.version,
                item.key_version,
                item.seq,
            ],
        )?;
        Ok(())
    }

    pub fn get(&self, vault_id: &str, item_id: &str) -> rusqlite::Result<Option<CachedItem>> {
        let mut stmt = self.conn.prepare(
            "SELECT item_id, ciphertext, wrapped_item_key, version, key_version, seq
             FROM items WHERE vault_id = ?1 AND item_id = ?2",
        )?;
        let mut rows = stmt.query(params![vault_id, item_id])?;
        match rows.next()? {
            Some(r) => Ok(Some(Self::row(r)?)),
            None => Ok(None),
        }
    }

    pub fn list(&self, vault_id: &str) -> rusqlite::Result<Vec<CachedItem>> {
        let mut stmt = self.conn.prepare(
            "SELECT item_id, ciphertext, wrapped_item_key, version, key_version, seq
             FROM items WHERE vault_id = ?1 ORDER BY seq ASC",
        )?;
        let rows = stmt.query_map(params![vault_id], Self::row)?;
        rows.collect()
    }

    pub fn max_seq(&self, vault_id: &str) -> rusqlite::Result<i64> {
        self.conn.query_row(
            "SELECT COALESCE(MAX(seq), 0) FROM items WHERE vault_id = ?1",
            params![vault_id],
            |r| r.get(0),
        )
    }

    fn row(r: &rusqlite::Row) -> rusqlite::Result<CachedItem> {
        let ct: String = r.get(1)?;
        let wik: String = r.get(2)?;
        Ok(CachedItem {
            item_id: r.get(0)?,
            ciphertext: serde_json::from_str(&ct)
                .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))?,
            wrapped_item_key: serde_json::from_str(&wik)
                .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))?,
            version: r.get(3)?,
            key_version: r.get(4)?,
            seq: r.get(5)?,
        })
    }
}
