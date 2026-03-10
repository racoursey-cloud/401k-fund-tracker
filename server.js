const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

// ── Keys ──────────────────────────────────────────────────────────────────────
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY || '';
const TIINGO_KEY    = process.env.TIINGO_KEY || '';
const SUPA_URL      = process.env.SUPA_URL || '';
const SUPA_KEY      = process.env.SUPA_KEY || '';
const FRED_KEY      = process.env.FRED_KEY || '';
const FMP_KEY       = process.env.FMP_KEY || '';
const FINNHUB_KEY   = process.env.FINNHUB_KEY || '';

// ── Middleware ─────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname)));

// ── In-Memory Caches ──────────────────────────────────────────────────────────
const tiingoDailyCache = {};   // key: ticker, value: {data, date}
const fredCache = {};          // key: seriesId, value: {data, fetchedAt}
const finnhubNewsCache = {};   // key: query, value: {headlines, fetchedAt}
const fmpCache = {};           // key: ticker, value: {data, fetchedAt}
let gdeltLastCall = 0;         // enforce 1 req / 5 sec

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
  return mins >= 570 && mins <= 960; // 9:30 – 16:00
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

  // Check daily cache for simple ticker NAV requests
  const tickerMatch = subpath.match(/^tiingo\/daily\/([A-Za-z]+)\/prices$/);
  if (tickerMatch) {
    const tk = tickerMatch[1].toUpperCase();
    const today = todayET();
    if (tiingoDailyCache[tk] && tiingoDailyCache[tk].date === today) {
      return res.json(tiingoDailyCache[tk].data);
    }
  }

  try {
    const r = await proxyFetch(url, {
      headers: { 'Content-Type': 'application/json', 'Authorization': `Token ${TIINGO_KEY}` }
    });
    if (r.status === 429) {
      // Serve stale if available
      if (tickerMatch) {
        const tk = tickerMatch[1].toUpperCase();
        if (tiingoDailyCache[tk]) {
          return res.json({ ...tiingoDailyCache[tk].data, _stale: true });
        }
      }
      return res.status(429).json({ error: 'Tiingo rate limit. Try again later.' });
    }
    const data = await r.json();
    // Cache daily prices
    if (tickerMatch) {
      const tk = tickerMatch[1].toUpperCase();
      tiingoDailyCache[tk] = { data, date: todayET() };
    }
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
    if (method !== 'DELETE') {
      headers['Content-Type'] = 'application/json';
    }
    const opts = { method, headers };
    if (method !== 'GET' && method !== 'DELETE' && req.body) {
      opts.body = JSON.stringify(req.body);
    }
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
  const subpath = req.params[0]; // e.g. "series/observations"
  const params = new URLSearchParams(req.query);
  params.set('api_key', FRED_KEY);
  params.set('file_type', 'json');
  const url = `https://api.stlouisfed.org/fred/${subpath}?${params}`;

  // Cache check
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

// ── GET /api/bls ──────────────────────────────────────────────────────────────
app.get('/api/bls', async (req, res) => {
  try {
    const seriesIds = (req.query.series || 'CUUR0000SA0,LNS14000000').split(',');
    const year = new Date().getFullYear();
    const r = await proxyFetch('https://api.bls.gov/publicAPI/v2/timeseries/data/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seriesid: seriesIds, startyear: String(year - 1), endyear: String(year) })
    });
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/treasury ─────────────────────────────────────────────────────────
app.get('/api/treasury', async (req, res) => {
  try {
    const now = new Date();
    const yyyymm = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
    const url = `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/all/${yyyymm}?type=daily_treasury_yield_curve&field_tdr_date_value=${now.getFullYear()}&page&_format=csv`;
    const r = await proxyFetch(url);
    const text = await r.text();
    res.type('text/csv').send(text);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/fmp/* ────────────────────────────────────────────────────────────
app.get('/api/fmp/*', async (req, res) => {
  const subpath = req.params[0];
  const params = new URLSearchParams(req.query);
  params.set('apikey', FMP_KEY);
  const url = `https://financialmodelingprep.com/api/v3/${subpath}?${params}`;

  // 30-day cache for fundamentals
  const cacheKey = subpath;
  if (fmpCache[cacheKey] && (Date.now() - fmpCache[cacheKey].fetchedAt) < 2592000000) {
    return res.json(fmpCache[cacheKey].data);
  }

  try {
    const r = await proxyFetch(url);
    const data = await r.json();
    fmpCache[cacheKey] = { data, fetchedAt: Date.now() };
    res.json(data);
  } catch (e) {
    if (fmpCache[cacheKey]) return res.json(fmpCache[cacheKey].data);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/finnhub/* ────────────────────────────────────────────────────────
app.get('/api/finnhub/*', async (req, res) => {
  const subpath = req.params[0];
  const params = new URLSearchParams(req.query);
  params.set('token', FINNHUB_KEY);
  const url = `https://finnhub.io/api/v1/${subpath}?${params}`;

  // 30-min cache for news
  if (subpath.includes('news') || subpath.includes('press-releases')) {
    const cacheKey = `${subpath}:${req.query.symbol || req.query.category || ''}`;
    if (finnhubNewsCache[cacheKey] && (Date.now() - finnhubNewsCache[cacheKey].fetchedAt) < 1800000) {
      return res.json(finnhubNewsCache[cacheKey].data);
    }
    try {
      const r = await proxyFetch(url);
      const data = await r.json();
      finnhubNewsCache[cacheKey] = { data, fetchedAt: Date.now() };
      return res.json(data);
    } catch (e) {
      if (finnhubNewsCache[cacheKey]) return res.json(finnhubNewsCache[cacheKey].data);
      return res.status(500).json({ error: e.message });
    }
  }

  try {
    const r = await proxyFetch(url);
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/gdelt ────────────────────────────────────────────────────────────
app.get('/api/gdelt', async (req, res) => {
  // Enforce 1 req / 5 sec
  const now = Date.now();
  if (now - gdeltLastCall < 5000) {
    return res.status(429).json({ error: 'GDELT rate limit: 1 req per 5 seconds' });
  }
  gdeltLastCall = now;
  const params = new URLSearchParams(req.query);
  if (!params.has('mode')) params.set('mode', 'ArtList');
  if (!params.has('format')) params.set('format', 'json');
  if (!params.has('maxrecords')) params.set('maxrecords', '20');
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?${params}`;
  try {
    const r = await proxyFetch(url);
    const text = await r.text();
    try { res.json(JSON.parse(text)); }
    catch { res.send(text); }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/gnews ────────────────────────────────────────────────────────────
app.get('/api/gnews', async (req, res) => {
  const q = req.query.q || 'stock market';
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
  try {
    const r = await proxyFetch(url);
    const xml = await r.text();
    // Simple XML→JSON parse for RSS items
    const items = [];
    const re = /<item>([\s\S]*?)<\/item>/g;
    let m;
    while ((m = re.exec(xml)) !== null) {
      const get = (tag) => { const r2 = new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?(.*?)(?:\\]\\]>)?<\\/${tag}>`); const mm = m[1].match(r2); return mm ? mm[1].trim() : ''; };
      items.push({ title: get('title'), link: get('link'), pubDate: get('pubDate'), source: get('source') });
    }
    res.json({ items: items.slice(0, 20) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/edgar/* ──────────────────────────────────────────────────────────
app.get('/api/edgar/*', async (req, res) => {
  const subpath = req.params[0];
  const qs = new URLSearchParams(req.query).toString();
  const url = `https://data.sec.gov/${subpath}${qs ? '?' + qs : ''}`;
  try {
    const r = await proxyFetch(url, {
      headers: { 'User-Agent': 'FundLens/3.0 support@fundlens.app', 'Accept': 'application/json' }
    });
    const text = await r.text();
    try { res.json(JSON.parse(text)); }
    catch { res.type('text/xml').send(text); }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/efts/* ───────────────────────────────────────────────────────────
app.get('/api/efts/*', async (req, res) => {
  const subpath = req.params[0];
  const qs = new URLSearchParams(req.query).toString();
  const url = `https://efts.sec.gov/${subpath}${qs ? '?' + qs : ''}`;
  try {
    const r = await proxyFetch(url, {
      headers: { 'User-Agent': 'FundLens/3.0 support@fundlens.app', 'Accept': 'application/json' }
    });
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/www4sec/* ────────────────────────────────────────────────────────
app.get('/api/www4sec/*', async (req, res) => {
  const subpath = req.params[0];
  const qs = new URLSearchParams(req.query).toString();
  const url = `https://www.sec.gov/${subpath}${qs ? '?' + qs : ''}`;
  try {
    const r = await proxyFetch(url, {
      headers: { 'User-Agent': 'FundLens/3.0 support@fundlens.app', 'Accept': 'application/json' }
    });
    const text = await r.text();
    try { res.json(JSON.parse(text)); }
    catch { res.type('text/xml').send(text); }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
  await Promise.allSettled([
    test('anthropic', () => proxyFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 5, messages: [{ role: 'user', content: 'ping' }] })
    }).then(r => { if (!r.ok && r.status !== 400) throw new Error(`${r.status}`); })),
    test('tiingo', () => proxyFetch('https://api.tiingo.com/api/test', { headers: { 'Authorization': `Token ${TIINGO_KEY}` } }).then(r => { if (!r.ok) throw new Error(`${r.status}`); })),
    test('supabase', () => proxyFetch(`${SUPA_URL}/rest/v1/`, { headers: { 'apikey': SUPA_KEY } }).then(r => { if (!r.ok) throw new Error(`${r.status}`); })),
    test('fred', () => proxyFetch(`https://api.stlouisfed.org/fred/series?series_id=DFF&api_key=${FRED_KEY}&file_type=json`).then(r => { if (!r.ok) throw new Error(`${r.status}`); })),
    test('fmp', () => proxyFetch(`https://financialmodelingprep.com/api/v3/quote/AAPL?apikey=${FMP_KEY}`).then(r => { if (!r.ok) throw new Error(`${r.status}`); })),
    test('finnhub', () => proxyFetch(`https://finnhub.io/api/v1/quote?symbol=AAPL&token=${FINNHUB_KEY}`).then(r => { if (!r.ok) throw new Error(`${r.status}`); })),
    test('gdelt', () => proxyFetch('https://api.gdeltproject.org/api/v2/doc/doc?query=market&mode=ArtList&maxrecords=1&format=json').then(r => { if (!r.ok) throw new Error(`${r.status}`); })),
    test('edgar', () => proxyFetch('https://efts.sec.gov/LATEST/search-index?q=test&dateRange=custom&startdt=2024-01-01&enddt=2024-01-02&forms=NPORT-P', { headers: { 'User-Agent': 'FundLens/3.0 support@fundlens.app' } }).then(r => { if (!r.ok) throw new Error(`${r.status}`); })),
  ]);
  const allOk = Object.values(checks).every(v => v === 'ok');
  res.status(allOk ? 200 : 207).json({ status: allOk ? 'healthy' : 'degraded', checks, marketOpen: isMarketOpen(), serverTime: new Date().toISOString() });
});

// ── Catch-all: serve index.html ───────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => console.log(`FundLens v3 running on port ${PORT}`));
