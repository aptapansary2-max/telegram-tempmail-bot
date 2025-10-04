const axios = require('axios');
const { getPool } = require('./db');
const { getInboxMessages, getMessageContent, extractOTP, formatEmailContent } = require('./utils');

class InboxListener {
  constructor(bot) {
    this.bot = bot;
    this.activeListeners = new Map();
    this.checkInterval = 10000; // Check every 10 seconds
    this.processedMessages = new Set();
  }

  // Start monitoring for a user
  startMonitoring(chatId, email, token) {
    if (this.activeListeners.has(chatId)) {
      clearInterval(this.activeListeners.get(chatId));
    }

    console.log(`📡 Started monitoring for chat ${chatId} - ${email}`);

    const intervalId = setInterval(async () => {
      await this.checkNewMessages(chatId, email, token);
    }, this.checkInterval);

    this.activeListeners.set(chatId, intervalId);
  }

  // Stop monitoring for a user
  stopMonitoring(chatId) {
    if (this.activeListeners.has(chatId)) {
      clearInterval(this.activeListeners.get(chatId));
      this.activeListeners.delete(chatId);
      console.log(`🛑 Stopped monitoring for chat ${chatId}`);
    }
  }

  // Check for new messages
  async checkNewMessages(chatId, email, token) {
    try {
      const messages = await getInboxMessages(token);

      if (!messages || !messages['hydra:member'] || messages['hydra:member'].length === 0) {
        return;
      }

      const latestMessages = messages['hydra:member'].slice(0, 3); // Check last 3 messages

      for (const message of latestMessages) {
        const messageKey = `${chatId}_${message.id}`;

        // Skip if already processed
        if (this.processedMessages.has(messageKey)) {
          continue;
        }

        // Mark as processed
        this.processedMessages.add(messageKey);

        // Get full message content
        const messageDetails = await getMessageContent(message.id, token);

        if (messageDetails) {
          await this.notifyUser(chatId, message, messageDetails);
        }
      }

      // Clean up old processed messages (keep last 100)
      if (this.processedMessages.size > 100) {
        const entries = Array.from(this.processedMessages);
        this.processedMessages = new Set(entries.slice(-100));
      }
    } catch (error) {
      console.error(`Error checking messages for ${chatId}:`, error.message);

      // Try to refresh token if unauthorized
      if (error.response && error.response.status === 401) {
        const pool = getPool();
        const [rows] = await pool.query(
          'SELECT password FROM user_emails WHERE email = ? AND chat_id = ?',
          [email, chatId]
        );

        if (rows.length > 0) {
          const { refreshToken } = require('./utils');
          const newToken = await refreshToken(email, rows[0].password, chatId);
          
          if (newToken) {
            this.startMonitoring(chatId, email, newToken);
          }
        }
      }
    }
  }

  // Notify user about new message
  async notifyUser(chatId, message, messageDetails) {
    try {
      const content = formatEmailContent(messageDetails);
      const otp = extractOTP(content);

      let notificationMsg = '📩 New Mail Received In Your Email ID 🪧\n\n';
      notificationMsg += `📇 From : ${message.from.address}\n\n`;
      notificationMsg += `🗒️ Subject : ${message.subject}\n\n`;
      notificationMsg += `💬 Text : *${content}*`;

      if (otp) {
        notificationMsg += `\n\n👉 OTP : \`${otp}\``;
      }

      await this.bot.sendMessage(chatId, notificationMsg, { 
        parse_mode: 'Markdown'
      });

      console.log(`✅ Notified user ${chatId} about new email`);
    } catch (error) {
      console.error(`Error notifying user ${chatId}:`, error.message);
    }
  }

  // Start monitoring all active users
  async startAllMonitoring() {
    try {
      const pool = getPool();
      const [users] = await pool.query(
        'SELECT chat_id, current_email, current_token FROM telegram_users WHERE current_email IS NOT NULL AND current_token IS NOT NULL'
      );

      console.log(`🚀 Starting monitoring for ${users.length} active users`);

      for (const user of users) {
        this.startMonitoring(user.chat_id, user.current_email, user.current_token);
      }
    } catch (error) {
      console.error('Error starting all monitoring:', error);
    }
  }

  // Stop all monitoring
  stopAllMonitoring() {
    for (const [chatId, intervalId] of this.activeListeners.entries()) {
      clearInterval(intervalId);
    }
    this.activeListeners.clear();
    console.log('🛑 Stopped all monitoring');
  }
}

module.exports = InboxListener;
