const axios = require('axios');
const { getPool } = require('./db');

// Generate temporary email
async function generateTempEmail(chatId) {
  try {
    // Get available domains
    const domainsResp = await axios.get('https://api.mail.tm/domains');
    const domains = domainsResp.data['hydra:member'];
    
    if (!domains || domains.length === 0) {
      return null;
    }

    const domain = domains[Math.floor(Math.random() * domains.length)].domain;
    
    // Generate random username
    const prefixes = ['temp', 'quick', 'fast', 'instant', 'rapid', 'swift', 'flash'];
    const username = prefixes[Math.floor(Math.random() * prefixes.length)] + 
                     Math.floor(Math.random() * 900000 + 100000);
    const email = `${username}@${domain}`;
    const password = `TempMail${Math.floor(Math.random() * 900 + 100)}!`;

    // Create account
    const createResp = await axios.post('https://api.mail.tm/accounts', {
      address: email,
      password: password
    });

    if (createResp.status !== 201) {
      return null;
    }

    // Get token
    const tokenResp = await axios.post('https://api.mail.tm/token', {
      address: email,
      password: password
    });

    if (!tokenResp.data.token) {
      return null;
    }

    const token = tokenResp.data.token;
    const pool = getPool();

    // Save to database
    await pool.query(
      'INSERT INTO user_emails (chat_id, email, password, token) VALUES (?, ?, ?, ?)',
      [chatId, email, password, token]
    );

    // Update current email for user
    await pool.query(
      'UPDATE telegram_users SET current_email = ?, current_token = ? WHERE chat_id = ?',
      [email, token, chatId]
    );

    return { email, password, token };
  } catch (error) {
    console.error('Error generating temp email:', error.message);
    return null;
  }
}

// Refresh token
async function refreshToken(email, password, chatId) {
  try {
    const tokenResp = await axios.post('https://api.mail.tm/token', {
      address: email,
      password: password
    });

    if (!tokenResp.data.token) {
      return null;
    }

    const newToken = tokenResp.data.token;
    const pool = getPool();

    // Update in database
    await pool.query(
      'UPDATE user_emails SET token = ? WHERE email = ? AND chat_id = ?',
      [newToken, email, chatId]
    );

    await pool.query(
      'UPDATE telegram_users SET current_token = ? WHERE chat_id = ?',
      [newToken, chatId]
    );

    return newToken;
  } catch (error) {
    console.error('Error refreshing token:', error.message);
    return null;
  }
}

// Get inbox messages
async function getInboxMessages(token) {
  try {
    const response = await axios.get('https://api.mail.tm/messages', {
      headers: { Authorization: `Bearer ${token}` }
    });
    return response.data;
  } catch (error) {
    console.error('Error fetching inbox:', error.message);
    return null;
  }
}

// Get message details
async function getMessageContent(messageId, token) {
  try {
    const response = await axios.get(`https://api.mail.tm/messages/${messageId}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    return response.data;
  } catch (error) {
    console.error('Error fetching message:', error.message);
    return null;
  }
}

// Extract OTP from text
function extractOTP(text) {
  // Match 4-8 digit OTP patterns
  const otpPatterns = [
    /\b(\d{4})\b/,
    /\b(\d{5})\b/,
    /\b(\d{6})\b/,
    /\b(\d{7})\b/,
    /\b(\d{8})\b/,
    /code[:\s]+(\d{4,8})/i,
    /otp[:\s]+(\d{4,8})/i,
    /verification[:\s]+(\d{4,8})/i,
    /pin[:\s]+(\d{4,8})/i
  ];

  for (const pattern of otpPatterns) {
    const match = text.match(pattern);
    if (match) {
      return match[1];
    }
  }

  return null;
}

// Format email content
function formatEmailContent(messageDetails) {
  let content = messageDetails.text || messageDetails.html || '';
  
  // Strip HTML tags
  content = content.replace(/<[^>]*>/g, ' ');
  
  // Remove extra whitespace
  content = content.replace(/\s+/g, ' ').trim();
  
  // Limit length
  if (content.length > 500) {
    content = content.substring(0, 500) + '...';
  }

  return content;
}

module.exports = {
  generateTempEmail,
  refreshToken,
  getInboxMessages,
  getMessageContent,
  extractOTP,
  formatEmailContent
};
