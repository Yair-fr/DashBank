export function createNtfy({ server, topic, token }, { fetch = globalThis.fetch } = {}) {
  const url = String(server).replace(/\/+$/, '');
  return {
    name: 'ntfy',
    async send({ title, body, tags, priority }) {
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers.Authorization = `Bearer ${token}`;
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ topic, title, message: body, tags, priority }),
      });
      if (!res.ok) throw new Error(`ntfy HTTP ${res.status}`);
    },
  };
}
