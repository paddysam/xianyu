/**
 * 初始化数据库：若库不存在则创建，再执行 schema.sql 建表。
 * 用法：node init-db.js
 */
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config();

(async () => {
  const dbName = process.env.DB_NAME || 'xianyu_assistant';
  const base = {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    multipleStatements: true
  };

  let conn;
  try {
    conn = await mysql.createConnection(base);
    await conn.query(
      `CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await conn.changeUser({ database: dbName });
    const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await conn.query(sql);
    console.log(`✓ 数据库 ${dbName} 及表结构已就绪`);
  } catch (e) {
    console.error('✗ 初始化失败：', e.message);
    console.error('  请检查 .env 里的 MySQL 连接信息，并确认 MySQL 已启动。');
    process.exit(1);
  } finally {
    if (conn) await conn.end();
  }
})();
