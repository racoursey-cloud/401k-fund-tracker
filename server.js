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
        if (res.statusCode === 200) {
          results.anthropic = { ok: true, status: 200 };
        } else {
          try { results.anthropic = { ok: false, status: res.statusCode, error: JSON.parse(d)?.error?.message || d.slice(0,120) }; }
          catch(e) { results.anthropic = { ok: false, status: res.statusCode, error: d.slice(0,120) }; }
        }
        resolve();
      });
    });
    req.on('error', err => { results.anthropic = { ok: false, error: err.message }; resolve(); });
    req.write(body);
    req.end();
  });

  await new Promise(resolve => {
    if (!TIINGO_KEY) { results.tiingo = { ok: false, error: 'TIINGO_KEY not set' }; return resolve(); }
    const req = https.request({
      hostname: 'api.tiingo.com', path: '/tiingo/daily/PRPFX?token=' + TIINGO_KEY, method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        results.tiingo = res.statusCode === 200 ? { ok: true, status: 200 } : { ok: false, status: res.statusCode, error: d.slice(0,120) };
        resolve();
      });
    });
    req.on('error', err => { results.tiingo = { ok: false, error: err.message }; resolve(); });
    req.end();
  });

  await new Promise(resolve => {
    if (!SUPA_URL || !SUPA_KEY) { results.supabase = { ok: false, error: 'SUPA_URL or SUPA_KEY not set' }; return resolve(); }
    const hostname = SUPA_URL.replace('https://', '').replace('http://', '');
    const req = https.request({
      hostname, path: '/rest/v1/runs?limit=1', method: 'GET',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPA_KEY, 'Authorization': 'Bearer ' + SUPA_KEY },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode === 200) {
          results.supabase = { ok: true, status: 200 };
        } else {
          try { results.supabase = { ok: false, status: res.statusCode, error: JSON.parse(d)?.message || d.slice(0,120) }; }
          catch(e) { results.supabase = { ok: false, status: res.statusCode, error: d.slice(0,120) }; }
        }
        resolve();
      });
    });
    req.on('error', err => { results.supabase = { ok: false, error: err.message }; resolve(); });
    req.end();
  });

  return results;
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  if (req.method === 'OPTIONS') return handleCORS(res);

  if (pathname === '/health') {
    const checks = await liveHealthCheck();
    const allOk = Object.values(checks).every(c => c.ok);
    res.writeHead(allOk ? 200 : 503, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ status: allOk ? 'ok' : 'degraded', checks }, null, 2));
    return;
  }

  if (pathname === '/api/claude' && req.method === 'POST') {
    if (!ANTHROPIC_KEY) { res.writeHead(503); res.end(JSON.stringify({ error: 'ANTHROPIC_KEY not set' })); return; }
    const body = await readBody(req);
    proxyRequest(res, {
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body),
      },
    }, body);
    return;
  }

  if (pathname.startsWith('/api/tiingo/')) {
    if (!TIINGO_KEY) { res.writeHead(503); res.end(JSON.stringify({ error: 'TIINGO_KEY not set' })); return; }
    const tiingoPath = pathname.replace('/api/tiingo', '') + '?' +
      new URLSearchParams({ ...parsed.query, token: TIINGO_KEY }).toString();
    proxyRequest(res, {
      hostname: 'api.tiingo.com', path: tiingoPath, method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    }, null);
    return;
  }

  if (pathname.startsWith('/api/supabase/')) {
    if (!SUPA_URL || !SUPA_KEY) { res.writeHead(503); res.end(JSON.stringify({ error: 'Supabase not configured' })); return; }
    const supaPath = '/rest/v1/' + pathname.replace('/api/supabase/', '') + (parsed.search || '');
    const needsBody = ['POST', 'PATCH', 'PUT'].includes(req.method);
    const body = needsBody ? await readBody(req) : null;
    const hostname = SUPA_URL.replace('https://', '').replace('http://', '');
    const headers = {
      'Content-Type': 'application/json',
      'apikey': SUPA_KEY,
      'Authorization': 'Bearer ' + SUPA_KEY,
      'Prefer': req.headers['prefer'] || '',
    };
    if (body) headers['Content-Length'] = Buffer.byteLength(body);
    proxyRequest(res, { hostname, path: supaPath, method: req.method, headers }, body);
    return;
  }

  if (pathname.startsWith('/api/edgar/')) {
    const edgarPath = pathname.replace('/api/edgar', '') + (parsed.search || '');
    proxyRequest(res, {
      hostname: 'data.sec.gov', path: edgarPath, method: 'GET',
      headers: { 'User-Agent': 'FundLens/2.0 contact@fundlens.app', 'Accept': 'application/json' },
    }, null);
    return;
  }

  if (pathname.startsWith('/api/efts/')) {
    const eftsPath = pathname.replace('/api/efts', '') + (parsed.search || '');
    proxyRequest(res, {
      hostname: 'efts.sec.gov', path: eftsPath, method: 'GET',
      headers: { 'User-Agent': 'FundLens/2.0 contact@fundlens.app', 'Accept': 'application/json' },
    }, null);
    return;
  }

  if (pathname.startsWith('/api/www4sec/')) {
    const www4Path = pathname.replace('/api/www4sec', '') + (parsed.search || '');
    proxyRequest(res, {
      hostname: 'www.sec.gov', path: www4Path, method: 'GET',
      headers: { 'User-Agent': 'FundLens/2.0 contact@fundlens.app', 'Accept': '*/*' },
    }, null);
    return;
  }

  const filePath = path.join(__dirname, 'fundlens_v2.html');
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`FundLens v2 on port ${PORT}`);
  console.log(`Keys present: anthropic=${!!ANTHROPIC_KEY} tiingo=${!!TIINGO_KEY} supabase=${!!(SUPA_URL && SUPA_KEY)}`);
});
