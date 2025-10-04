const TelegramBot = require('node-telegram-bot-api');
const uWS = require('uWebSockets.js');
const { initDatabase, getPool } = require('./db');
const InboxListener = require('./inboxListener');
const { 
  generateTempEmail, 
  refreshToken, 
  getInboxMessages, 
  getMessageContent,
  extractOTP,
  formatEmailContent 
} = require('./utils');
require('dotenv').config();

const BOT_TOKEN = process.env.BOT_TOKEN;
const PORT = process.env.PORT || 3000;

// Initialize bot
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Initialize inbox listener
const inboxListener = new InboxListener(bot);

// Keyboard layout
const keyboard = {
  keyboard: [
    [{ text: '📧 My Email' }],
    [{ text: '🔄 Generate New' }, { text: '📥 Inbox' }],
    [{ text: '♻️ Recovery' }]
  ],
  resize_keyboard: true,
  one_time_keyboard: false
};

// User sessions for recovery mode
const userSessions = new Map();

// Initialize database and start bot
async function start() {
  try {
    await initDatabase();
    console.log('✅ Bot initialized successfully');

    // Start monitoring for all active users
    await inboxListener.startAllMonitoring();

    // Start WebSocket server for health checks
    startWebSocketServer();

    console.log(`🤖 Bot is running...`);
  } catch (error) {
    console.error('❌ Failed to start bot:', error);
    process.exit(1);
  }
}

// WebSocket server for UptimeRobot and health checks
function startWebSocketServer() {
  const app = uWS.App();

  app.get('/health', (res, req) => {
    res.writeStatus('200 OK')
       .writeHeader('Content-Type', 'application/json')
       .end(JSON.stringify({ 
         status: 'ok', 
         uptime: process.uptime(),
         activeMonitors: inboxListener.activeListeners.size
       }));
  });

  app.get('/ping', (res, req) => {
    res.writeStatus('200 OK')
       .writeHeader('Content-Type', 'text/plain')
       .end('pong');
  });

  app.post('/register-user', (res, req) => {
    let buffer;

    res.onData((ab, isLast) => {
      const chunk = Buffer.from(ab);
      if (isLast) {
        try {
          const data = JSON.parse(buffer ? Buffer.concat([buffer, chunk]) : chunk);
          
          if (data.chat_id && data.email && data.token) {
            inboxListener.startMonitoring(data.chat_id, data.email, data.token);
            res.writeStatus('200 OK')
               .writeHeader('Content-Type', 'application/json')
               .end(JSON.stringify({ success: true }));
          } else {
            res.writeStatus('400 Bad Request')
               .end(JSON.stringify({ error: 'Missing required fields' }));
          }
        } catch (e) {
          res.writeStatus('400 Bad Request')
             .end(JSON.stringify({ error: 'Invalid JSON' }));
        }
      } else {
        if (buffer) {
          buffer = Buffer.concat([buffer, chunk]);
        } else {
          buffer = Buffer.concat([chunk]);
        }
      }
    });
  });

  app.listen(PORT, (token) => {
    if (token) {
      console.log(`🌐 WebSocket server listening on port ${PORT}`);
    } else {
      console.log('❌ Failed to start WebSocket server');
    }
  });
}

// Handle /start command
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const username = msg.from.username || '';
  const firstName = msg.from.first_name || 'User';

  try {
    const pool = getPool();

    // Insert or update user
    await pool.query(
      `INSERT INTO telegram_users (chat_id, username, first_name) 
       VALUES (?, ?, ?) 
       ON DUPLICATE KEY UPDATE 
       username = VALUES(username), 
       first_name = VALUES(first_name), 
       last_activity = NOW()`,
      [chatId, username, firstName]
    );

    const welcomeMsg = `😜 Hey ${firstName} Welcome To OUR BoT\n\n🧑‍💻 BoT Created BY : @tricksmaster111`;

    await bot.sendMessage(chatId, welcomeMsg, { reply_markup: keyboard });
  } catch (error) {
    console.error('Error handling /start:', error);
    await bot.sendMessage(chatId, '❌ An error occurred. Please try again!');
  }
});

// Handle button clicks
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (!text || text.startsWith('/')) {
    return;
  }

  const pool = getPool();

  try {
    // Get user data
    const [users] = await pool.query(
      'SELECT * FROM telegram_users WHERE chat_id = ?',
      [chatId]
    );

    const user = users[0];

    // Check if user is in recovery mode
    if (userSessions.get(chatId) === 'recovery_mode') {
      await handleRecoveryEmail(chatId, text, user);
      return;
    }

    switch (text) {
      case '📧 My Email':
        await handleMyEmail(chatId, user);
        break;

      case '🔄 Generate New':
        await handleGenerateNew(chatId);
        break;

      case '📥 Inbox':
        await handleInbox(chatId, user);
        break;

      case '♻️ Recovery':
        await handleRecovery(chatId);
        break;

      default:
        await bot.sendMessage(chatId, 'Please use the buttons below to interact with the bot!', {
          reply_markup: keyboard
        });
        break;
    }
  } catch (error) {
    console.error('Error handling message:', error);
    await bot.sendMessage(chatId, '❌ An error occurred. Please try again!', {
      reply_markup: keyboard
    });
  }
});

// Handle My Email button
async function handleMyEmail(chatId, user) {
  if (user && user.current_email) {
    const msg = `🎊 Here Is Your Email Address 👇\n\n📬 Email ID : ${user.current_email} 👈`;
    await bot.sendMessage(chatId, msg, { reply_markup: keyboard });
  } else {
    await bot.sendMessage(chatId, '❌ No active email. Please generate a new one first!', {
      reply_markup: keyboard
    });
  }
}

// Handle Generate New button
async function handleGenerateNew(chatId) {
  const emailData = await generateTempEmail(chatId);

  if (emailData) {
    const msg = `♻️ New Email Generated Successfully ✅\n\n📬 Email ID : ${emailData.email} 👈`;
    await bot.sendMessage(chatId, msg, { reply_markup: keyboard });

    // Start monitoring for this email
    inboxListener.startMonitoring(chatId, emailData.email, emailData.token);
  } else {
    await bot.sendMessage(chatId, '❌ Failed to generate email. Please try again!', {
      reply_markup: keyboard
    });
  }
}

// Handle Inbox button
async function handleInbox(chatId, user) {
  if (!user || !user.current_email || !user.current_token) {
    await bot.sendMessage(chatId, '❌ No active email. Please generate one first!', {
      reply_markup: keyboard
    });
    return;
  }

  let messages = await getInboxMessages(user.current_token);

  // Try to refresh token if failed
  if (!messages || !messages['hydra:member']) {
    const pool = getPool();
    const [rows] = await pool.query(
      'SELECT password FROM user_emails WHERE email = ? AND chat_id = ?',
      [user.current_email, chatId]
    );

    if (rows.length > 0) {
      const newToken = await refreshToken(user.current_email, rows[0].password, chatId);
      if (newToken) {
        messages = await getInboxMessages(newToken);
      }
    }
  }

  if (!messages || !messages['hydra:member'] || messages['hydra:member'].length === 0) {
    await bot.sendMessage(chatId, '📪 No messages in your inbox yet!', {
      reply_markup: keyboard
    });
    return;
  }

  const latestMessage = messages['hydra:member'][0];
  const messageDetails = await getMessageContent(latestMessage.id, user.current_token);

  if (messageDetails) {
    const content = formatEmailContent(messageDetails);
    const otp = extractOTP(content);

    let inboxMsg = '📩 New Mail Received In Your Email ID 🪧\n\n';
    inboxMsg += `📇 From : ${latestMessage.from.address}\n\n`;
    inboxMsg += `🗒️ Subject : ${latestMessage.subject}\n\n`;
    inboxMsg += `💬 Text : *${content}*`;

    if (otp) {
      inboxMsg += `\n\n👉 OTP : \`${otp}\``;
    }

    await bot.sendMessage(chatId, inboxMsg, { 
      parse_mode: 'Markdown',
      reply_markup: keyboard 
    });
  } else {
    await bot.sendMessage(chatId, '📪 No messages in your inbox yet!', {
      reply_markup: keyboard
    });
  }
}

// Handle Recovery button
async function handleRecovery(chatId) {
  userSessions.set(chatId, 'recovery_mode');
  await bot.sendMessage(chatId, '♻️ Please Enter Recovery Email 📨', {
    reply_markup: keyboard
  });
}

// Handle recovery email input
async function handleRecoveryEmail(chatId, email, user) {
  userSessions.delete(chatId);

  // Validate email format
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    await bot.sendMessage(chatId, '❌ Please enter a valid email address!', {
      reply_markup: keyboard
    });
    return;
  }

  const pool = getPool();

  // Try to recover email from history
  const [rows] = await pool.query(
    'SELECT email, password, token FROM user_emails WHERE email = ? AND chat_id = ?',
    [email, chatId]
  );

  if (rows.length > 0) {
    const emailData = rows[0];
    const newToken = await refreshToken(emailData.email, emailData.password, chatId);

    if (newToken) {
      const msg = `♻️ Recovery Email Successfully ✅\n\n📬 Recovery Email : ${emailData.email} 👈`;
      await bot.sendMessage(chatId, msg, { reply_markup: keyboard });

      // Start monitoring
      inboxListener.startMonitoring(chatId, emailData.email, newToken);
    } else {
      await bot.sendMessage(chatId, '❌ Failed to recover email. Please try again.', {
        reply_markup: keyboard
      });
    }
  } else {
    // Save as recovery email
    await pool.query(
      'UPDATE telegram_users SET recovery_email = ? WHERE chat_id = ?',
      [email, chatId]
    );

    const msg = `✅ Recovery Email Linked Successfully 🎉\n\n📬 Your Recovery Email : ${email}`;
    await bot.sendMessage(chatId, msg, { reply_markup: keyboard });
  }
}

// Error handling
bot.on('polling_error', (error) => {
  console.error('Polling error:', error);
});

process.on('SIGINT', () => {
  console.log('🛑 Shutting down...');
  inboxListener.stopAllMonitoring();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('🛑 Shutting down...');
  inboxListener.stopAllMonitoring();
  process.exit(0);
});

// Start the bot
start();
