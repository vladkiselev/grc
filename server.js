// Contact finder API: visits business websites and extracts email addresses.
// Stateless: nothing is stored, results are returned straight to the browser.
const express = require('express');
const dns = require('dns').promises;
const net = require('net');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '200kb' }));

const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ||
  'https://vladkiselev.github.io,http://localhost:8000,http://127.0.0.1:8000').split(',').map(s => s.trim());

const USER_AGENT = 'GRC-ContactFinder/1.0 (+https://github.com/vladkiselev/grc)';
const PAGE_TIMEOUT_MS = 8000;
const SITE_TIMEOUT_MS = 25000;
const MAX_BYTES = 1.5 * 1024 * 1024;
const MAX_EXTRA_PAGES = 3;
const MAX_SITES_PER_REQUEST = 10;
const CONCURRENCY = 5;

// ---------- CORS ----------
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---------- Simple in-memory rate limit ----------
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 40;
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const entry = hits.get(ip);
  if (!entry || now > entry.reset) { hits.set(ip, { count: 1, reset: now + RATE_WINDOW_MS }); return false; }
  entry.count++;
  return entry.count > RATE_MAX;
}
setInterval(() => { const now = Date.now(); for (const [ip, e] of hits) if (now > e.reset) hits.delete(ip); }, RATE_WINDOW_MS).unref();

// ---------- SSRF protection: only public hosts ----------
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === '::' || l === '::1') return true;
    if (l.startsWith('::ffff:')) return isPrivateIp(l.slice(7));
    return l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80');
  }
  return true;
}
async function assertPublicUrl(u) {
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('bad protocol');
  if (u.port && !['80', '443'].includes(u.port)) throw new Error('bad port');
  if (u.username || u.password) throw new Error('credentials in url');
  const addrs = await dns.lookup(u.hostname, { all: true });
  if (!addrs.length || addrs.some(a => isPrivateIp(a.address))) throw new Error('private address');
}

// ---------- Fetching ----------
async function readLimited(resp, max) {
  const reader = resp.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
    size += value.length;
    if (size >= max) { try { await reader.cancel(); } catch (e) {} break; }
  }
  return Buffer.concat(chunks);
}

function decodeBody(buf, contentType) {
  let charset = (contentType.match(/charset=["']?([\w-]+)/i) || [])[1];
  if (!charset) {
    const head = buf.subarray(0, 4096).toString('latin1');
    charset = (head.match(/<meta[^>]+charset=["']?([\w-]+)/i) || [])[1];
  }
  try { return new TextDecoder(charset || 'utf-8').decode(buf); }
  catch (e) { return new TextDecoder('utf-8').decode(buf); }
}

async function fetchText(urlStr, { hops = 0, acceptAny = false } = {}) {
  const u = new URL(urlStr);
  await assertPublicUrl(u);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PAGE_TIMEOUT_MS);
  try {
    const resp = await fetch(u, {
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': acceptAny ? '*/*' : 'text/html,application/xhtml+xml',
        'Accept-Language': 'ru,kk;q=0.9,en;q=0.8'
      }
    });
    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get('location');
      if (!loc || hops >= 3) return null;
      return fetchText(new URL(loc, u).toString(), { hops: hops + 1, acceptAny });
    }
    if (!resp.ok) return null;
    const ct = resp.headers.get('content-type') || '';
    if (!acceptAny && !/text\/html|xhtml|text\/plain/i.test(ct)) return null;
    const buf = await readLimited(resp, MAX_BYTES);
    return { url: u.toString(), text: decodeBody(buf, ct) };
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- robots.txt ----------
function parseRobots(txt) {
  const rules = [];
  let applies = false;
  let lastWasAgent = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const val = line.slice(idx + 1).trim();
    if (key === 'user-agent') {
      const agentMatches = val === '*' || USER_AGENT.toLowerCase().startsWith(val.toLowerCase());
      applies = lastWasAgent ? (applies || agentMatches) : agentMatches;
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (applies && key === 'disallow' && val) rules.push(val);
    }
  }
  return rules;
}
async function getRobotsRules(origin) {
  const r = await fetchText(origin + '/robots.txt', { acceptAny: true });
  return r ? parseRobots(r.text) : [];
}
function allowedByRobots(rules, urlStr) {
  const path = new URL(urlStr).pathname;
  return !rules.some(rule => {
    const prefix = rule.replace(/\*.*$/, '').replace(/\$$/, '');
    return prefix && path.startsWith(prefix);
  });
}

// ---------- Email extraction ----------
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24}/gi;
const JUNK_DOMAINS = ['example.com', 'example.ru', 'example.org', 'domain.com', 'domain.ru', 'site.ru', 'mysite.ru',
  'yoursite.com', 'test.ru', 'sentry.io', 'wixpress.com', 'sentry-next.wixpress.com', 'email.com', 'mail.example'];
const JUNK_LOCALS = ['email', 'name', 'your', 'yourname', 'user', 'example', 'mail', 'test', 'username'];
const FILE_EXT_RE = /\.(png|jpe?g|gif|svg|webp|avif|css|js|ico|bmp|tiff?|mp4|webm|pdf|woff2?)$/i;

function decodeCloudflare(hex) {
  try {
    const key = parseInt(hex.substr(0, 2), 16);
    let out = '';
    for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.substr(i, 2), 16) ^ key);
    return out;
  } catch (e) { return ''; }
}

function cleanEmail(e) {
  return e.toLowerCase().replace(/^u00[0-9a-f]{2}/, '').replace(/^[._-]+/, '').replace(/[._-]+$/, '');
}
function isPlausibleEmail(e) {
  if (e.length > 80 || FILE_EXT_RE.test(e)) return false;
  const [local, domain] = e.split('@');
  if (!local || !domain) return false;
  if (JUNK_DOMAINS.some(d => domain === d || domain.endsWith('.' + d))) return false;
  if (JUNK_LOCALS.includes(local) && /example|domain|site|test/.test(domain)) return false;
  if (/^[0-9a-f]{16,}$/.test(local)) return false; // hashes (tracking ids)
  return true;
}

function extractEmails(html) {
  const found = new Set();
  for (const m of html.matchAll(/data-cfemail=["']([0-9a-f]+)["']/gi)) found.add(decodeCloudflare(m[1]));
  for (const m of html.matchAll(/email-protection#([0-9a-f]+)/gi)) found.add(decodeCloudflare(m[1]));
  const text = html
    .replace(/&#64;|&#x40;|%40|&commat;/gi, '@')
    .replace(/\s*(\[at\]|\(at\)|\{at\}|\[собака\]|\(собака\))\s*/gi, '@')
    .replace(/\s*(\[dot\]|\(dot\)|\[точка\]|\(точка\))\s*/gi, '.');
  for (const m of text.matchAll(EMAIL_RE)) found.add(m[0]);
  return [...found].map(cleanEmail).filter(isPlausibleEmail);
}

// ---------- Contact page discovery ----------
const CONTACT_HINTS = /(contact|kontakt|контакт|about|o-nas|o_nas|onas|o-kompanii|about-us|rekvizit|реквизит|company|kompaniya|feedback|svyaz|связ|о нас|о компании)/i;
const stripWww = (h) => h.replace(/^www\./i, '').toLowerCase();

function findContactLinks(html, baseUrl) {
  const base = new URL(baseUrl);
  const links = new Set();
  for (const m of html.matchAll(/<a\s[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]{0,300}?)<\/a>/gi)) {
    const href = m[1];
    const text = m[2].replace(/<[^>]+>/g, ' ');
    if (!CONTACT_HINTS.test(href) && !CONTACT_HINTS.test(text)) continue;
    let u;
    try { u = new URL(href, base); } catch (e) { continue; }
    if (!['http:', 'https:'].includes(u.protocol)) continue;
    if (stripWww(u.hostname) !== stripWww(base.hostname)) continue;
    if (FILE_EXT_RE.test(u.pathname)) continue;
    u.hash = '';
    if (u.toString() !== base.toString()) links.add(u.toString());
    if (links.size >= MAX_EXTRA_PAGES) break;
  }
  if (!links.size) ['/contacts', '/kontakty', '/contact'].forEach(p => links.add(new URL(p, base).toString()));
  return [...links].slice(0, MAX_EXTRA_PAGES);
}

// ---------- Crawl one site ----------
function normalizeWebsite(raw) {
  let s = String(raw || '').trim().split(/[;\s]/)[0];
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try { const u = new URL(s); u.hash = ''; return u; } catch (e) { return null; }
}

async function crawlSite(website) {
  const start = normalizeWebsite(website);
  if (!start) return { status: 'bad_url', emails: [] };
  try { await assertPublicUrl(start); } catch (e) { return { status: 'unreachable', emails: [] }; }

  // Check robots.txt before touching the site
  let rules = await getRobotsRules(start.origin);
  if (!allowedByRobots(rules, start.toString())) return { status: 'robots_disallow', emails: [] };

  let home = await fetchText(start.toString());
  if (!home && start.protocol === 'https:') {
    const httpUrl = new URL(start.toString()); httpUrl.protocol = 'http:';
    home = await fetchText(httpUrl.toString());
  }
  if (!home) return { status: 'unreachable', emails: [] };

  // Site redirected to another host: re-check that host's robots.txt
  const origin = new URL(home.url).origin;
  if (origin !== start.origin) {
    rules = await getRobotsRules(origin);
    if (!allowedByRobots(rules, home.url)) return { status: 'robots_disallow', emails: [] };
  }

  const emails = new Map(); // email -> source page
  extractEmails(home.text).forEach(e => { if (!emails.has(e)) emails.set(e, home.url); });

  for (const link of findContactLinks(home.text, home.url)) {
    if (!allowedByRobots(rules, link)) continue;
    const page = await fetchText(link);
    if (!page) continue;
    extractEmails(page.text).forEach(e => { if (!emails.has(e)) emails.set(e, page.url); });
  }

  return {
    status: 'ok',
    emails: [...emails].map(([email, source]) => ({ email, source }))
  };
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise(resolve => setTimeout(() => resolve({ status: 'timeout', emails: [] }), ms))
  ]);
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ---------- Email checks (syntax, domain, MX records) ----------
const resolver = new dns.Resolver({ timeout: 4000, tries: 2 });
const DOMAIN_CACHE_TTL_MS = 60 * 60 * 1000;
const domainCache = new Map(); // domain -> { result, expires }
const MAX_EMAILS_PER_CHECK = 50;

// Frequent typos in popular mail domains
const TYPO_DOMAINS = {
  'gmial.com': 'gmail.com', 'gmai.com': 'gmail.com', 'gamil.com': 'gmail.com', 'gmail.co': 'gmail.com', 'gmail.cm': 'gmail.com', 'gmaill.com': 'gmail.com',
  'yandex.ry': 'yandex.ru', 'yandx.ru': 'yandex.ru', 'yadex.ru': 'yandex.ru', 'yandex.r': 'yandex.ru', 'yndex.ru': 'yandex.ru',
  'ya.ry': 'ya.ru', 'mail.ry': 'mail.ru', 'mali.ru': 'mail.ru', 'maill.ru': 'mail.ru', 'mail.r': 'mail.ru', 'mial.ru': 'mail.ru',
  'inbox.ry': 'inbox.ru', 'bk.ry': 'bk.ru', 'list.ry': 'list.ru', 'rambler.ry': 'rambler.ru', 'ramler.ru': 'rambler.ru',
  'mail.kzz': 'mail.kz', 'hotmail.co': 'hotmail.com', 'outlook.co': 'outlook.com', 'yahoo.co': 'yahoo.com'
};
const EMAIL_SYNTAX_RE = /^[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24}$/i;

async function checkDomain(domain) {
  const cached = domainCache.get(domain);
  if (cached && cached.expires > Date.now()) return cached.result;

  let result;
  try {
    const mx = await resolver.resolveMx(domain);
    // RFC 7505 "null MX" (exchange "." or empty) means the domain explicitly accepts no mail
    if (mx.length && mx.every(r => !r.exchange || r.exchange === '.')) result = 'no_mail';
    else result = mx.length ? 'ok' : 'no_mx';
  } catch (err) {
    if (err.code === 'ENOTFOUND' || err.code === 'NXDOMAIN') {
      result = 'no_domain';
    } else if (err.code === 'ENODATA') {
      // Domain exists but has no MX: delivery falls back to the A record and often fails
      try { await resolver.resolve4(domain); result = 'no_mx'; }
      catch (e) { result = e.code === 'ENOTFOUND' ? 'no_domain' : 'no_mx'; }
    } else {
      result = 'unknown'; // DNS timeout or server error: don't judge
    }
  }
  if (result !== 'unknown') domainCache.set(domain, { result, expires: Date.now() + DOMAIN_CACHE_TTL_MS });
  return result;
}

async function checkEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!EMAIL_SYNTAX_RE.test(e)) return { email, status: 'invalid' };
  const domain = e.split('@')[1];
  if (TYPO_DOMAINS[domain]) return { email, status: 'typo', suggestion: e.split('@')[0] + '@' + TYPO_DOMAINS[domain] };
  return { email, status: await checkDomain(domain) };
}

// ---------- Routes ----------
app.get('/health', (req, res) => res.json({ ok: true }));

app.post('/api/find-emails', async (req, res) => {
  if (rateLimited(req.ip)) return res.status(429).json({ error: 'Слишком много запросов, подождите минуту' });

  const sites = Array.isArray(req.body && req.body.sites) ? req.body.sites : null;
  if (!sites || !sites.length) return res.status(400).json({ error: 'Передайте sites: [{id, website}]' });
  if (sites.length > MAX_SITES_PER_REQUEST) return res.status(400).json({ error: `Не больше ${MAX_SITES_PER_REQUEST} сайтов за запрос` });

  const results = await mapWithConcurrency(sites, CONCURRENCY, async (s) => {
    const r = await withTimeout(crawlSite(s.website).catch(() => ({ status: 'error', emails: [] })), SITE_TIMEOUT_MS);
    return { id: s.id, website: s.website, ...r };
  });
  res.json({ results });
});

app.post('/api/check-emails', async (req, res) => {
  if (rateLimited(req.ip)) return res.status(429).json({ error: 'Слишком много запросов, подождите минуту' });
  const emails = Array.isArray(req.body && req.body.emails) ? [...new Set(req.body.emails.map(String))] : null;
  if (!emails || !emails.length) return res.status(400).json({ error: 'Передайте emails: [...]' });
  if (emails.length > MAX_EMAILS_PER_CHECK) return res.status(400).json({ error: `Не больше ${MAX_EMAILS_PER_CHECK} адресов за запрос` });
  const results = await mapWithConcurrency(emails, 10, (e) => checkEmail(e).catch(() => ({ email: e, status: 'unknown' })));
  res.json({ results });
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`Contact finder API on port ${PORT}`));
}
module.exports = { checkEmail, extractEmails, findContactLinks, parseRobots, allowedByRobots, isPrivateIp, decodeCloudflare, app };
