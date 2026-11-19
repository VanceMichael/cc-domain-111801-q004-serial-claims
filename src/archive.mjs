import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

export class Archive {
  constructor(directory) { this.directory = directory; }
  async start() {
    await mkdir(join(this.directory, 'objects'), { recursive: true });
    this.database = new DatabaseSync(join(this.directory, 'receipts.sqlite'));
    this.database.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;');
    this.database.exec(`CREATE TABLE IF NOT EXISTS evidence (
      digest TEXT PRIMARY KEY, location TEXT NOT NULL, observed_at TEXT NOT NULL, size INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS receipts (
      scope TEXT NOT NULL, business_key TEXT NOT NULL, digest TEXT NOT NULL, record TEXT NOT NULL,
      decision TEXT NOT NULL, PRIMARY KEY(scope,business_key,digest));
      CREATE TABLE IF NOT EXISTS attempts (
      scope TEXT NOT NULL, identity TEXT NOT NULL, href TEXT NOT NULL, observed_at TEXT NOT NULL,
      result TEXT NOT NULL, detail TEXT NOT NULL, hints TEXT);`);
    // 旧库迁移：收据补充取得时间，历史行保持 NULL，不抹掉已有资料。
    const columns = this.database.prepare('PRAGMA table_info(receipts)').all().map(column => column.name);
    if (!columns.includes('received_at')) this.database.exec('ALTER TABLE receipts ADD COLUMN received_at TEXT');
    return this;
  }
  async preserve(document) {
    const digest = createHash('sha256').update(document.bytes).digest('hex');
    const destination = join(this.directory, 'objects', digest);
    const temporary = destination + '.' + process.pid + '.' + crypto.randomUUID();
    const handle = await open(temporary, 'wx');
    try { await handle.writeFile(document.bytes); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, destination);
    this.database.prepare('INSERT OR IGNORE INTO evidence VALUES(?,?,?,?)').run(digest, document.location, document.observedAt, document.bytes.length);
    return digest;
  }
  put(scope, key, digest, record, decision) {
    if (!this.database.prepare('SELECT digest FROM evidence WHERE digest=?').get(digest)) throw new Error('原文尚未保存');
    this.database.prepare('INSERT OR IGNORE INTO receipts VALUES(?,?,?,?,?,?)').run(scope, key, digest, JSON.stringify(record), JSON.stringify(decision), new Date().toISOString());
  }
  attempt(scope, identity, href, result, detail, hints = null) {
    this.database.prepare('INSERT INTO attempts VALUES(?,?,?,?,?,?,?)')
      .run(scope, identity, href, new Date().toISOString(), result, detail, hints ? JSON.stringify(hints) : null);
  }
  attempts(scope) {
    return this.database.prepare('SELECT * FROM attempts WHERE scope=? ORDER BY observed_at, rowid').all(scope)
      .map(row => ({ ...row, hints: row.hints ? JSON.parse(row.hints) : null }));
  }
  records(scope) {
    return this.database.prepare('SELECT * FROM receipts WHERE scope=? ORDER BY received_at, business_key, digest').all(scope)
      .map(row => ({ ...row, record: JSON.parse(row.record), decision: JSON.parse(row.decision) }));
  }
  history(scope) {
    return this.database.prepare(`SELECT r.*, e.location, e.observed_at FROM receipts r
      LEFT JOIN evidence e ON e.digest=r.digest WHERE r.scope=?
      ORDER BY r.received_at, r.business_key, r.digest`).all(scope)
      .map(row => ({ ...row, record: JSON.parse(row.record), decision: JSON.parse(row.decision) }));
  }
  async original(digest) {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('原文摘要无效');
    const content = await readFile(join(this.directory, 'objects', digest));
    if (createHash('sha256').update(content).digest('hex') !== digest) throw new Error('原文完整性校验失败');
    return content;
  }
  close() { this.database?.close(); }
}
