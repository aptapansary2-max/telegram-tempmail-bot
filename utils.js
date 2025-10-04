const axios = require('axios');

// Mail.tm API base URL
const API_BASE = 'https://api.mail.tm';

// Generate temporary email
async function generateTempEmail() {
  try {
    // Step 1: Get available domains
    const domainsResponse = await axios.get(`${API_BASE}/domains`);
    const domains = domainsResponse.data['hydra:member'];
    
    if (!domains || domains.length === 0) {
      return { error: 'No domains available' };
    }
    
    const domain = domains[Math.floor(Math.random() * domains.length)].domain;
    
    // Step 2: Generate random username
    const prefixes = ['temp', 'quick', 'fast', 'instant', 'rapid', 'swift', 'flash', 'zen', 'cool', 'neo'];
    const username = prefixes[Math.floor(Math.random() * prefixes.length)] + 
                     Math.floor(100000 + Math.random() * 900000);
    
    const email = `${username}@${domain}`;
    const password = `TempMail${Math.floor(100 + Math.random() * 900)}!@#`;
    
    // Step 3: Create account
    try {
      await axios.post(`${API_BASE}/accounts`, {
        address: email,
        password: password
      }, {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (createError) {
      if (createError.response) {
        return { error: `Account creation failed: ${createError.response.data.message || createError.message}` };
      }
      return { error: `Account creation failed: ${createError.message}` };
    }
    
    // Step 4: Get authentication token
    try {
      const tokenResponse = await axios.post(`${API_BASE}/token`, {
        address: email,
        password: password
      }, {
        headers: { 'Content-Type': 'application/json' }
      });
      
      return {
        email: email,
        password: password,
        token: tokenResponse.data.token,
        domains: domains.map(d => d.domain)
      };
    } catch (tokenError) {
      if (tokenError.response) {
        return { error: `Token generation failed: ${tokenError.response.data.message || tokenError.message}` };
      }
      return { error: `Token generation failed: ${tokenError.message}` };
    }
    
  } catch (error) {
    console.error('Generate email error:', error.message);
    return { error: error.message };
  }
}

// Refresh authentication token
async function refreshToken(email, password) {
  try {
    const response = await axios.post(`${API_BASE}/token`, {
      address: email,
      password: password
    }, {
      headers: { 'Content-Type': 'application/json' }
    });
    
    return response.data.token;
  } catch (error) {
    console.error('Token refresh error:', error.message);
    return null;
  }
}

// Get inbox messages
async function getInbox(token) {
  try {
    const response = await axios.get(`${API_BASE}/messages`, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });
    
    const messages = response.data['hydra:member'] || [];
    
    return messages.map(msg => ({
      id: msg.id,
      from: msg.from?.address || 'Unknown',
      subject: msg.subject || 'No Subject',
      intro: msg.intro || '',
      createdAt: msg.createdAt,
      hasAttachments: msg.hasAttachments || false,
      seen: msg.seen || false
    }));
    
  } catch (error) {
    if (error.response && error.response.status === 401) {
      return { error: '401 Unauthorized - Token expired' };
    }
    console.error('Get inbox error:', error.message);
    return { error: error.message };
  }
}

// Get full message details
async function getMessage(token, messageId) {
  try {
    const response = await axios.get(`${API_BASE}/messages/${messageId}`, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });
    
    return {
      id: response.data.id,
      from: response.data.from?.address || 'Unknown',
      to: response.data.to || [],
      subject: response.data.subject || 'No Subject',
      intro: response.data.intro || '',
      text: response.data.text || '',
      html: response.data.html || '',
      hasAttachments: response.data.hasAttachments || false,
      attachments: response.data.attachments || [],
      createdAt: response.data.createdAt
    };
    
  } catch (error) {
    console.error('Get message error:', error.message);
    return { error: error.message };
  }
}

// Delete message
async function deleteMessage(token, messageId) {
  try {
    await axios.delete(`${API_BASE}/messages/${messageId}`, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });
    return { success: true };
  } catch (error) {
    console.error('Delete message error:', error.message);
    return { error: error.message };
  }
}

// Detect OTP from message content
function detectOTP(content) {
  if (!content) return null;
  
  // Remove HTML tags
  const cleanContent = content.replace(/<[^>]*>/g, ' ');
  
  // Multiple OTP patterns
  const patterns = [
    /\b(\d{4})\b/,                    // 4-digit OTP
    /\b(\d{5})\b/,                    // 5-digit OTP
    /\b(\d{6})\b/,                    // 6-digit OTP (most common)
    /\b(\d{8})\b/,                    // 8-digit OTP
    /code[:\s]+(\d{4,8})/i,           // "code: 123456"
    /verification[:\s]+(\d{4,8})/i,   // "verification: 123456"
    /otp[:\s]+(\d{4,8})/i,            // "OTP: 123456"
    /pin[:\s]+(\d{4,8})/i,            // "PIN: 123456"
    /token[:\s]+(\d{4,8})/i,          // "token: 123456"
    /code is[:\s]+(\d{4,8})/i,        // "code is 123456"
    /your code[:\s]+(\d{4,8})/i,      // "your code: 123456"
    /confirm[:\s]+(\d{4,8})/i,        // "confirm: 123456"
    /(\d{6})\s*is your/i,             // "123456 is your verification"
    /(\d{4,8})\s*to verify/i,         // "123456 to verify"
  ];
  
  for (const pattern of patterns) {
    const match = cleanContent.match(pattern);
    if (match && match[1]) {
      const otp = match[1];
      // Validate OTP length (4-8 digits)
      if (otp.length >= 4 && otp.length <= 8) {
        return otp;
      }
    }
  }
  
  return null;
}

// Format message for Telegram display
function formatMessageForTelegram(message, otp = null) {
  let text = `📩 New Mail Received In Your Email ID 🪧\n`;
  text += `📇 From : ${message.from}\n`;
  text += `🗒️ Subject : ${message.subject || 'No Subject'}\n`;
  
  // Clean and truncate intro text
  let intro = message.intro || message.text || 'No preview available';
  intro = intro.replace(/<[^>]*>/g, '').trim();
  if (intro.length > 200) {
    intro = intro.substring(0, 200) + '...';
  }
  
  text += `💬 Text : ${intro}\n`;
  
  if (otp) {
    text += `\n👉 OTP : \`${otp}\``;
  }
  
  return text;
}

// Validate email format
function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

// Generate random string (for future features)
function generateRandomString(length = 10) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// Delay function (for rate limiting)
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Extract plain text from HTML
function htmlToText(html) {
  if (!html) return '';
  
  // Remove script and style tags
  let text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  
  // Replace common HTML entities
  text = text.replace(/&nbsp;/g, ' ');
  text = text.replace(/&amp;/g, '&');
  text = text.replace(/&lt;/g, '<');
  text = text.replace(/&gt;/g, '>');
  text = text.replace(/&quot;/g, '"');
  
  // Remove HTML tags
  text = text.replace(/<[^>]*>/g, ' ');
  
  // Clean up whitespace
  text = text.replace(/\s+/g, ' ').trim();
  
  return text;
}

module.exports = {
  generateTempEmail,
  refreshToken,
  getInbox,
  getMessage,
  deleteMessage,
  detectOTP,
  formatMessageForTelegram,
  isValidEmail,
  generateRandomString,
  delay,
  htmlToText
};
