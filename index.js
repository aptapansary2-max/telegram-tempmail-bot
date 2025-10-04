require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const uWS = require('uWebSockets.js');
const { pool, initDatabase } = require('./db');
const { 
  generateTempEmail, 
  getInbox, 
  getMessage, 
  detectOTP, 
  refreshToken 
} = require('./utils');

// Bot token from BotFather
const BOT_TOKEN = process.env.BOT_TOKEN;
const PORT = process.env.PORT || 3000;

// Initialize bot
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Store user sessions (chatId -> { email, token, password })
const userSessions = new Map();

// Keyboard layout
const mainKeyboard = {
  keyboard: [
    [{ text: "📧 My Email" }],
    [{ text: "🔄 Generate New" }, { text: "📥 Inbox" }],
    [{ text: "♻️ Recovery" }]
  ],
  resize_keyboard: true,
  one_time_keyboard: false
};

// Recovery state tracker
const recoveryState = new Map();

// Initialize database on startup
initDatabase().then(() => {
  console.log('✅ Database initialized');
}).catch(err => {
  console.error('❌ Database initialization failed:', err);
});

// /start command
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const firstName = msg.from.first_name || 'User';
  
  const welcomeMessage = `😜 Hey ${firstName} Welcome To OUR BoT\n🧑‍💻 BoT Created BY : @tricksmaster111`;
  
  bot.sendMessage(chatId, welcomeMessage, {
    reply_markup: mainKeyboard
  });
});

// Handle button clicks
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  
  if (!text) return;
  
  try {
    // 📧 My Email
    if (text === '📧 My Email') {
      const session = userSessions.get(chatId);
      
      if (!session || !session.email) {
        bot.sendMessage(chatId, '❌ No email found! Please generate a new email first.', {
          reply_markup: mainKeyboard
        });
        return;
      }
      
      bot.sendMessage(chatId, `🎊 Here Is Your Email Address 👇\n📬 Email ID : ${session.email} 👈`, {
        reply_markup: mainKeyboard
      });
    }
    
    // 🔄 Generate New
    else if (text === '🔄 Generate New') {
      bot.sendMessage(chatId, '⏳ Generating new email...', {
        reply_markup: mainKeyboard
      });
      
      const result = await generateTempEmail();
      
      if (result.error) {
        bot.sendMessage(chatId, `❌ Failed to generate email: ${result.error}`, {
          reply_markup: mainKeyboard
        });
        return;
      }
      
      // Store in session
      userSessions.set(chatId, {
        email: result.email,
        token: result.token,
        password: result.password
      });
      
      // Save to MySQL database
      try {
        await pool.query(
          'INSERT INTO emails (email, password, token, created_at, last_access) VALUES (?, ?, ?, NOW(), NOW())',
          [result.email, result.password, result.token]
        );
      } catch (dbErr) {
        console.error('Database save error:', dbErr);
      }
      
      bot.sendMessage(chatId, `♻️ New Email Generated Successfully ✅\n📬 Email ID : ${result.email} 👈`, {
        reply_markup: mainKeyboard
      });
      
      // Start auto-checking inbox every 10 seconds
      startInboxPolling(chatId);
    }
    
    // 📥 Inbox
    else if (text === '📥 Inbox') {
      const session = userSessions.get(chatId);
      
      if (!session || !session.email) {
        bot.sendMessage(chatId, '❌ No active email! Generate one first.', {
          reply_markup: mainKeyboard
        });
        return;
      }
      
      bot.sendMessage(chatId, '📬 Checking inbox...', {
        reply_markup: mainKeyboard
      });
      
      // Check if token is still valid
      let currentToken = session.token;
      const messages = await getInbox(currentToken);
      
      // If token expired, refresh it
      if (messages.error && messages.error.includes('401')) {
        const newToken = await refreshToken(session.email, session.password);
        if (newToken) {
          currentToken = newToken;
          session.token = newToken;
          userSessions.set(chatId, session);
          
          // Update in database
          await pool.query(
            'UPDATE emails SET token = ?, last_access = NOW() WHERE email = ?',
            [newToken, session.email]
          );
          
          // Retry with new token
          const retryMessages = await getInbox(currentToken);
          displayInbox(chatId, retryMessages);
        } else {
          bot.sendMessage(chatId, '❌ Token refresh failed. Please generate a new email.', {
            reply_markup: mainKeyboard
          });
        }
      } else {
        displayInbox(chatId, messages);
      }
    }
    
    // ♻️ Recovery
    else if (text === '♻️ Recovery') {
      recoveryState.set(chatId, 'waiting_email');
      bot.sendMessage(chatId, '♻️ Please Enter Recovery Email 📨', {
        reply_markup: { remove_keyboard: true }
      });
    }
    
    // Handle recovery email input
    else if (recoveryState.get(chatId) === 'waiting_email') {
      const recoveryEmail = text.trim();
      
      // Validate email format
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(recoveryEmail)) {
        bot.sendMessage(chatId, '❌ Invalid email format! Please try again.', {
          reply_markup: mainKeyboard
        });
        recoveryState.delete(chatId);
        return;
      }
      
      // Check if email exists in database
      try {
        const [rows] = await pool.query(
          'SELECT email, password, token FROM emails WHERE email = ?',
          [recoveryEmail]
        );
        
        if (rows.length === 0) {
          bot.sendMessage(chatId, '❌ Email not found in database!', {
            reply_markup: mainKeyboard
          });
          recoveryState.delete(chatId);
          return;
        }
        
        const emailData = rows[0];
        
        // Refresh token
        const newToken = await refreshToken(emailData.email, emailData.password);
        if (newToken) {
          // Update session
          userSessions.set(chatId, {
            email: emailData.email,
            token: newToken,
            password: emailData.password
          });
          
          // Update database
          await pool.query(
            'UPDATE emails SET token = ?, last_access = NOW() WHERE email = ?',
            [newToken, emailData.email]
          );
          
          bot.sendMessage(chatId, `✅ Recovery Email Linked Successfully 🎉\n📬 Your Recovery Email : ${emailData.email}`, {
            reply_markup: mainKeyboard
          });
          
          // Start polling for this recovered email
          startInboxPolling(chatId);
        } else {
          bot.sendMessage(chatId, '❌ Failed to refresh token. Email may be expired.', {
            reply_markup: mainKeyboard
          });
        }
      } catch (dbErr) {
        console.error('Recovery error:', dbErr);
        bot.sendMessage(chatId, '❌ Database error during recovery.', {
          reply_markup: mainKeyboard
        });
      }
      
      recoveryState.delete(chatId);
    }
    
  } catch (error) {
    console.error('Message handling error:', error);
    bot.sendMessage(chatId, '❌ An error occurred. Please try again.', {
      reply_markup: mainKeyboard
    });
  }
});

// Display inbox messages
function displayInbox(chatId, messages) {
  if (messages.error) {
    bot.sendMessage(chatId, `❌ Error: ${messages.error}`, {
      reply_markup: mainKeyboard
    });
    return;
  }
  
  if (!messages || messages.length === 0) {
    bot.sendMessage(chatId, '📭 No messages in inbox yet!', {
      reply_markup: mainKeyboard
    });
    return;
  }
  
  messages.forEach(async (msg) => {
    const messageText = `📩 New Mail Received In Your Email ID 🪧\n📇 From : ${msg.from}\n🗒️ Subject : ${msg.subject || 'No Subject'}\n💬 Text : ${msg.intro || 'No preview available'}`;
    
    // Fetch full message content
    const session = userSessions.get(chatId);
    if (session) {
      const fullMsg = await getMessage(session.token, msg.id);
      if (fullMsg && !fullMsg.error) {
        const otp = detectOTP(fullMsg.text || fullMsg.html || '');
        
        if (otp) {
          bot.sendMessage(chatId, `${messageText}\n\n👉 OTP : \`${otp}\``, {
            parse_mode: 'Markdown',
            reply_markup: mainKeyboard
          });
        } else {
          bot.sendMessage(chatId, messageText, {
            reply_markup: mainKeyboard
          });
        }
      }
    }
  });
}

// Polling mechanism for real-time inbox (every 10 seconds)
const pollingIntervals = new Map();

function startInboxPolling(chatId) {
  // Clear existing interval if any
  if (pollingIntervals.has(chatId)) {
    clearInterval(pollingIntervals.get(chatId));
  }
  
  let lastMessageCount = 0;
  
  const interval = setInterval(async () => {
    const session = userSessions.get(chatId);
    if (!session || !session.email) {
      clearInterval(interval);
      pollingIntervals.delete(chatId);
      return;
    }
    
    const messages = await getInbox(session.token);
    
    if (!messages.error && messages.length > lastMessageCount) {
      // New messages detected
      const newMessages = messages.slice(lastMessageCount);
      newMessages.forEach(async (msg) => {
        const fullMsg = await getMessage(session.token, msg.id);
        if (fullMsg && !fullMsg.error) {
          const otp = detectOTP(fullMsg.text || fullMsg.html || '');
          
          let messageText = `📩 New Mail Received In Your Email ID 🪧\n📇 From : ${msg.from}\n🗒️ Subject : ${msg.subject || 'No Subject'}\n💬 Text : ${fullMsg.intro || 'No preview available'}`;
          
          if (otp) {
            messageText += `\n\n👉 OTP : \`${otp}\``;
            bot.sendMessage(chatId, messageText, {
              parse_mode: 'Markdown',
              reply_markup: mainKeyboard
            });
          } else {
            bot.sendMessage(chatId, messageText, {
              reply_markup: mainKeyboard
            });
          }
        }
      });
      
      lastMessageCount = messages.length;
    }
  }, 10000); // Check every 10 seconds
  
  pollingIntervals.set(chatId, interval);
}

// WebSocket server for health checks (UptimeRobot)
const wsApp = uWS.App().get('/health', (res, req) => {
  res.writeStatus('200 OK').end(JSON.stringify({ 
    status: 'ok', 
    uptime: process.uptime(),
    activeSessions: userSessions.size
  }));
}).get('/', (res, req) => {
  res.writeStatus('200 OK').end('Advanced Temp Email Bot is running! 🚀');
}).listen(PORT, (token) => {
  if (token) {
    console.log(`✅ WebSocket server listening on port ${PORT}`);
    console.log(`🤖 Telegram bot is active!`);
  } else {
    console.log('❌ Failed to start WebSocket server');
  }
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down gracefully...');
  pollingIntervals.forEach((interval) => clearInterval(interval));
  pool.end();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Shutting down gracefully...');
  pollingIntervals.forEach((interval) => clearInterval(interval));
  pool.end();
  process.exit(0);
});
