// Optional Telegram notifier. No-op unless TELEGRAM_BOT_TOKEN and
// TELEGRAM_CHAT_ID are both set. Uses Node's built-in fetch (Node 18+).
import { config } from './config.js';
import { log } from './logger.js';

export function notifyEnabled() {
  return Boolean(config.telegram.token && config.telegram.chatId);
}

export async function notify(text) {
  if (!notifyEnabled()) return;
  try {
    const url = `https://api.telegram.org/bot${config.telegram.token}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: config.telegram.chatId,
        text,
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) log.warn('Telegram notify failed:', res.status, await res.text());
  } catch (err) {
    log.warn('Telegram notify error:', err.message);
  }
}
