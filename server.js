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

  const errors = [];
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
        errors.push(`${url} -> HTTP ${resp.status}`);
        continue;
      }
      const data = await resp.json();
      return res.json(data);
    } catch (err) {
      clearTimeout(timeoutId);
      const msg = err.name === 'AbortError'
        ? `${url} -> timed out after 25s`
        : `${url} -> ${err.cause ? err.cause.code || err.cause.message : err.message}`;
      errors.push(msg);
      continue;
    }
  }
  console.error('All Overpass mirrors failed:\n' + errors.join('\n'));
  return res.status(502).json({ error: 'All Overpass mirrors unavailable', detail: errors });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
