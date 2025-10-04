require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const { pool, initDatabase } = require('./db');
const { 
  generateNewEmail, 
  getInbox, 
  getMessageContent,
  deleteMessage,
  extractOTP,
  refreshToken 
} = require('./utils');
const { 
  startInboxListener, 
  hasActiveListener,
  stopInboxListener 
} = require('./inboxListener');

// Initialize Express (for UptimeRobot ping)
const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Telegram Bot
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

// In-memory cache for active sessions
const userSessions = new Map();
const userChatIds = new Map(); // Map email to chatId for notifications

// Keyboard layouts
const mainKeyboard = {
  keyboard: [
    [{ text: '📧 My Email' }],
    [{ text: '🔄 Generate New' }, { text: '📥 Inbox' }],
    [{ text: '♻️ Recovery' }]
  ],
  resize_keyboard: true,
  one_time_keyboard: false
};

// Helper: Get or create user session
async function getUserSession(userId) {
  if (userSessions.has(userId)) {
    return userSessions.get(userId);
  }

  // Try to load from database
  const [rows] = await pool.query(
    'SELECT * FROM user_sessions WHERE telegram_id = ? ORDER BY created_at DESC LIMIT 1',
    [userId]
  );

  if (rows.length > 0) {
    const session = {
      email: rows[0].email,
      password: rows[0].password,
      token: rows[0].token,
      recoveryEmail: rows[0].recovery_email
    };
    userSessions.set(userId, session);
    return session;
  }

  return null;
}

// Helper: Save user session
async function saveUserSession(userId, sessionData) {
  userSessions.set(userId, sessionData);
  
  await pool.query(
    `INSERT INTO user_sessions (telegram_id, email, password, token, recovery_email, created_at, last_access) 
     VALUES (?, ?, ?, ?, ?, NOW(), NOW())
     ON DUPLICATE KEY UPDATE 
     email = VALUES(email), 
     password = VALUES(password), 
     token = VALUES(token),
     recovery_email = VALUES(recovery_email),
     last_access = NOW()`,
    [
      userId, 
      sessionData.email, 
      sessionData.password, 
      sessionData.token, 
      sessionData.recoveryEmail || null
    ]
  );
}

// Helper: Send message with error handling
async function sendMessage(chatId, text, options = {}) {
  try {
    await bot.sendMessage(chatId, text, {
      parse_mode: 'Markdown',
      ...options
    });
  } catch (error) {
    console.error('Error sending message:', error);
    await bot.sendMessage(chatId, text, options);
  }
}

// Command: /start
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const firstName = msg.from.first_name || 'User';
  const userId = msg.from.id;

  await sendMessage(
    chatId,
    `😜 Hey *${firstName}* Welcome To OUR BoT\n🧑‍💻 BoT Created BY : @tricksmaster111`,
    { reply_markup: mainKeyboard }
  );

  // Auto-load existing session if available
  try {
    const session = await getUserSession(userId);
    if (session && session.email && session.token) {
      // Start listener for existing email if not already active
      if (!hasActiveListener(session.email)) {
        startInboxListener(session.email, session.token, (newMessage) => {
          handleNewMessage(chatId, newMessage);
        });
        console.log(`🔄 Restored listener for ${session.email}`);
      }
    }
  } catch (error) {
    console.error('Error loading session:', error);
  }
});

// Button: 📧 My Email
bot.onText(/📧 My Email/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  try {
    const session = await getUserSession(userId);

    if (!session || !session.email) {
      await sendMessage(
        chatId,
        '❌ No active email found!\nPlease generate a new email first.',
        { reply_markup: mainKeyboard }
      );
      return;
    }

    await sendMessage(
      chatId,
      `🎊 Here Is Your Email Address 👇\n📬 *Email ID* : \`${session.email}\` 👈\n\n_Click to copy_`,
      { reply_markup: mainKeyboard }
    );
  } catch (error) {
    console.error('Error fetching email:', error);
    await sendMessage(chatId, '❌ Error fetching your email. Please try again.', {
      reply_markup: mainKeyboard
    });
  }
});

// Button: 🔄 Generate New
bot.onText(/🔄 Generate New/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  try {
    await sendMessage(chatId, '⏳ Generating new email address...');

    const emailData = await generateNewEmail();

    if (!emailData || emailData.error) {
      await sendMessage(chatId, '❌ Failed to generate email. Please try again later.', {
        reply_markup: mainKeyboard
      });
      return;
    }

    // Save session
    await saveUserSession(userId, {
      email: emailData.email,
      password: emailData.password,
      token: emailData.token,
      recoveryEmail: null
    });

    // Map email to chatId for notifications
    userChatIds.set(emailData.email, chatId);

    // Start listening for this email
    startInboxListener(emailData.email, emailData.token, (newMessage) => {
      handleNewMessage(chatId, newMessage);
    });

    await sendMessage(
      chatId,
      `♻️ *New Email Generated Successfully* ✅\n📬 *Email ID* : \`${emailData.email}\` 👈\n\n_Click to copy_\n\n🔔 Real-time inbox monitoring started!`,
      { reply_markup: mainKeyboard }
    );
  } catch (error) {
    console.error('Error generating email:', error);
    await sendMessage(chatId, '❌ Error generating email. Please try again.', {
      reply_markup: mainKeyboard
    });
  }
});

// Button: 📥 Inbox
bot.onText(/📥 Inbox/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  try {
    const session = await getUserSession(userId);

    if (!session || !session.email) {
      await sendMessage(
        chatId,
        '❌ No active email found!\nPlease generate a new email first.',
        { reply_markup: mainKeyboard }
      );
      return;
    }

    await sendMessage(chatId, '📨 Fetching your inbox...');

    let messages = await getInbox(session.token, session.email);

    // If token expired (empty result or error), try refresh
    if (!messages || messages.length === 0) {
      console.log(`🔄 Attempting token refresh for ${session.email}`);
      const newToken = await refreshToken(session.email, session.password);
      if (newToken) {
        session.token = newToken;
        await saveUserSession(userId, session);
        messages = await getInbox(newToken, session.email);
        
        // Restart listener with new token
        if (hasActiveListener(session.email)) {
          stopInboxListener(session.email);
        }
        startInboxListener(session.email, newToken, (newMessage) => {
          handleNewMessage(chatId, newMessage);
        });
      }
    }

    if (!messages || messages.length === 0) {
      await sendMessage(chatId, '📭 Your inbox is empty.\nWaiting for new messages...', {
        reply_markup: mainKeyboard
      });
      return;
    }

    // Display messages
    for (const msg of messages.slice(0, 10)) { // Limit to 10 recent messages
      const date = new Date(msg.createdAt).toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata'
      });

      let messageText = `📩 *New Mail Received* 🪧\n\n`;
      messageText += `📇 *From* : \`${msg.from}\`\n`;
      messageText += `🗒️ *Subject* : ${msg.subject || 'No Subject'}\n`;
      messageText += `📅 *Date* : ${date}\n`;

      if (!msg.seen) {
        messageText += `🔔 *Status* : NEW\n`;
      }

      // Create inline keyboard for actions
      const inlineKeyboard = {
        inline_keyboard: [
          [
            { text: '👁️ Read Full', callback_data: `read_${msg.id}` },
            { text: '🗑️ Delete', callback_data: `delete_${msg.id}` }
          ]
        ]
      };

      await bot.sendMessage(chatId, messageText, {
        parse_mode: 'Markdown',
        reply_markup: inlineKeyboard
      });
    }

    await sendMessage(chatId, `✅ Showing ${Math.min(messages.length, 10)} messages`, {
      reply_markup: mainKeyboard
    });
  } catch (error) {
    console.error('Error fetching inbox:', error);
    await sendMessage(chatId, '❌ Error fetching inbox. Please try again.', {
      reply_markup: mainKeyboard
    });
  }
});

// Button: ♻️ Recovery
bot.onText(/♻️ Recovery/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  try {
    const session = await getUserSession(userId);

    if (!session || !session.recoveryEmail) {
      await sendMessage(
        chatId,
        '♻️ *Please Enter Recovery Email* 📨\n\nSend your recovery email address:',
        { reply_markup: { force_reply: true } }
      );

      // Set user state to expect recovery email
      userSessions.set(`${userId}_state`, 'awaiting_recovery_email');
      return;
    }

    // Recovery email already set - show current temp email info
    await sendMessage(
      chatId,
      `✅ *Recovery Email Linked* 🎉\n\n📬 *Your Recovery Email* : \`${session.recoveryEmail}\`\n📧 *Your Current Temp Email* : \`${session.email}\`\n\n💡 Your temp email info is saved and can be recovered anytime!`,
      { reply_markup: mainKeyboard }
    );
  } catch (error) {
    console.error('Error in recovery:', error);
    await sendMessage(chatId, '❌ Error processing recovery. Please try again.', {
      reply_markup: mainKeyboard
    });
  }
});

// Handle recovery email input
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text;

  // Check if user is in recovery email input state
  const userState = userSessions.get(`${userId}_state`);

  if (userState === 'awaiting_recovery_email' && text && !text.startsWith('/') && !text.includes('📧') && !text.includes('🔄')) {
    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    
    if (!emailRegex.test(text)) {
      await sendMessage(chatId, '❌ Invalid email format. Please enter a valid email address.');
      return;
    }

    try {
      const session = await getUserSession(userId);
      
      if (session) {
        session.recoveryEmail = text;
        await saveUserSession(userId, session);
      }

      userSessions.delete(`${userId}_state`);

      await sendMessage(
        chatId,
        `✅ *Recovery Email Linked Successfully* 🎉\n📬 *Your Recovery Email* : \`${text}\`\n\n💡 You can now recover your temp email anytime using this address!`,
        { reply_markup: mainKeyboard }
      );

      // Restart inbox listener if session exists
      if (session && session.email && session.token) {
        if (!hasActiveListener(session.email)) {
          startInboxListener(session.email, session.token, (newMessage) => {
            handleNewMessage(chatId, newMessage);
          });
          console.log(`🔔 Started listener after recovery email setup: ${session.email}`);
        }
      }
    } catch (error) {
      console.error('Error saving recovery email:', error);
      await sendMessage(chatId, '❌ Error saving recovery email. Please try again.', {
        reply_markup: mainKeyboard
      });
    }
  }
});

// Handle callback queries (inline buttons)
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const data = query.data;

  try {
    const session = await getUserSession(userId);

    if (!session) {
      await bot.answerCallbackQuery(query.id, {
        text: '❌ No active session found',
        show_alert: true
      });
      return;
    }

    if (data.startsWith('read_')) {
      const messageId = data.replace('read_', '');
      await bot.answerCallbackQuery(query.id, { text: '📖 Loading message...' });

      let messageContent = await getMessageContent(session.token, messageId, session.email);

      // If failed, try token refresh
      if (!messageContent) {
        console.log(`🔄 Token refresh for read message: ${session.email}`);
        const newToken = await refreshToken(session.email, session.password);
        if (newToken) {
          session.token = newToken;
          await saveUserSession(userId, session);
          messageContent = await getMessageContent(newToken, messageId, session.email);
        }
      }

      if (!messageContent) {
        await sendMessage(chatId, '❌ Failed to load message content.');
        return;
      }

      let fullText = `📩 *Full Message Content*\n\n`;
      fullText += `📇 *From* : \`${messageContent.from.address}\`\n`;
      fullText += `📧 *To* : \`${messageContent.to[0].address}\`\n`;
      fullText += `🗒️ *Subject* : ${messageContent.subject || 'No Subject'}\n\n`;
      
      const messageBody = messageContent.text || messageContent.html || 'No content';
      fullText += `💬 *Text* :\n${messageBody.substring(0, 3000)}`; // Telegram limit

      // Check for OTP
      const otp = extractOTP(messageBody);
      if (otp) {
        fullText += `\n\n👉 *OTP* : \`${otp}\`\n\n_Click to copy_`;
      }

      await sendMessage(chatId, fullText, { reply_markup: mainKeyboard });
    } 
    else if (data.startsWith('delete_')) {
      const messageId = data.replace('delete_', '');
      
      const success = await deleteMessage(session.token, messageId, session.email);

      if (success) {
        await bot.answerCallbackQuery(query.id, {
          text: '🗑️ Message deleted successfully',
          show_alert: true
        });
        await bot.deleteMessage(chatId, query.message.message_id);
      } else {
        await bot.answerCallbackQuery(query.id, {
          text: '❌ Failed to delete message',
          show_alert: true
        });
      }
    }
  } catch (error) {
    console.error('Error handling callback:', error);
    await bot.answerCallbackQuery(query.id, {
      text: '❌ Error processing request',
      show_alert: true
    });
  }
});

// Handle new messages from inbox listener
async function handleNewMessage(chatId, message) {
  try {
    const date = new Date(message.createdAt).toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata'
    });

    let messageText = `📩 *New Mail Received In Your Email ID* 🪧\n\n`;
    messageText += `📇 *From* : \`${message.from.address}\`\n`;
    messageText += `🗒️ *Subject* : ${message.subject || 'No Subject'}\n`;
    
    const messageBody = message.text || message.html || '';
    const preview = messageBody.substring(0, 200);
    messageText += `💬 *Preview* : _${preview}..._\n`;

    // Check for OTP
    const otp = extractOTP(messageBody);
    if (otp) {
      messageText += `\n👉 *OTP* : \`${otp}\`\n\n_Click to copy_`;
    }

    // Create inline keyboard for actions
    const inlineKeyboard = {
      inline_keyboard: [
        [
          { text: '👁️ Read Full', callback_data: `read_${message.id}` },
          { text: '🗑️ Delete', callback_data: `delete_${message.id}` }
        ]
      ]
    };

    await bot.sendMessage(chatId, messageText, {
      parse_mode: 'Markdown',
      reply_markup: inlineKeyboard
    });
  } catch (error) {
    console.error('Error handling new message:', error);
  }
}

// Health check endpoint for UptimeRobot
app.get('/', (req, res) => {
  res.send('🤖 Temp Email Bot is running!');
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    activeSessions: userSessions.size
  });
});

// Initialize and start server
async function start() {
  try {
    await initDatabase();
    console.log('✅ Database initialized');

    app.listen(PORT, () => {
      console.log(`✅ Express server running on port ${PORT}`);
    });

    console.log('✅ Telegram bot started successfully');
    console.log(`✅ Bot username: @${(await bot.getMe()).username}`);
  } catch (error) {
    console.error('❌ Error starting bot:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT signal received: closing HTTP server');
  process.exit(0);
});

start();
