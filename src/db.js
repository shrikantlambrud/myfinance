'use strict';
// Thin wrapper over mysql2 so the rest of the app only sees: all / get / run / tx.
// Tests plug in a different implementation with the same four methods.

function clean(params) {
  return (params || []).map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p));
}

function wrap(conn) {
  return {
    async all(sql, params) { const [rows] = await conn.query(sql, clean(params)); return rows; },
    async get(sql, params) { const [rows] = await conn.query(sql, clean(params)); return rows[0] || null; },
    async run(sql, params) {
      const [res] = await conn.query(sql, clean(params));
      return { insertId: res.insertId, affectedRows: res.affectedRows };
    },
  };
}

function createMysqlDb(dbCfg) {
  const mysql = require('mysql2/promise');
  const pool = mysql.createPool({
    host: dbCfg.host, port: dbCfg.port, user: dbCfg.user, password: dbCfg.password, database: dbCfg.database,
    waitForConnections: true, connectionLimit: 10, charset: 'utf8mb4',
    dateStrings: true,      // DATE/DATETIME come back as plain strings, never JS Date objects (no timezone drift)
    decimalNumbers: true,   // DECIMAL comes back as a number, not a string
  });
  pool.pool.on('connection', (conn) => {
    conn.query(`SET time_zone = '${dbCfg.tzOffset}'`);
  });
  const base = wrap(pool);
  return {
    ...base,
    async tx(fn) {
      for (let attempt = 0; ; attempt++) {
        const conn = await pool.getConnection();
        try {
          await conn.beginTransaction();
          const out = await fn(wrap(conn));
          await conn.commit();
          return out;
        } catch (e) {
          await conn.rollback().catch(() => {});
          // 1213 = deadlock, 1205 = lock wait timeout: safe to retry the whole transaction
          if ((e.errno === 1213 || e.errno === 1205) && attempt < 2) continue;
          throw e;
        } finally {
          conn.release();
        }
      }
    },
    async close() { await pool.end(); },
  };
}

module.exports = { createMysqlDb };
