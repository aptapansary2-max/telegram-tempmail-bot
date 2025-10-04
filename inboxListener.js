const axios = require('axios');

const MAIL_TM_API = process.env.MAIL_TM_API || 'https://api.mail.tm';
const POLL_INTERVAL = 5000; // 5 seconds

// Store active listeners
const activeListeners = new Map();

// Start listening for new messages
function startInboxListener(email, token, onNewMessage) {
  // Stop existing listener if any
  if (activeListeners.has(email)) {
    stopInboxListener(email);
  }

  let lastMessageIds = new Set();
  let isFirstFetch = true;

  // Initial fetch to get existing message IDs
  fetchMessages();

  const intervalId = setInterval(fetchMessages, POLL_INTERVAL);

  activeListeners.set(email, {
    intervalId,
    token,
    onNewMessage
  });

  console.log(`📡 Started inbox listener for ${email}`);

  async function fetchMessages() {
    try {
      const response = await axios.get(
        `${MAIL_TM_API}/messages`,
        {
          headers: { 'Authorization': `Bearer ${token}` },
          timeout: 8000,
          validateStatus: function (status) {
            return status < 500; // Accept any status < 500
          }
        }
      );

      if (response.status === 401 || response.status === 403) {
        console.log(`⚠️ Token expired for ${email}, stopping listener`);
        stopInboxListener(email);
        return;
      }

      if (response.status !== 200) {
        console.error(`API error for ${email}: ${response.status}`);
        return;
      }

      const messages = response.data['hydra:member'] || [];
      const currentMessageIds = new Set(messages.map(m => m.id));

      // On first fetch, just store IDs without notifying
      if (isFirstFetch) {
        lastMessageIds = currentMessageIds;
        isFirstFetch = false;
        return;
      }

      // Find new messages
      for (const message of messages) {
        if (!lastMessageIds.has(message.id)) {
          // New message detected!
          console.log(`📩 New message detected for ${email}: ${message.subject}`);
          
          // Fetch full message content
          try {
            const fullMessage = await axios.get(
              `${MAIL_TM_API}/messages/${message.id}`,
              {
                headers: { 'Authorization': `Bearer ${token}` },
                timeout: 8000
              }
            );

            onNewMessage(fullMessage.data);
          } catch (error) {
            console.error('Error fetching full message:', error.message);
            // Fallback to basic message data
            onNewMessage(message);
          }
        }
      }

      lastMessageIds = currentMessageIds;
    } catch (error) {
      if (error.response && error.response.status === 401) {
        console.log(`⚠️ Token expired for ${email}, stopping listener`);
        stopInboxListener(email);
      } else if (error.code !== 'ECONNABORTED') {
        console.error(`Error polling inbox for ${email}:`, error.message);
      }
    }
  }
}

// Stop listening for an email
function stopInboxListener(email) {
  if (activeListeners.has(email)) {
    const listener = activeListeners.get(email);
    clearInterval(listener.intervalId);
    activeListeners.delete(email);
    console.log(`🛑 Stopped inbox listener for ${email}`);
  }
}

// Stop all listeners
function stopAllListeners() {
  console.log(`🛑 Stopping all ${activeListeners.size} inbox listeners`);
  activeListeners.forEach((listener, email) => {
    clearInterval(listener.intervalId);
  });
  activeListeners.clear();
}

// Update token for an active listener
function updateListenerToken(email, newToken) {
  if (activeListeners.has(email)) {
    const listener = activeListeners.get(email);
    listener.token = newToken;
    console.log(`🔄 Updated token for ${email}`);
  }
}

// Get active listener count
function getActiveListenerCount() {
  return activeListeners.size;
}

// Check if email has active listener
function hasActiveListener(email) {
  return activeListeners.has(email);
}

module.exports = {
  startInboxListener,
  stopInboxListener,
  stopAllListeners,
  updateListenerToken,
  getActiveListenerCount,
  hasActiveListener
};
