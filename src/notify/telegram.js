const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function createTelegram({ token, chatId }, { fetch = globalThis.fetch } = {}) {
  return {
    name: 'telegram',
    async send({ title, body }) {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: '<b>' + escapeHtml(title) + '</b>\n' + escapeHtml(body),
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
      });
      if (!res.ok) throw new Error(`Telegram HTTP ${res.status}`);
    },
  };
}
