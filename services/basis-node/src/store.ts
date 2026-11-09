/** SQLite read model (node:sqlite). A projection only: the contract stays the accounting
 * authority and every row links back to a contract event seq, report id or tx hash. */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, ts_ns TEXT, block INTEGER, kind TEXT, data TEXT);
      CREATE TABLE IF NOT EXISTS marks (id INTEGER PRIMARY KEY AUTOINCREMENT, market TEXT, ts_ms INTEGER, mids TEXT, bids TEXT, asks TEXT, report_id TEXT, source_chain TEXT);
      CREATE INDEX IF NOT EXISTS marks_market_ts ON marks(market, ts_ms);
      CREATE TABLE IF NOT EXISTS vault (ts_ms INTEGER PRIMARY KEY, nav TEXT, share_price TEXT, free TEXT, reserve TEXT, stress TEXT, insurance TEXT, supply TEXT, open_margin TEXT, fees TEXT);
      CREATE TABLE IF NOT EXISTS exec_fills (fill_id TEXT PRIMARY KEY, order_id TEXT, market TEXT, outcome INTEGER, units TEXT, price TEXT, tx TEXT, ts_ms INTEGER, side TEXT DEFAULT 'buy', simulated INTEGER DEFAULT 1);
      CREATE TABLE IF NOT EXISTS live_spend (day TEXT PRIMARY KEY, usd REAL);
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
    `);
    this.migrate();
  }
  private migrate() {
    for (const col of ["side TEXT DEFAULT 'buy'", "simulated INTEGER DEFAULT 1"]) {
      try {
        this.db.exec(`ALTER TABLE exec_fills ADD COLUMN ${col}`);
      } catch {
        /* column exists */
      }
    }
  }
  get(k: string): string | undefined {
    return (this.db.prepare("SELECT v FROM meta WHERE k = ?").get(k) as any)?.v;
  }
  set(k: string, v: string) {
    this.db.prepare("INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, v);
  }
  insertEvent(e: { seq: string; ts_ns: string; block: string; kind: string; data: string }) {
    this.db.prepare("INSERT OR IGNORE INTO events(seq, ts_ns, block, kind, data) VALUES(?, ?, ?, ?, ?)").run(Number(e.seq), e.ts_ns, Number(e.block), e.kind, e.data);
  }
  lastSeq(): number {
    return Number((this.db.prepare("SELECT MAX(seq) AS s FROM events").get() as any)?.s ?? 0);
  }
  events(from: number, limit: number, kind?: string) {
    const q = kind
      ? this.db.prepare("SELECT * FROM events WHERE seq >= ? AND kind = ? ORDER BY seq DESC LIMIT ?").all(from, kind, limit)
      : this.db.prepare("SELECT * FROM events WHERE seq >= ? ORDER BY seq DESC LIMIT ?").all(from, limit);
    return (q as any[]).map((r) => ({ ...r, data: JSON.parse(r.data) }));
  }
  insertMark(m: { market: string; ts_ms: number; mids: string[]; bids: string[]; asks: string[]; report_id: string; source_chain: string }) {
    this.db
      .prepare("INSERT INTO marks(market, ts_ms, mids, bids, asks, report_id, source_chain) VALUES(?, ?, ?, ?, ?, ?, ?)")
      .run(m.market, m.ts_ms, JSON.stringify(m.mids), JSON.stringify(m.bids), JSON.stringify(m.asks), m.report_id, m.source_chain);
  }
  marks(market: string, sinceMs: number, limit = 500) {
    const rows = this.db.prepare("SELECT * FROM marks WHERE market = ? AND ts_ms >= ? ORDER BY ts_ms DESC LIMIT ?").all(market, sinceMs, limit) as any[];
    return rows.reverse().map((r) => ({ ...r, mids: JSON.parse(r.mids), bids: JSON.parse(r.bids), asks: JSON.parse(r.asks) }));
  }
  insertVault(v: Record<string, string | number>) {
    this.db
      .prepare("INSERT OR REPLACE INTO vault(ts_ms, nav, share_price, free, reserve, stress, insurance, supply, open_margin, fees) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(v.ts_ms, v.nav, v.share_price, v.free, v.reserve, v.stress, v.insurance, v.supply, v.open_margin, v.fees);
  }
  vault(sinceMs: number, limit = 1000) {
    return (this.db.prepare("SELECT * FROM vault WHERE ts_ms >= ? ORDER BY ts_ms DESC LIMIT ?").all(sinceMs, limit) as any[]).reverse();
  }
  insertFill(f: { fill_id: string; order_id: string | null; market: string; outcome: number; units: string; price: string; tx: string; side?: string; simulated?: boolean }) {
    this.db
      .prepare("INSERT OR IGNORE INTO exec_fills(fill_id, order_id, market, outcome, units, price, tx, ts_ms, side, simulated) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(f.fill_id, f.order_id, f.market, f.outcome, f.units, f.price, f.tx, Date.now(), f.side ?? "buy", f.simulated === false ? 0 : 1);
  }
  spentToday(): number {
    const day = new Date().toISOString().slice(0, 10);
    return Number((this.db.prepare("SELECT usd FROM live_spend WHERE day = ?").get(day) as any)?.usd ?? 0);
  }
  recordSpend(usd: number) {
    const day = new Date().toISOString().slice(0, 10);
    this.db.prepare("INSERT INTO live_spend(day, usd) VALUES(?, ?) ON CONFLICT(day) DO UPDATE SET usd = usd + excluded.usd").run(day, usd);
  }
  fills(market?: string) {
    return (market ? this.db.prepare("SELECT * FROM exec_fills WHERE market = ?").all(market) : this.db.prepare("SELECT * FROM exec_fills").all()) as any[];
  }
}
