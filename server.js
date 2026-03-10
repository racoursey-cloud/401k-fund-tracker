const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

// ── Keys ──────────────────────────────────────────────────────────────────────
const ANTHROPIC_KEY  = process.env.ANTHROPIC_KEY || '';
const TIINGO_KEY     = process.env.TIINGO_KEY || '';
const SUPA_URL       = process.env.SUPA_URL || '';
const SUPA_KEY       = process.env.SUPA_KEY || '';
const FRED_KEY       = process.env.FRED_KEY || '';
const FINNHUB_KEY    = process.env.FINNHUB_KEY || '';
const TWELVEDATA_KEY = process.env.TWELVEDATA_KEY || '';  // Optional — set in Railway if available

// ── Middleware ─────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname)));

// ── In-Memory Caches ──────────────────────────────────────────────────────────
const tiingoDailyCache = {};
const fredCache = {};
const finnhubCache = {};     // 30min for news, 30d for fundamentals/metrics
const twelvedataCache = {};
const treasuryCache   = {};  // 24h TTL — Treasury yields update once daily
const rssCache        = {};  // 30min TTL — news headlines
let gdeltLastCall = 0;

// ── Helpers ───────────────────────────────────────────────────────────────────
function todayET() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function isMarketOpen() {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = et.getDay();
  if (day === 0 || day === 6) return false;
  const h = et.getHours(), m = et.getMinutes();
  const mins = h * 60 + m;
  return mins >= 570 && mins < 960;
}

async function proxyFetch(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeout);
    return res;
  } catch (e) {
    clearTimeout(timeout);
    throw e;
  }
}

// ── POST /api/claude ──────────────────────────────────────────────────────────
app.post('/api/claude', async (req, res) => {
  try {
    const r = await proxyFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(req.body)
    });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/tiingo/* ─────────────────────────────────────────────────────────
app.get('/api/tiingo/*', async (req, res) => {
  const subpath = req.params[0];
  const qs = new URLSearchParams(req.query).toString();
  const url = `https://api.tiingo.com/${subpath}${qs ? '?' + qs : ''}`;

  const tickerMatch = subpath.match(/^tiingo\/daily\/([A-Za-z]+)\/prices$/);
  // Cache key includes query string so date-range and bare requests are separate
  const cacheKey = tickerMatch ? `${tickerMatch[1].toUpperCase()}:${qs}` : null;

  if (cacheKey && tiingoDailyCache[cacheKey] && tiingoDailyCache[cacheKey].date === todayET()) {
    return res.json(tiingoDailyCache[cacheKey].data);
  }

  try {
    const r = await proxyFetch(url, {
      headers: { 'Content-Type': 'application/json', 'Authorization': `Token ${TIINGO_KEY}` }
    });
    if (r.status === 429) {
      // Serve stale if available — mark last item with _stale for arrays
      if (cacheKey && tiingoDailyCache[cacheKey]) {
        const stale = tiingoDailyCache[cacheKey].data;
        if (Array.isArray(stale) && stale.length) {
          const copy = [...stale];
          copy[copy.length - 1] = { ...copy[copy.length - 1], _stale: true };
          return res.json(copy);
        }
        return res.json({ ...stale, _stale: true });
      }
      return res.status(429).json({ error: 'Tiingo rate limit. Try again later.' });
    }
    const data = await r.json();
    if (cacheKey) tiingoDailyCache[cacheKey] = { data, date: todayET() };
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Supabase REST proxy ───────────────────────────────────────────────────────
function supabaseProxy(method) {
  return async (req, res) => {
    const subpath = req.params[0];
    const qs = new URLSearchParams(req.query).toString();
    const url = `${SUPA_URL}/rest/v1/${subpath}${qs ? '?' + qs : ''}`;
    const headers = {
      'apikey': SUPA_KEY,
      'Authorization': `Bearer ${SUPA_KEY}`,
      'Prefer': req.headers['prefer'] || ''
    };
    if (method !== 'DELETE') headers['Content-Type'] = 'application/json';
    const opts = { method, headers };
    if (method !== 'GET' && method !== 'DELETE' && req.body) opts.body = JSON.stringify(req.body);
    try {
      const r = await proxyFetch(url, opts);
      const text = await r.text();
      try { res.status(r.status).json(JSON.parse(text)); }
      catch { res.status(r.status).send(text); }
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  };
}
app.get('/api/supabase/*', supabaseProxy('GET'));
app.post('/api/supabase/*', supabaseProxy('POST'));
app.patch('/api/supabase/*', supabaseProxy('PATCH'));
app.delete('/api/supabase/*', supabaseProxy('DELETE'));

// ── GET /api/fred/* ───────────────────────────────────────────────────────────
app.get('/api/fred/*', async (req, res) => {
  const subpath = req.params[0];
  const params = new URLSearchParams(req.query);
  params.set('api_key', FRED_KEY);
  params.set('file_type', 'json');
  const url = `https://api.stlouisfed.org/fred/${subpath}?${params}`;
  const cacheKey = `${subpath}:${req.query.series_id || ''}`;
  if (fredCache[cacheKey] && (Date.now() - fredCache[cacheKey].fetchedAt) < 86400000) {
    return res.json(fredCache[cacheKey].data);
  }
  try {
    const r = await proxyFetch(url);
    const data = await r.json();
    fredCache[cacheKey] = { data, fetchedAt: Date.now() };
    res.json(data);
  } catch (e) {
    if (fredCache[cacheKey]) return res.json(fredCache[cacheKey].data);
    res.status(500).json({ error: e.message });
  }
});


// ── GET /api/treasury ─────────────────────────────────────────────────────────
app.get('/api/treasury', async (req, res) => {
  const TREASURY_TTL = 86400000; // 24h — yields update once daily
  if (treasuryCache.data && (Date.now() - treasuryCache.fetchedAt) < TREASURY_TTL) {
    return res.json(treasuryCache.data);
  }
  try {
    const now = new Date();
    const yyyymm = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
    const url = `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/all/${yyyymm}?type=daily_treasury_yield_curve&field_tdr_date_value=${now.getFullYear()}&page&_format=csv`;
    const r = await proxyFetch(url);
    const csv = await r.text();
    const lines = csv.trim().split('\n').filter(l => l.trim());
    if (lines.length < 2) return res.status(502).json({ error: 'Treasury returned empty data' });
    const headers = lines[0].split(',').map(h => h.replace(/"/g, '').trim());
    const rows = lines.slice(1).map(line => {
      const vals = line.split(',');
      const row = {};
      headers.forEach((h, i) => { row[h] = vals[i]?.trim() || null; });
      return row;
    });
    const payload = { updated: rows[0]?.Date || null, rows };
    treasuryCache.data = payload;
    treasuryCache.fetchedAt = Date.now();
    res.json(payload);
  } catch (e) {
    if (treasuryCache.data) return res.json(treasuryCache.data); // serve stale on error
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/rss ──────────────────────────────────────────────────────────────
// Proxies RSS/Atom feeds from whitelisted financial news sources.
// Returns parsed headlines array: [{title, url, published}]
const RSS_WHITELIST = [
  'feeds.content.dowjones.io',   // MarketWatch
  'search.cnbc.com',             // CNBC
  'feeds.a.dj.com',              // Dow Jones
  'rss.cnn.com',                 // CNN Business (fallback)
];
app.get('/api/rss', async (req, res) => {
  const feedUrl = req.query.url;
  if (!feedUrl) return res.status(400).json({ error: 'Missing url param' });
  let hostname;
  try { hostname = new URL(feedUrl).hostname; } catch { return res.status(400).json({ error: 'Invalid url' }); }
  if (!RSS_WHITELIST.some(h => hostname === h || hostname.endsWith('.' + h))) {
    return res.status(403).json({ error: 'Feed host not whitelisted' });
  }
  const cacheKey = 'rss:' + feedUrl;
  if (rssCache[cacheKey] && (Date.now() - rssCache[cacheKey].fetchedAt) < 1800000) { // 30min
    return res.json(rssCache[cacheKey].data);
  }
  try {
    const r = await proxyFetch(feedUrl, { headers: { 'User-Agent': 'FundLens/3.0 support@fundlens.app' } });
    const xml = await r.text();
    // Parse RSS/Atom — extract titles and links
    const items = [];
    const itemRe = /<item[\s>]([\s\S]*?)<\/item>/gi;
    const entryRe = /<entry[\s>]([\s\S]*?)<\/entry>/gi;
    const extract = (block) => {
      const title = (block.match(/<title[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/i) || [])[1]?.trim() || '';
      const link  = (block.match(/<link[^>]*href="([^"]+)"/i) || block.match(/<link[^>]*>(https?[^<]+)/i) || [])[1]?.trim() || '';
      const pub   = (block.match(/<pubDate>(.*?)<\/pubDate>/i) || block.match(/<published>(.*?)<\/published>/i) || [])[1]?.trim() || '';
      if (title && title.length > 10) items.push({ title: title.replace(/&amp;/g,'&').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>'), url: link, published: pub });
    };
    let m;
    while ((m = itemRe.exec(xml)) !== null) extract(m[1]);
    while ((m = entryRe.exec(xml)) !== null) extract(m[1]);
    const payload = { items: items.slice(0, 20), source: hostname };
    rssCache[cacheKey] = { data: payload, fetchedAt: Date.now() };
    res.json(payload);
  } catch (e) {
    if (rssCache[cacheKey]) return res.json(rssCache[cacheKey].data);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/fmp/* (dead — FMP free tier dropped as of Aug 2025) ─────────────
app.get('/api/fmp/*', (req, res) => {
  res.status(410).json({ error: 'FMP free tier discontinued. Sector mapping uses Claude fallback.' });
});

// ── GET /api/twelvedata/* ────────────────────────────────────────────────────
app.get('/api/twelvedata/*', async (req, res) => {
  if (!TWELVEDATA_KEY) return res.status(503).json({ error: 'TWELVEDATA_KEY not configured' });
  const subpath = req.params[0];
  const params = new URLSearchParams(req.query);
  params.set('apikey', TWELVEDATA_KEY);
  const url = `https://api.twelvedata.com/${subpath}?${params}`;
  const cacheKey = `td:${subpath}:${req.query.symbol || ''}`;
  if (twelvedataCache[cacheKey] && (Date.now() - twelvedataCache[cacheKey].fetchedAt) < 86400000) {   // 24h — gold moves $50-100/day
    return res.json(twelvedataCache[cacheKey].data);
  }
  try {
    const r = await proxyFetch(url);
    const data = await r.json();
    if (!data.code) twelvedataCache[cacheKey] = { data, fetchedAt: Date.now() };
    res.json(data);
  } catch (e) {
    if (twelvedataCache[cacheKey]) return res.json(twelvedataCache[cacheKey].data);
    res.status(500).json({ error: e.message });
  }
});


// ── GET /api/gdelt ────────────────────────────────────────────────────────────
app.get('/api/gdelt', async (req, res) => {
  const now = Date.now();
  if (now - gdeltLastCall < 5000) return res.status(429).json({ error: 'GDELT rate limit: 1 req per 5 seconds' });
  gdeltLastCall = now;
  const params = new URLSearchParams(req.query);
  if (!params.has('mode')) params.set('mode', 'ArtList');
  if (!params.has('format')) params.set('format', 'json');
  if (!params.has('maxrecords')) params.set('maxrecords', '20');
  try {
    const r = await proxyFetch(`https://api.gdeltproject.org/api/v2/doc/doc?${params}`);
    const text = await r.text();
    try { res.json(JSON.parse(text)); } catch { res.send(text); }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// ── SEC EDGAR proxies ─────────────────────────────────────────────────────────
const SEC_HEADERS = { 'User-Agent': 'FundLens/3.0 support@fundlens.app', 'Accept': 'application/json' };

app.get('/api/edgar/*', async (req, res) => {
  const url = `https://data.sec.gov/${req.params[0]}${new URLSearchParams(req.query).toString() ? '?' + new URLSearchParams(req.query) : ''}`;
  try {
    const r = await proxyFetch(url, { headers: SEC_HEADERS });
    const text = await r.text();
    try { res.json(JSON.parse(text)); } catch { res.type('text/xml').send(text); }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/efts/*', async (req, res) => {
  const url = `https://efts.sec.gov/${req.params[0]}${new URLSearchParams(req.query).toString() ? '?' + new URLSearchParams(req.query) : ''}`;
  try {
    const r = await proxyFetch(url, { headers: SEC_HEADERS });
    res.json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/www4sec/*', async (req, res) => {
  const url = `https://www.sec.gov/${req.params[0]}${new URLSearchParams(req.query).toString() ? '?' + new URLSearchParams(req.query) : ''}`;
  try {
    const r = await proxyFetch(url, { headers: SEC_HEADERS });
    const text = await r.text();
    try { res.json(JSON.parse(text)); } catch { res.type('text/xml').send(text); }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/market-status ────────────────────────────────────────────────────
app.get('/api/market-status', (req, res) => {
  res.json({ open: isMarketOpen(), date: todayET() });
});

// ── GET /health ───────────────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  const checks = {};
  const test = async (name, fn) => {
    try { await fn(); checks[name] = 'ok'; } catch (e) { checks[name] = `error: ${e.message}`; }
  };
  const tests = [
    test('anthropic', () => proxyFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 5, messages: [{ role: 'user', content: 'ping' }] })
    }).then(r => { if (!r.ok && r.status !== 400) throw new Error(`${r.status}`); })),
    test('tiingo', () => proxyFetch('https://api.tiingo.com/api/test', { headers: { 'Authorization': `Token ${TIINGO_KEY}` } }).then(r => { if (!r.ok) throw new Error(`${r.status}`); })),
    test('supabase', () => proxyFetch(`${SUPA_URL}/rest/v1/`, { headers: { 'apikey': SUPA_KEY } }).then(r => { if (!r.ok) throw new Error(`${r.status}`); })),
    test('fred', () => proxyFetch(`https://api.stlouisfed.org/fred/series?series_id=DFF&api_key=${FRED_KEY}&file_type=json`).then(r => { if (!r.ok) throw new Error(`${r.status}`); })),
    test('finnhub', () => proxyFetch(`https://finnhub.io/api/v1/quote?symbol=AAPL&token=${FINNHUB_KEY}`).then(r => { if (!r.ok) throw new Error(`${r.status}`); })),
    // Test actual EDGAR endpoint used in the holdings pipeline
    test('edgar', () => proxyFetch('https://www.sec.gov/files/company_tickers_mf.json', { headers: SEC_HEADERS }).then(r => { if (!r.ok) throw new Error(`${r.status}`); })),
    test('gdelt', () => proxyFetch('https://api.gdeltproject.org/api/v2/doc/doc?query=market&mode=ArtList&maxrecords=1&format=json').then(r => { if (!r.ok) throw new Error(`${r.status}`); })),
  ];
  if (TWELVEDATA_KEY) {
    tests.push(test('twelvedata', () => proxyFetch(`https://api.twelvedata.com/quote?symbol=AAPL&apikey=${TWELVEDATA_KEY}`).then(r => { if (!r.ok) throw new Error(`${r.status}`); })));
  }
  await Promise.allSettled(tests);
  const allOk = Object.values(checks).every(v => v === 'ok');
  res.status(allOk ? 200 : 207).json({ status: allOk ? 'healthy' : 'degraded', checks, marketOpen: isMarketOpen(), serverTime: new Date().toISOString() });
});

// ── Catch-all ─────────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => console.log(`FundLens v3 running on port ${PORT}`));
