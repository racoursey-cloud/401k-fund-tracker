const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;

const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY || '';
const TIINGO_KEY    = process.env.TIINGO_KEY    || '';
const SUPA_URL      = process.env.SUPA_URL      || '';
const SUPA_KEY      = process.env.SUPA_KEY      || '';
const FRED_KEY      = process.env.FRED_KEY      || '';   // Free at fredaccount.stlouisfed.org
const FMP_KEY       = process.env.FMP_KEY       || '';   // Free at financialmodelingprep.com (250 req/day)

// ── Tiingo daily price cache ─────────────────────────────────────
// Survives page refreshes; serves stale data when 429 rate limit is hit.
// Key: ticker symbol. Value: { data: <array>, date: 'YYYY-MM-DD' }
const tiingoDailyCache = {};
function todayStr() { return new Date().toISOString().split('T')[0]; }

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function proxyRequest(res, options, body) {
  const upstream = https.request(options, upstreamRes => {
    res.writeHead(upstreamRes.statusCode, {
      'Content-Type': upstreamRes.headers['content-type'] || 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    upstreamRes.pipe(res);
  });
  upstream.on('error', err => {
    console.error('Proxy error:', err.message);
    if (!res.headersSent) res.writeHead(502);
    res.end(JSON.stringify({ error: 'Proxy error', detail: err.message }));
  });
  if (body) upstream.write(body);
  upstream.end();
}

function handleCORS(res) {
  res.writeHead(204, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, Prefer',
  });
  res.end();
}

async function liveHealthCheck() {
  const results = {};

  // Anthropic
  await new Promise(resolve => {
    if (!ANTHROPIC_KEY) { results.anthropic = { ok: false, error: 'ANTHROPIC_KEY not set' }; return resolve(); }
    const body = JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] });
    const req = https.request({
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode === 200) { results.anthropic = { ok: true, status: 200 }; }
        else { try { results.anthropic = { ok: false, status: res.statusCode, error: JSON.parse(d)?.error?.message || d.slice(0,120) }; } catch(e) { results.anthropic = { ok: false, status: res.statusCode, error: d.slice(0,120) }; } }
        resolve();
      });
    });
    req.on('error', err => { results.anthropic = { ok: false, error: err.message }; resolve(); });
    req.write(body); req.end();
  });

  // Tiingo
  await new Promise(resolve => {
    if (!TIINGO_KEY) { results.tiingo = { ok: false, error: 'TIINGO_KEY not set' }; return resolve(); }
    const req = https.request({
      hostname: 'api.tiingo.com', path: '/tiingo/daily/PRPFX?token=' + TIINGO_KEY, method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { results.tiingo = res.statusCode === 200 ? { ok: true } : { ok: false, status: res.statusCode, error: d.slice(0,120) }; resolve(); });
    });
    req.on('error', err => { results.tiingo = { ok: false, error: err.message }; resolve(); });
    req.end();
  });

  // Supabase
  await new Promise(resolve => {
    if (!SUPA_URL || !SUPA_KEY) { results.supabase = { ok: false, error: 'SUPA_URL or SUPA_KEY not set' }; return resolve(); }
    const hostname = SUPA_URL.replace('https://', '').replace('http://', '');
    const req = https.request({
      hostname, path: '/rest/v1/prediction_cycles?limit=1', method: 'GET',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPA_KEY, 'Authorization': 'Bearer ' + SUPA_KEY },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode === 200) { results.supabase = { ok: true }; }
        else { try { results.supabase = { ok: false, status: res.statusCode, error: JSON.parse(d)?.message || d.slice(0,120) }; } catch(e) { results.supabase = { ok: false, status: res.statusCode, error: d.slice(0,120) }; } }
        resolve();
      });
    });
    req.on('error', err => { results.supabase = { ok: false, error: err.message }; resolve(); });
    req.end();
  });

  // FRED — live test call (fetch latest Fed Funds Rate — single observation)
  await new Promise(resolve => {
    if (!FRED_KEY) { results.fred = { ok: false, note: 'FRED_KEY not set — register free at fredaccount.stlouisfed.org' }; return resolve(); }
    const fredPath = '/fred/series/observations?series_id=DFF&sort_order=desc&limit=1&api_key=' + FRED_KEY + '&file_type=json';
    const req = https.request({
      hostname: 'api.stlouisfed.org', path: fredPath, method: 'GET',
      headers: { 'Accept': 'application/json' },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const parsed = JSON.parse(d);
            const val = parsed?.observations?.[0]?.value;
            const date = parsed?.observations?.[0]?.date;
            results.fred = { ok: true, status: 200, series: 'DFF', latestValue: val, latestDate: date };
          } catch(e) {
            results.fred = { ok: false, status: 200, error: 'Response parsed but unexpected shape — ' + d.slice(0, 80) };
          }
        } else {
          try { results.fred = { ok: false, status: res.statusCode, error: JSON.parse(d)?.error_message || d.slice(0, 120) }; }
          catch(e) { results.fred = { ok: false, status: res.statusCode, error: d.slice(0, 120) }; }
        }
        resolve();
      });
    });
    req.on('error', err => { results.fred = { ok: false, error: err.message }; resolve(); });
    req.end();
  });

  // FMP — live test call (profile lookup for SPY — lightweight, always available)
  await new Promise(resolve => {
    if (!FMP_KEY) { results.fmp = { ok: false, note: 'FMP_KEY not set — register free at financialmodelingprep.com (250 req/day)' }; return resolve(); }
    const fmpPath = '/stable/profile?symbol=SPY&apikey=' + FMP_KEY;
    const req = https.request({
      hostname: 'financialmodelingprep.com', path: fmpPath, method: 'GET',
      headers: { 'Accept': 'application/json' },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const parsed = JSON.parse(d);
            const sector = parsed?.[0]?.sector || null;
            const name = parsed?.[0]?.companyName || null;
            if (sector || name) {
              results.fmp = { ok: true, status: 200, testTicker: 'SPY', sector, name };
            } else {
              results.fmp = { ok: false, status: 200, error: 'Response OK but empty — key may be invalid or daily limit reached' };
            }
          } catch(e) {
            results.fmp = { ok: false, status: 200, error: 'Response parsed but unexpected shape — ' + d.slice(0, 80) };
          }
        } else {
          try { results.fmp = { ok: false, status: res.statusCode, error: JSON.parse(d)?.message || d.slice(0, 120) }; }
          catch(e) { results.fmp = { ok: false, status: res.statusCode, error: d.slice(0, 120) }; }
        }
        resolve();
      });
    });
    req.on('error', err => { results.fmp = { ok: false, error: err.message }; resolve(); });
    req.end();
  });

  return results;
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  if (req.method === 'OPTIONS') return handleCORS(res);

  // ── Health check ─────────────────────────────────────────────
  if (pathname === '/health') {
    const checks = await liveHealthCheck();
    const critical = ['anthropic', 'tiingo', 'supabase'];
    const allOk = critical.every(k => checks[k]?.ok);
    res.writeHead(allOk ? 200 : 503, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ status: allOk ? 'ok' : 'degraded', checks }, null, 2));
    return;
  }

  // ── Anthropic / Claude ────────────────────────────────────────
  if (pathname === '/api/claude' && req.method === 'POST') {
    if (!ANTHROPIC_KEY) { res.writeHead(503); res.end(JSON.stringify({ error: 'ANTHROPIC_KEY not set' })); return; }
    const body = await readBody(req);
    proxyRequest(res, {
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(body) },
    }, body);
    return;
  }

  // ── Tiingo ────────────────────────────────────────────────────
  if (pathname.startsWith('/api/tiingo/')) {
    if (!TIINGO_KEY) { res.writeHead(503); res.end(JSON.stringify({ error: 'TIINGO_KEY not set' })); return; }
    const tiingoPath = pathname.replace('/api/tiingo', '') + '?' +
      new URLSearchParams({ ...parsed.query, token: TIINGO_KEY }).toString();

    // Cache daily price requests server-side so the pipeline continues even
    // when Tiingo's hourly limit is hit — serves previous data transparently.
    const tickerMatch = pathname.match(/\/daily\/([^\/]+)\/prices/);
    const cacheTicker = tickerMatch?.[1]?.toUpperCase();

    if (cacheTicker) {
      const today = todayStr();
      const cached = tiingoDailyCache[cacheTicker];

      // Already have today's data — return immediately
      if (cached && cached.date === today) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'X-Tiingo-Cache': 'HIT' });
        res.end(JSON.stringify(cached.data));
        return;
      }

      // Fetch from Tiingo, buffer so we can cache it
      const upstream = https.request(
        { hostname: 'api.tiingo.com', path: tiingoPath, method: 'GET', headers: { 'Content-Type': 'application/json' } },
        upstreamRes => {
          let buf = '';
          upstreamRes.on('data', chunk => buf += chunk);
          upstreamRes.on('end', () => {
            if (upstreamRes.statusCode === 200) {
              try { tiingoDailyCache[cacheTicker] = { data: JSON.parse(buf), date: today }; } catch(e) {}
              res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
              res.end(buf);
            } else if (upstreamRes.statusCode === 429) {
              if (cached) {
                // Rate limited — serve stale cache transparently
                console.warn('Tiingo 429 for ' + cacheTicker + ' — serving cached data from ' + cached.date);
                res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'X-Tiingo-Cache': 'STALE' });
                res.end(JSON.stringify(cached.data));
              } else {
                console.warn('Tiingo 429 for ' + cacheTicker + ' — no cache, returning 429');
                res.writeHead(429, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(buf);
              }
            } else {
              res.writeHead(upstreamRes.statusCode, { 'Content-Type': upstreamRes.headers['content-type'] || 'application/json', 'Access-Control-Allow-Origin': '*' });
              res.end(buf);
            }
          });
        }
      );
      upstream.on('error', err => {
        if (cached && !res.headersSent) {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'X-Tiingo-Cache': 'STALE' });
          res.end(JSON.stringify(cached.data));
        } else if (!res.headersSent) {
          res.writeHead(502); res.end(JSON.stringify({ error: 'Tiingo proxy error', detail: err.message }));
        }
      });
      upstream.end();
      return;
    }

    // Non-price Tiingo request — pass through
    proxyRequest(res, { hostname: 'api.tiingo.com', path: tiingoPath, method: 'GET', headers: { 'Content-Type': 'application/json' } }, null);
    return;
  }

  // ── Supabase ──────────────────────────────────────────────────
  if (pathname.startsWith('/api/supabase/')) {
    if (!SUPA_URL || !SUPA_KEY) { res.writeHead(503); res.end(JSON.stringify({ error: 'Supabase not configured' })); return; }
    const supaPath = '/rest/v1/' + pathname.replace('/api/supabase/', '') + (parsed.search || '');
    const needsBody = ['POST', 'PATCH', 'PUT'].includes(req.method);
    const body = needsBody ? await readBody(req) : null;
    const hostname = SUPA_URL.replace('https://', '').replace('http://', '');
    // Don't send Content-Type on DELETE — some Supabase versions reject it with no body
    const headers = {
      'apikey': SUPA_KEY,
      'Authorization': 'Bearer ' + SUPA_KEY,
      'Prefer': req.headers['prefer'] || 'return=minimal',
    };
    if (needsBody) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    proxyRequest(res, { hostname, path: supaPath, method: req.method, headers }, body);
    return;
  }

  // ── EDGAR / SEC ───────────────────────────────────────────────
  if (pathname.startsWith('/api/edgar/')) {
    const edgarPath = pathname.replace('/api/edgar', '') + (parsed.search || '');
    proxyRequest(res, { hostname: 'data.sec.gov', path: edgarPath, method: 'GET', headers: { 'User-Agent': 'FundLens/3.0 contact@fundlens.app', 'Accept': 'application/json' } }, null);
    return;
  }
  if (pathname.startsWith('/api/efts/')) {
    const eftsPath = pathname.replace('/api/efts', '') + (parsed.search || '');
    proxyRequest(res, { hostname: 'efts.sec.gov', path: eftsPath, method: 'GET', headers: { 'User-Agent': 'FundLens/3.0 contact@fundlens.app', 'Accept': 'application/json' } }, null);
    return;
  }
  if (pathname.startsWith('/api/www4sec/')) {
    const www4Path = pathname.replace('/api/www4sec', '') + (parsed.search || '');
    proxyRequest(res, { hostname: 'www.sec.gov', path: www4Path, method: 'GET', headers: { 'User-Agent': 'FundLens/3.0 contact@fundlens.app', 'Accept': '*/*' } }, null);
    return;
  }

  // ── FRED (St. Louis Fed) ───────────────────────────────────────
  // Free API — register at fredaccount.stlouisfed.org
  // Example: GET /api/fred/series/observations?series_id=DFF&sort_order=desc&limit=5
  if (pathname.startsWith('/api/fred/')) {
    if (!FRED_KEY) { res.writeHead(503); res.end(JSON.stringify({ error: 'FRED_KEY not set — register free at fredaccount.stlouisfed.org' })); return; }
    const fredPath = pathname.replace('/api/fred', '/fred') + '?' +
      new URLSearchParams({ ...parsed.query, api_key: FRED_KEY, file_type: 'json' }).toString();
    proxyRequest(res, { hostname: 'api.stlouisfed.org', path: fredPath, method: 'GET', headers: { 'Accept': 'application/json' } }, null);
    return;
  }

  // ── GDELT (geopolitical/news intelligence — no API key required) ─
  // Example: GET /api/gdelt?query=oil+conflict&mode=artlist&maxrecords=10&format=json
  if (pathname.startsWith('/api/gdelt')) {
    const gdeltPath = '/api/v2/doc/doc?' + new URLSearchParams({ ...parsed.query, format: 'json' }).toString();
    proxyRequest(res, { hostname: 'api.gdeltproject.org', path: gdeltPath, method: 'GET', headers: { 'Accept': 'application/json', 'User-Agent': 'FundLens/3.0 contact@fundlens.app' } }, null);
    return;
  }

  // ── Financial Modeling Prep (GICS sector mapping) ─────────────
  // Free tier: 250 req/day — register at financialmodelingprep.com
  // Example: GET /api/fmp/api/v3/profile/AAPL
  if (pathname.startsWith('/api/fmp/')) {
    if (!FMP_KEY) { res.writeHead(503); res.end(JSON.stringify({ error: 'FMP_KEY not set — register free at financialmodelingprep.com' })); return; }
    const fmpSubPath = pathname.replace('/api/fmp', '');
    const fmpPath = fmpSubPath + '?' + new URLSearchParams({ ...parsed.query, apikey: FMP_KEY }).toString();
    proxyRequest(res, { hostname: 'financialmodelingprep.com', path: fmpPath, method: 'GET', headers: { 'Accept': 'application/json' } }, null);
    return;
  }

  // ── Frankfurter (ECB-backed forex — no key required) ─────────
  // Example: GET /api/forex/latest?base=USD
  if (pathname.startsWith('/api/forex')) {
    const forexPath = pathname.replace('/api/forex', '') + (parsed.search || '');
    proxyRequest(res, { hostname: 'api.frankfurter.dev', path: forexPath || '/v1/latest', method: 'GET', headers: { 'Accept': 'application/json' } }, null);
    return;
  }

  // ── Serve app ─────────────────────────────────────────────────
  const filePath = path.join(__dirname, 'fundlens_v2.html');
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`FundLens v3 on port ${PORT}`);
  console.log(`Keys → anthropic:${!!ANTHROPIC_KEY} tiingo:${!!TIINGO_KEY} supabase:${!!(SUPA_URL&&SUPA_KEY)} fred:${!!FRED_KEY} fmp:${!!FMP_KEY}`);
  if (!FRED_KEY) console.log('  ℹ  FRED_KEY missing — macro will use Claude web search (still works, less structured)');
  if (!FMP_KEY)  console.log('  ℹ  FMP_KEY missing  — sector mapping will use Claude classification (still works)');
});
