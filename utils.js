const axios = require('axios');
const { saveEmail, updateLastAccess } = require('./db');

const MAIL_TM_API = process.env.MAIL_TM_API || 'https://api.mail.tm';

// Generate random username
function generateUsername() {
  const prefixes = ['temp', 'quick', 'fast', 'instant', 'rapid', 'swift', 'flash', 'pro', 'cool', 'smart'];
  const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
  const number = Math.floor(Math.random() * 900000) + 100000;
  return `${prefix}${number}`;
}

// Generate random password
function generatePassword() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%';
  let password = 'TempMail';
  for (let i = 0; i < 8; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return password + '!';
}

// Get available domains from Mail.tm
async function getAvailableDomains() {
  try {
    const response = await axios.get(`${MAIL_TM_API}/domains`, {
      timeout: 10000
    });
    
    if (response.data && response.data['hydra:member']) {
      return response.data['hydra:member'].map(d => d.domain);
    }
    
    return [];
  } catch (error) {
    console.error('Error fetching domains:', error.message);
    return [];
  }
}

// Generate new email account
async function generateNewEmail() {
  try {
    // Get available domains
    const domains = await getAvailableDomains();
    
    if (domains.length === 0) {
      return { error: 'No domains available' };
    }

    const domain = domains[Math.floor(Math.random() * domains.length)];
    const username = generateUsername();
    const email = `${username}@${domain}`;
    const password = generatePassword();

    // Create account
    const createResponse = await axios.post(
      `${MAIL_TM_API}/accounts`,
      {
        address: email,
        password: password
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 15000
      }
    );

    if (createResponse.status !== 201) {
      return { error: 'Failed to create account' };
    }

    // Get token
    const tokenResponse = await axios.post(
      `${MAIL_TM_API}/token`,
      {
        address: email,
        password: password
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 15000
      }
    );

    if (!tokenResponse.data || !tokenResponse.data.token) {
      return { error: 'Failed to get token' };
    }

    const token = tokenResponse.data.token;

    // Save to database
    await saveEmail(email, password, token);

    return {
      email,
      password,
      token,
      domain
    };
  } catch (error) {
    console.error('Error generating email:', error.message);
    return { error: error.message };
  }
}

// Get inbox messages
async function getInbox(token, email) {
  try {
    const response = await axios.get(
      `${MAIL_TM_API}/messages`,
      {
        headers: { 'Authorization': `Bearer ${token}` },
        timeout: 10000
      }
    );

    if (response.status === 401) {
      // Token expired, return empty to trigger refresh
      return [];
    }

    const messages = response.data['hydra:member'] || [];
    
    // Update last access
    await updateLastAccess(email);

    return messages.map(msg => ({
      from: msg.from.address,
      subject: msg.subject,
      id: msg.id,
      createdAt: msg.createdAt,
      hasAttachments: msg.attachments && msg.attachments.length > 0,
      seen: msg.seen,
      text: msg.text,
      html: msg.html
    }));
  } catch (error) {
    if (error.response && error.response.status === 401) {
      return []; // Token expired
    }
    console.error('Error fetching inbox:', error.message);
    return [];
  }
}

// Get full message content
async function getMessageContent(token, messageId, email) {
  try {
    const response = await axios.get(
      `${MAIL_TM_API}/messages/${messageId}`,
      {
        headers: { 'Authorization': `Bearer ${token}` },
        timeout: 10000
      }
    );

    if (response.status === 401) {
      return null;
    }

    // Update last access
    await updateLastAccess(email);

    return response.data;
  } catch (error) {
    console.error('Error fetching message:', error.message);
    return null;
  }
}

// Delete message
async function deleteMessage(token, messageId, email) {
  try {
    await axios.delete(
      `${MAIL_TM_API}/messages/${messageId}`,
      {
        headers: { 'Authorization': `Bearer ${token}` },
        timeout: 10000
      }
    );

    // Update last access
    await updateLastAccess(email);

    return true;
  } catch (error) {
    console.error('Error deleting message:', error.message);
    return false;
  }
}

// Extract OTP from message text
function extractOTP(text) {
  if (!text) return null;

  // Remove HTML tags if present
  const cleanText = text.replace(/<[^>]*>/g, ' ');

  // Common OTP patterns (ordered by specificity)
  const patterns = [
    // Specific context patterns (more reliable)
    /(?:OTP|code|verification code|verification|pin|passcode)[\s:]*[\(\[]?(\d{4,8})[\)\]]?/gi,
    /(?:Your code is|code is|your otp is|your pin is)[\s:]*[\(\[]?(\d{4,8})[\)\]]?/gi,
    /(\d{4,8})(?:\s+(?:is your|is the|is your verification))/gi,
    // Standalone digit patterns (less reliable, checked last)
    /\b(\d{6})\b/g,  // 6-digit codes (most common)
    /\b(\d{4})\b/g,  // 4-digit codes
    /\b(\d{8})\b/g,  // 8-digit codes
    /\b([A-Z0-9]{6})\b/g  // 6-char alphanumeric
  ];

  for (const pattern of patterns) {
    pattern.lastIndex = 0; // Reset regex
    const match = pattern.exec(cleanText);
    
    if (match && match[1]) {
      const code = match[1].trim();
      // Validate code length
      if (code.length >= 4 && code.length <= 8) {
        // Extra validation: avoid common false positives
        if (!/^(1234|0000|9999|1111|2222)/.test(code)) {
          return code;
        }
      }
    }
  }

  return null;
}

// Refresh token for expired sessions
async function refreshToken(email, password) {
  try {
    const tokenResponse = await axios.post(
      `${MAIL_TM_API}/token`,
      {
        address: email,
        password: password
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 15000
      }
    );

    if (tokenResponse.data && tokenResponse.data.token) {
      // Update token in database
      await saveEmail(email, password, tokenResponse.data.token);
      return tokenResponse.data.token;
    }

    return null;
  } catch (error) {
    console.error('Error refreshing token:', error.message);
    return null;
  }
}

module.exports = {
  generateNewEmail,
  getInbox,
  getMessageContent,
  deleteMessage,
  extractOTP,
  refreshToken,
  generateUsername,
  generatePassword
};
