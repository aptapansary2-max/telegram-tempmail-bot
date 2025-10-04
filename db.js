const mysql = require('mysql2/promise');
require('dotenv').config();

let pool;

async function initDatabase() {
  try {
    pool = mysql.createPool({
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASS,
      database: process.env.DB_NAME,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0
    });

    // Create tables if not exist
    await pool.query(`
      CREATE TABLE IF NOT EXISTS telegram_users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        chat_id BIGINT UNIQUE,
        username VARCHAR(100),
        first_name VARCHAR(100),
        current_email VARCHAR(255),
        current_token VARCHAR(500),
        recovery_email VARCHAR(255),
        recovery_mode BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_activity TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_emails (
        id INT AUTO_INCREMENT PRIMARY KEY,
        chat_id BIGINT,
        email VARCHAR(255),
        password VARCHAR(255),
        token VARCHAR(500),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_access TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX(chat_id),
        INDEX(email)
      )
    `);

    console.log('✅ Database initialized successfully');
  } catch (error) {
    console.error('❌ Database initialization error:', error);
    throw error;
  }
}

function getPool() {
  if (!pool) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return pool;
}

module.exports = {
  initDatabase,
  getPool
};
