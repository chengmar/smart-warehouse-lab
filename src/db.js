import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import mysql from 'mysql2/promise';

export async function openDB(config = process.env) {
  const driver = config.DB_DRIVER || 'sqlite';
  if (!['sqlite', 'mysql'].includes(driver)) throw Error('未知数据库类型');
  const isMysql = driver === 'mysql';
  let pool, file;
  if (isMysql) {
    pool = mysql.createPool({host:config.MYSQL_HOST || '127.0.0.1', port:Number(config.MYSQL_PORT || 3306),
      user:config.MYSQL_USER, password:config.MYSQL_PASSWORD, database:config.MYSQL_DATABASE,
      connectionLimit:6, decimalNumbers:true, charset:'utf8mb4_bin'});
  } else {
    const path = config.SQLITE_PATH || 'data/warehouse.sqlite';
    if (path !== ':memory:') await mkdir(dirname(path), {recursive:true});
    file = new DatabaseSync(path);
    file.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
  }
  function adapter(connection) {
    const rows = async (sql, values=[]) => isMysql ? (await connection.execute(sql,values))[0] : file.prepare(sql).all(...values);
    return {rows, one:async (sql,values) => (await rows(sql,values))[0],
      run:async (sql,values=[]) => isMysql ? (await connection.execute(sql,values))[0].affectedRows : file.prepare(sql).run(...values).changes};
  }
  const initial = adapter(pool);
  try {
    const schema = await readFile(new URL('./schema.sql',import.meta.url),'utf8');
    for (const sql of schema.split(';').filter(s=>s.trim())) await initial.run(sql);
    await initial.run(isMysql ? 'INSERT IGNORE INTO system_lock (id) VALUES (1)' : 'INSERT OR IGNORE INTO system_lock (id) VALUES (1)');
  } catch (error) { if (pool) await pool.end(); else file.close(); throw error; }
  let queue=Promise.resolve();
  async function transaction(work) {
    const conn = isMysql ? await pool.getConnection() : null;
    try {
      if (isMysql) {await conn.beginTransaction(); await conn.query('SELECT id FROM system_lock WHERE id=1 FOR UPDATE');}
      else file.exec('BEGIN IMMEDIATE');
      const result=await work(adapter(conn));
      if (isMysql) await conn.commit(); else file.exec('COMMIT');
      return result;
    } catch (error) {
      if (isMysql) await conn.rollback(); else if (file.isTransaction) file.exec('ROLLBACK');
      throw error;
    } finally {conn?.release();}
  }
  return {driver, tx(work) {
    if (isMysql) return transaction(work);
    const next=queue.then(()=>transaction(work)); queue=next.catch(()=>{}); return next;
  }, async close(){await queue; if(pool) await pool.end(); else file.close();}};
}
