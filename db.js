const mysql = require('mysql2/promise');

// MySQL connection configuration (using your hosting database)
const dbConfig = {
  host: process.env.DB_HOST || 'cashearnersofficial.xyz/',
  user: process.env.DB_USER || 'cztldhwx_tampemail',
  password: process.env.DB_PASS || 'Aptap786920',
  database: process.env.DB_NAME || 'cztldhwx_tampemail',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  connectTimeout: 30000,
  acquireTimeout: 30000,
  timeout: 30000
};

// Create connection pool
const pool = mysql.createPool(dbConfig);

// Test database connection
async function testConnection() {
  try {
    const connection = await pool.getConnection();
    console.log('✅ MySQL database connected successfully!');
    connection.release();
    return true;
  } catch (error) {
    console.error('❌ MySQL connection failed:', error.message);
    return false;
  }
}

// Initialize database tables (create if not exists)
async function initDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS emails (
        id INT AUTO_INCREMENT PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        token TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_access DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_email (email),
        INDEX idx_created (created_at),
        INDEX idx_last_access (last_access)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    
    console.log('✅ Database table "emails" ready');
    
    // Optional: Create table for recovery emails (if needed in future)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS recovery_links (
        id INT AUTO_INCREMENT PRIMARY KEY,
        email VARCHAR(255) NOT NULL,
        recovery_email VARCHAR(255) NOT NULL,
        linked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (email) REFERENCES emails(email) ON DELETE CASCADE,
        INDEX idx_recovery (recovery_email)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    
    console.log('✅ Database table "recovery_links" ready');
    
    // Create table for message tracking (optional, for analytics)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS messages_log (
        id INT AUTO_INCREMENT PRIMARY KEY,
        email VARCHAR(255) NOT NULL,
        message_id VARCHAR(255) NOT NULL,
        from_address VARCHAR(255),
        subject TEXT,
        has_otp BOOLEAN DEFAULT FALSE,
        received_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_email_log (email),
        INDEX idx_message_id (message_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    
    console.log('✅ Database table "messages_log" ready');
    
    return true;
  } catch (error) {
    console.error('❌ Database initialization error:', error.message);
    throw error;
  }
}

// Clean up old emails (optional - run periodically to remove expired emails)
async function cleanupOldEmails(daysOld = 7) {
  try {
    const [result] = await pool.query(
      'DELETE FROM emails WHERE last_access < DATE_SUB(NOW(), INTERVAL ? DAY)',
      [daysOld]
    );
    
    console.log(`🗑️ Cleaned up ${result.affectedRows} old emails`);
    return result.affectedRows;
  } catch (error) {
    console.error('Cleanup error:', error.message);
    return 0;
  }
}

// Get email details from database
async function getEmailFromDB(email) {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM emails WHERE email = ?',
      [email]
    );
    return rows[0] || null;
  } catch (error) {
    console.error('Get email error:', error.message);
    return null;
  }
}

// Update last access time
async function updateLastAccess(email) {
  try {
    await pool.query(
      'UPDATE emails SET last_access = NOW() WHERE email = ?',
      [email]
    );
    return true;
  } catch (error) {
    console.error('Update last access error:', error.message);
    return false;
  }
}

// Update token in database
async function updateToken(email, newToken) {
  try {
    await pool.query(
      'UPDATE emails SET token = ?, last_access = NOW() WHERE email = ?',
      [newToken, email]
    );
    return true;
  } catch (error) {
    console.error('Update token error:', error.message);
    return false;
  }
}

// Log message receipt (optional - for analytics)
async function logMessage(email, messageId, fromAddress, subject, hasOTP = false) {
  try {
    await pool.query(
      'INSERT INTO messages_log (email, message_id, from_address, subject, has_otp) VALUES (?, ?, ?, ?, ?)',
      [email, messageId, fromAddress, subject, hasOTP]
    );
    return true;
  } catch (error) {
    // Ignore duplicate key errors
    if (error.code !== 'ER_DUP_ENTRY') {
      console.error('Log message error:', error.message);
    }
    return false;
  }
}

// Get statistics (optional - for admin panel)
async function getStats() {
  try {
    const [emailCount] = await pool.query('SELECT COUNT(*) as total FROM emails');
    const [messageCount] = await pool.query('SELECT COUNT(*) as total FROM messages_log');
    const [otpCount] = await pool.query('SELECT COUNT(*) as total FROM messages_log WHERE has_otp = TRUE');
    
    return {
      totalEmails: emailCount[0].total,
      totalMessages: messageCount[0].total,
      totalOTPs: otpCount[0].total
    };
  } catch (error) {
    console.error('Get stats error:', error.message);
    return null;
  }
}

module.exports = {
  pool,
  testConnection,
  initDatabase,
  cleanupOldEmails,
  getEmailFromDB,
  updateLastAccess,
  updateToken,
  logMessage,
  getStats
};
