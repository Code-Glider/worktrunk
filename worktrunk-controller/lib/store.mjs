import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { object, stable, text } from './data.mjs';
import { localPath } from './paths.mjs';

// All identities, events, claims and action intents commit through this boundary.
// Acknowledgment follows COMMIT; interrupted transactions are SQLite's rollback.
export class Store {
  constructor(directory, { readOnly = false } = {}) {
    const root = localPath(directory, { missing: !readOnly });
    if (!readOnly) fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const filename = path.join(localPath(root), 'controller.sqlite');
    for (const suffix of ['', '-wal', '-shm', '-journal']) localPath(filename + suffix, { missing: suffix !== '' || !readOnly });
    this.db = new DatabaseSync(filename, { readOnly });
    try {
      this.db.exec('PRAGMA busy_timeout=10000;');
      if (!readOnly) this.db.exec('PRAGMA synchronous=FULL;');
      const version = this.db.prepare('PRAGMA user_version').get().user_version;
      if (version !== 1 && (readOnly || version !== 0)) throw new Error('Unsupported state schema');
      if (this.db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('Corrupt controller state');
      if (version === 0) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
          // Another initializer may have committed while this process waited.
          if (this.db.prepare('PRAGMA user_version').get().user_version === 0) {
            if (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").get()) throw new Error('Unrecognized controller database');
            this.db.exec('CREATE TABLE records (kind TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(kind,id)); PRAGMA user_version=1;');
          }
          this.db.exec('COMMIT');
        } catch (error) { this.db.exec('ROLLBACK'); throw error; }
      }
    } catch (error) { this.db.close(); throw error; }
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.writing = true;
      const result = fn(this);
      if (result && typeof result.then === 'function') throw new Error('State transactions must be synchronous');
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    } finally { this.writing = false; }
  }

  get(kind, id) {
    const row = this.db.prepare('SELECT revision,body FROM records WHERE kind=? AND id=?').get(kind, id);
    if (!row) return null;
    const value = object(JSON.parse(row.body), 'stored record');
    if (value.version !== 1) throw new Error('Unsupported record schema');
    return { revision: row.revision, value };
  }

  list(kind) {
    return this.db.prepare('SELECT id FROM records WHERE kind=? ORDER BY id').all(kind).map(row => ({ id: row.id, ...this.get(kind, row.id) }));
  }

  put(kind, id, value) {
    if (!this.writing) throw new Error('State writes require a transaction');
    text(kind, 'record kind'); text(id, 'record id'); object(value, 'record');
    if (value.version !== 1) throw new Error('Unsupported record schema');
    // Read and validate the existing record before replacing any evidence.
    const old = this.get(kind, id);
    const revision = (old?.revision ?? 0) + 1;
    this.db.prepare('INSERT INTO records VALUES (?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET revision=excluded.revision,body=excluded.body').run(kind, id, revision, stable(value));
    return revision;
  }

  close() { this.db.close(); }
}
