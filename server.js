const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.openstreetmap.ru/api/interpreter'
];

app.post('/api/overpass', async (req, res) => {
  const { query } = req.body || {};
  if (!query || typeof query !== 'string') {
    return res.status(400).json({ error: 'Missing "query" string in request body' });
  }

  let lastErr = null;
  for (const url of OVERPASS_MIRRORS) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 25000);
    try {
      const resp = await fetch(url, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(query),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal: controller.signal
        // Server-to-server request: no Origin header is sent by Node's fetch,
        // so Overpass's Origin-based blocking of hosting platforms doesn't apply here.
      });
      clearTimeout(timeoutId);
      if (!resp.ok) {
        lastErr = new Error(`${url} returned status ${resp.status}`);
        continue;
      }
      const data = await resp.json();
      return res.json(data);
    } catch (err) {
      clearTimeout(timeoutId);
      lastErr = err.name === 'AbortError'
        ? new Error(`${url} timed out after 25s`)
        : err;
      continue;
    }
  }
  console.error('All Overpass mirrors failed:', lastErr);
  return res.status(502).json({ error: 'All Overpass mirrors unavailable', detail: String(lastErr) });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
