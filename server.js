const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;

// Keys live ONLY here as Railway environment variables — never in client code
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
    res.writeHead(502);
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

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  if (req.method === 'OPTIONS') return handleCORS(res);

  // /api/claude -> Anthropic
  if (pathname === '/api/claude' && req.method === 'POST') {
    if (!ANTHROPIC_KEY) { res.writeHead(503); res.end(JSON.stringify({ error: 'ANTHROPIC_KEY not set' })); return; }
    const body = await readBody(req);
    proxyRequest(res, {
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(body) },
    }, body);
    return;
  }

  // /api/tiingo/* -> Tiingo
  if (pathname.startsWith('/api/tiingo/')) {
    if (!TIINGO_KEY) { res.writeHead(503); res.end(JSON.stringify({ error: 'TIINGO_KEY not set' })); return; }
    const tiingoPath = pathname.replace('/api/tiingo', '') + '?' + new URLSearchParams({ ...parsed.query, token: TIINGO_KEY }).toString();
    proxyRequest(res, { hostname: 'api.tiingo.com', path: tiingoPath, method: 'GET', headers: { 'Content-Type': 'application/json' } }, null);
    return;
  }

  // /api/supabase/* -> Supabase
  if (pathname.startsWith('/api/supabase/')) {
    if (!SUPA_URL || !SUPA_KEY) { res.writeHead(503); res.end(JSON.stringify({ error: 'Supabase not set' })); return; }
    const supaPath = '/rest/v1/' + pathname.replace('/api/supabase/', '') + (parsed.search || '');
    const body = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method) ? await readBody(req) : null;
    proxyRequest(res, {
      hostname: SUPA_URL.replace('https://', ''), path: supaPath, method: req.method,
      headers: { 'Content-Type': 'application/json', 'apikey': SUPA_KEY, 'Authorization': 'Bearer ' + SUPA_KEY, 'Prefer': req.headers['prefer'] || '', ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}) },
    }, body);
    return;
  }

  // /api/edgar/* -> SEC data.sec.gov
  if (pathname.startsWith('/api/edgar/')) {
    const edgarPath = pathname.replace('/api/edgar', '') + (parsed.search || '');
    proxyRequest(res, { hostname: 'data.sec.gov', path: edgarPath, method: 'GET', headers: { 'User-Agent': 'FundLens/2.0 contact@fundlens.app', 'Accept': 'application/json' } }, null);
    return;
  }

  // /api/efts/* -> SEC efts.sec.gov (full-text search)
  if (pathname.startsWith('/api/efts/')) {
    const eftsPath = pathname.replace('/api/efts', '') + (parsed.search || '');
    proxyRequest(res, { hostname: 'efts.sec.gov', path: eftsPath, method: 'GET', headers: { 'User-Agent': 'FundLens/2.0 contact@fundlens.app', 'Accept': '*/*' } }, null);
    return;
  }

  // /api/www4sec/* -> SEC www.sec.gov (XML filings)
  if (pathname.startsWith('/api/www4sec/')) {
    const www4Path = pathname.replace('/api/www4sec', '') + (parsed.search || '');
    proxyRequest(res, { hostname: 'www.sec.gov', path: www4Path, method: 'GET', headers: { 'User-Agent': 'FundLens/2.0 contact@fundlens.app', 'Accept': '*/*' } }, null);
    return;
  }

  // Health check
  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', keys: { anthropic: !!ANTHROPIC_KEY, tiingo: !!TIINGO_KEY, supabase: !!(SUPA_URL && SUPA_KEY) } }));
    return;
  }

  // Serve HTML app
  const filePath = path.join(__dirname, 'fundlens_v2.html');
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`FundLens v2 on port ${PORT} | anthropic=${!!ANTHROPIC_KEY} tiingo=${!!TIINGO_KEY} supabase=${!!(SUPA_URL&&SUPA_KEY)}`);
});
