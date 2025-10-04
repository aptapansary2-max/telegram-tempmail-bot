const mysql = require('mysql2/promise');

// Create connection pool
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT || 3306,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
  connectTimeout: 20000, // 20 seconds timeout
  acquireTimeout: 20000,
  timezone: '+00:00'
});

// Initialize database tables
async function initDatabase() {
  let retries = 3;
  while (retries > 0) {
    try {
      // Test connection first
      const connection = await pool.getConnection();
      console.log('✅ Database connection successful');
      connection.release();

      // Create user_sessions table if not exists
      await pool.query(`
        CREATE TABLE IF NOT EXISTS user_sessions (
          id INT AUTO_INCREMENT PRIMARY KEY,
          telegram_id BIGINT NOT NULL,
          email VARCHAR(255) NOT NULL,
          password VARCHAR(255) NOT NULL,
          token TEXT NOT NULL,
          recovery_email VARCHAR(255) DEFAULT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          last_access TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY unique_telegram_email (telegram_id, email),
          INDEX idx_telegram_id (telegram_id),
          INDEX idx_email (email)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);

    // Verify existing emails table
    const [tables] = await pool.query(`
      SHOW TABLES LIKE 'emails'
    `);

    if (tables.length === 0) {
      // Create emails table if not exists (from your existing PHP code)
      await pool.query(`
        CREATE TABLE IF NOT EXISTS emails (
          id INT AUTO_INCREMENT PRIMARY KEY,
          email VARCHAR(255) NOT NULL UNIQUE,
          password VARCHAR(255) NOT NULL,
          token TEXT NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          last_access TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_email (email)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
    }

    console.log('✅ Database tables verified/created');
    return;
  } catch (error) {
    console.error(`❌ Error initializing database (${retries} retries left):`, error.message);
    retries--;
    if (retries > 0) {
      console.log('🔄 Retrying in 5 seconds...');
      await new Promise(resolve => setTimeout(resolve, 5000));
    } else {
      console.error('❌ Failed to initialize database after all retries');
      throw error;
    }
  }
}
}

// Helper: Update last access timestamp
async function updateLastAccess(email) {
  try {
    await pool.query(
      'UPDATE emails SET last_access = NOW() WHERE email = ?',
      [email]
    );
  } catch (error) {
    console.error('Error updating last access:', error);
  }
}

// Helper: Save email to database
async function saveEmail(email, password, token) {
  try {
    await pool.query(
      `INSERT INTO emails (email, password, token, created_at, last_access) 
       VALUES (?, ?, ?, NOW(), NOW())
       ON DUPLICATE KEY UPDATE 
       password = VALUES(password), 
       token = VALUES(token),
       last_access = NOW()`,
      [email, password, token]
    );
  } catch (error) {
    console.error('Error saving email:', error);
    throw error;
  }
}

// Helper: Get email from database
async function getEmail(email) {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM emails WHERE email = ?',
      [email]
    );
    return rows.length > 0 ? rows[0] : null;
  } catch (error) {
    console.error('Error getting email:', error);
    return null;
  }
}

module.exports = {
  pool,
  initDatabase,
  updateLastAccess,
  saveEmail,
  getEmail
};
