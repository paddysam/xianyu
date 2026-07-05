const mysql = require('mysql2/promise');
require('dotenv').config();

const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'xianyu_assistant',
  waitForConnections: true,
  connectionLimit: 10,
  charset: 'utf8mb4',
  // 允许 init-db 里一次执行多条语句
  multipleStatements: true
});

module.exports = pool;
