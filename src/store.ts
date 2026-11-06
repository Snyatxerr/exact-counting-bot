import { initial, type State } from "./game";
export const SCHEMA = `CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,score INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS processed(id TEXT PRIMARY KEY,result TEXT NOT NULL,created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS processed_created ON processed(created);
CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,payload TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,next INTEGER NOT NULL,lease INTEGER NOT NULL DEFAULT 0,created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS outbox_due ON outbox(status,next);
CREATE INDEX IF NOT EXISTS outbox_cleanup ON outbox(status,created);
CREATE TABLE IF NOT EXISTS pending(id TEXT PRIMARY KEY,attempts INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS milestones(run INTEGER,value TEXT,PRIMARY KEY(run,value));`;
export class Store {
  constructor(
    public sql: SqlStorage,
    public atomic: <T>(fn: () => T) => T,
  ) {
    for (const statement of SCHEMA.split(";"))
      if (statement.trim()) sql.exec(statement);
  }
  rows<T extends Record<string, SqlStorageValue>>(
    q: string,
    ...v: SqlStorageValue[]
  ): T[] {
    return this.sql.exec<T>(q, ...v).toArray();
  }
  get<T>(key: string, fallback: T): T {
    const r = this.rows("SELECT value FROM meta WHERE key=?", key)[0];
    return r ? JSON.parse(String(r.value)) : fallback;
  }
  put(key: string, value: unknown) {
    this.sql.exec(
      "INSERT OR REPLACE INTO meta VALUES(?,?)",
      key,
      JSON.stringify(value),
    );
  }
  state() {
    return this.get<State>("state", initial());
  }
  save(s: State) {
    this.put("state", s);
  }
  seen(id: string) {
    return this.rows("SELECT id FROM processed WHERE id=?", id).length > 0;
  }
  done(id: string, result: string) {
    this.sql.exec(
      "INSERT INTO processed VALUES(?,?,?)",
      id,
      result,
      Date.now(),
    );
    this.sql.exec("DELETE FROM pending WHERE id=?", id);
  }
  queue(id: string, payload: unknown) {
    this.sql.exec(
      "INSERT OR IGNORE INTO outbox(id,payload,next,created) VALUES(?,?,?,?)",
      id,
      JSON.stringify(payload),
      Date.now(),
      Date.now(),
    );
  }
  cleanup() {
    const cutoff = Date.now() - 30 * 86400000;
    this.atomic(() => {
      const rows = this.rows(
        "SELECT id FROM processed WHERE created<? ORDER BY length(id) DESC,id DESC LIMIT 1",
        cutoff,
      );
      if (rows.length) {
        const id = String(rows[0].id),
          old = this.get("floor", "0");
        if (BigInt(id) > BigInt(old)) this.put("floor", id);
      }
      this.sql.exec("DELETE FROM processed WHERE created<?", cutoff);
      this.sql.exec(
        "DELETE FROM outbox WHERE created<? AND status IN ('done','failed')",
        cutoff,
      );
      // rowid range bounds the count from above. Avoid scanning all retained
      // rows every minute when fewer than 10,000 rows can possibly exist.
      const span = this.rows(
        "SELECT (SELECT MAX(rowid) FROM processed)-(SELECT MIN(rowid) FROM processed)+1 AS span",
      )[0];
      const excess = Number(span?.span ?? 0) >= 10000 ? this.rows(
        "SELECT id FROM processed ORDER BY length(id) DESC,id DESC LIMIT 1 OFFSET 9999",
      ) : [];
      if (excess[0]) {
        const id = String(excess[0].id),
          old = this.get("floor", "0");
        if (BigInt(id) > BigInt(old)) this.put("floor", id);
        this.sql.exec(
          "DELETE FROM processed WHERE length(id)<? OR (length(id)=? AND id<=?)",
          id.length,
          id.length,
          id,
        );
      }
    });
  }
}
