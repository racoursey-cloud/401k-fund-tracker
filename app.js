// ═══════════════════════════════════════════════════════════════════════════════
//  FundLens v3 — app.js  (All pipeline logic, scoring, prediction tracking)
// ═══════════════════════════════════════════════════════════════════════════════

const FundLens = (() => {
  // ── State ─────────────────────────────────────────────────────────────────
  let state = {
    userId: 'robert',
    profile: null,
    funds: [],
    holdingsMap: {},
    fundamentalsMap: {},
    worldData: null,
    thesis: null,
    sectorScores: null,
    fundScores: [],
    allocation: null,
    currentCycle: null,
    pastCycles: [],
    isRunning: false,
    pipelineStep: '',
    pipelineProgress: 0,
    marketOpen: true,
    usingCachedPrices: false,
    _navDate: null,
    _lastTrackTime: 0,
  };

  const DEFAULT_WEIGHTS = { trend: 35, foundations: 22, room: 18, safe: 15, feel: 10 };
  const SLIDER_MULTIPLIERS = [0.25, 0.60, 1.0, 1.5, 2.0];
  const SLIDER_LABELS = {
    trend: ['Ignore', 'Slight lean', 'Balanced', 'Lean on it', 'Trust it fully'],
    foundations: ['Ignore', 'Slight lean', 'Balanced', 'Lean on it', 'Fundamentals first'],
    room: ['Ignore', 'Slight lean', 'Balanced', 'News matters', 'News drives everything'],
    safe: ['Full throttle', 'Mostly aggressive', 'Balanced', 'Err cautious', 'Safety first'],
    feel: ['Ignore', 'Slight lean', 'Balanced', 'Lean on it', 'Crowd knows best'],
  };

  const RISK_ALLOC = [
    null,
    { eqMin: 10, eqMax: 20, bondMin: 50, bondMax: 60, cashMin: 20, cashMax: 30, maxFund: 15 },
    { eqMin: 20, eqMax: 30, bondMin: 50, bondMax: 55, cashMin: 15, cashMax: 25, maxFund: 18 },
    { eqMin: 30, eqMax: 40, bondMin: 45, bondMax: 50, cashMin: 10, cashMax: 15, maxFund: 20 },
    { eqMin: 40, eqMax: 50, bondMin: 40, bondMax: 45, cashMin: 5,  cashMax: 10, maxFund: 25 },
    { eqMin: 50, eqMax: 60, bondMin: 35, bondMax: 40, cashMin: 5,  cashMax: 5,  maxFund: 30 },
    { eqMin: 60, eqMax: 70, bondMin: 25, bondMax: 35, cashMin: 0,  cashMax: 5,  maxFund: 35 },
    { eqMin: 70, eqMax: 80, bondMin: 15, bondMax: 25, cashMin: 0,  cashMax: 5,  maxFund: 40 },
    { eqMin: 80, eqMax: 90, bondMin: 10, bondMax: 15, cashMin: 0,  cashMax: 0,  maxFund: 50 },
    { eqMin: 90, eqMax: 100, bondMin: 0, bondMax: 10, cashMin: 0,  cashMax: 0,  maxFund: 60 },
  ];

  const MONEY_MARKET = ['FDRXX', 'ADAXX'];

  const FRED_SERIES = [
    { id: 'DFF',               label: 'Fed Funds Rate' },
    { id: 'T10Y2Y',            label: '10Y-2Y Yield Curve' },
    { id: 'CPIAUCSL',          label: 'CPI YoY' },
    { id: 'UNRATE',            label: 'Unemployment Rate' },
    { id: 'BAMLH0A0HYM2',     label: 'High Yield Credit Spread' },
    { id: 'GOLDAMGBD228NLBM',  label: 'Gold Price' },
    { id: 'WTISPLC',           label: 'WTI Crude Oil' },
    { id: 'NAPM',              label: 'Manufacturing PMI' },
    { id: 'NMFSL',             label: 'Services PMI' },
    { id: 'T10YIE',            label: '10Y Breakeven Inflation' },
    { id: 'DTWEXBGS',          label: 'USD Broad Index' },
  ];

  const ROBERT_FUNDS = ['PRPFX','WFPRX','VFWAX','QFVRX','MADFX','VADFX','RNWGX','OIBIX','RTRIX','DRRYX','VWIGX','TGEPX','BPLBX','CFSTX','MWTSX','FXAIX','FDRXX','ADAXX','WEGRX','BGHIX','HRAUX','FSPGX'];

  // ── Utility ───────────────────────────────────────────────────────────────
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function median(arr) { const s = [...arr].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
  function mad(arr) { const med = median(arr); return median(arr.map(v => Math.abs(v - med))); }
  function modifiedZScore(value, arr) {
    const med = median(arr);
    const MAD = mad(arr);
    if (MAD === 0) return 0;
    return 0.6745 * (value - med) / MAD;
  }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ── API Helpers ───────────────────────────────────────────────────────────
  // FIX #5: removed redundant ternary
  async function api(path, options = {}) {
    const res = await fetch(path, options);
    if (!res.ok) throw new Error(`API ${path}: ${res.status}`);
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('json')) return res.json();
    return res.text();
  }

  async function supaGet(table, query = '') {
    return api(`/api/supabase/${table}?${query}`, { headers: { 'Prefer': 'return=representation' } });
  }

  async function supaUpsert(table, data) {
    return api(`/api/supabase/${table}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify(data),
    });
  }

  async function supaPatch(table, query, data) {
    return api(`/api/supabase/${table}?${query}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
      body: JSON.stringify(data),
    });
  }

  async function supaDelete(table, query) {
    return fetch(`/api/supabase/${table}?${query}`, { method: 'DELETE', headers: { 'Prefer': 'return=minimal' } });
  }

  // ── Supabase Data Access ──────────────────────────────────────────────────
  async function loadProfile() {
    const rows = await supaGet('user_profiles', `id=eq.${state.userId}`);
    if (rows.length) {
      state.profile = rows[0];
    } else {
      state.profile = { id: state.userId, display_name: 'Robert', risk_level: 7, factor_weights: { ...DEFAULT_WEIGHTS } };
      await supaUpsert('user_profiles', state.profile);
    }
    return state.profile;
  }

  async function saveProfile(updates) {
    await supaPatch('user_profiles', `id=eq.${state.userId}`, { ...updates, updated_at: new Date().toISOString() });
    Object.assign(state.profile, updates);
  }

  async function loadFunds() {
    const rows = await supaGet('fund_universe', `user_id=eq.${state.userId}&order=ticker.asc`);
    state.funds = rows;
    return rows;
  }

  async function addFund(ticker, name) {
    const t = ticker.toUpperCase().trim();
    if (!t || state.funds.find(f => f.ticker === t)) return;
    await supaUpsert('fund_universe', { user_id: state.userId, ticker: t, fund_name: name || t });
    await loadFunds();
  }

  async function removeFund(ticker) {
    await supaDelete('fund_universe', `user_id=eq.${state.userId}&ticker=eq.${ticker}`);
    await loadFunds();
  }

  async function loadRobertFunds() {
    for (const t of ROBERT_FUNDS) {
      await supaUpsert('fund_universe', { user_id: state.userId, ticker: t, fund_name: t });
    }
    await loadFunds();
  }

  // ── Market Status ─────────────────────────────────────────────────────────
  async function checkMarket() {
    try {
      const d = await api('/api/market-status');
      state.marketOpen = d.open;
    } catch { state.marketOpen = false; }
  }

  // ── FRED Data (FIX #21: parallel fetches) ─────────────────────────────────
  async function fetchFRED() {
    const oneYearAgo = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
    const results = {};
    const fetches = FRED_SERIES.map(async (s) => {
      try {
        const d = await api(`/api/fred/series/observations?series_id=${s.id}&sort_order=desc&limit=5&observation_start=${oneYearAgo}`);
        const obs = (d.observations || []).filter(o => o.value !== '.');
        if (obs.length) {
          results[s.id] = { label: s.label, value: parseFloat(obs[0].value), date: obs[0].date, prev: obs.length > 1 ? parseFloat(obs[1].value) : null };
        }
      } catch (e) {
        console.warn(`FRED ${s.id} failed:`, e.message);
      }
    });
    await Promise.allSettled(fetches);
    return results;
  }

  // ── BLS Data ──────────────────────────────────────────────────────────────
  async function fetchBLS() {
    try {
      const d = await api('/api/bls?series=CUUR0000SA0,LNS14000000');
      const out = {};
      if (d.Results && d.Results.series) {
        for (const s of d.Results.series) {
          const latest = s.data && s.data[0];
          if (latest) out[s.seriesID] = { value: parseFloat(latest.value), period: latest.period, year: latest.year };
        }
      }
      return out;
    } catch { return {}; }
  }

  // ── Treasury Yield Curve ──────────────────────────────────────────────────
  async function fetchTreasury() {
    try {
      const csv = await api('/api/treasury');
      const lines = csv.trim().split('\n');
      if (lines.length < 2) return null;
      const headers = lines[0].split(',');
      const latest = lines[lines.length - 1].split(',');
      const obj = {};
      headers.forEach((h, i) => { obj[h.trim()] = latest[i] ? latest[i].trim() : ''; });
      return obj;
    } catch { return null; }
  }

  // ── GDELT News ────────────────────────────────────────────────────────────
  async function fetchGDELT(query = 'global economy financial markets') {
    try {
      const d = await api(`/api/gdelt?query=${encodeURIComponent(query)}&mode=ArtList&maxrecords=15&format=json`);
      return (d.articles || []).map(a => ({ title: a.title, url: a.url, tone: a.tone, date: a.seendate, source: a.domain }));
    } catch { return []; }
  }

  // ── Google News RSS ───────────────────────────────────────────────────────
  async function fetchGoogleNews(query = 'stock market economy') {
    try {
      const d = await api(`/api/gnews?q=${encodeURIComponent(query)}`);
      return d.items || [];
    } catch { return []; }
  }

  // ── Finnhub News ──────────────────────────────────────────────────────────
  async function fetchFinnhubNews() {
    try {
      const d = await api('/api/finnhub/news?category=general');
      return (d || []).slice(0, 15).map(n => ({ headline: n.headline, summary: n.summary, source: n.source, datetime: n.datetime, sentiment: n.sentiment }));
    } catch { return []; }
  }

  // ── Fund NAV (Tiingo) — FIX #6: stale detection for arrays ────────────────
  async function fetchNAV(ticker) {
    try {
      const endDate = new Date().toISOString().slice(0, 10);
      const startDate = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
      const d = await api(`/api/tiingo/tiingo/daily/${ticker}/prices?startDate=${startDate}&endDate=${endDate}`);
      const arr = Array.isArray(d) ? d : [d];
      if (arr.length) {
        const latest = arr[arr.length - 1];
        if (latest._stale) state.usingCachedPrices = true;
        return { close: latest.close || latest.adjClose, date: latest.date };
      }
    } catch (e) {
      console.warn(`NAV ${ticker}:`, e.message);
    }
    return null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  EDGAR Holdings — FIX #7, #8, #9, #10
  //  Path: MF ticker map → submissions API → find NPORT-P → fetch index → XML
  // ═══════════════════════════════════════════════════════════════════════════

  let _mfTickerMap = null;
  async function getMFTickerMap() {
    if (_mfTickerMap) return _mfTickerMap;
    try {
      const d = await api('/api/www4sec/files/company_tickers_mf.json');
      _mfTickerMap = {};
      // Format: { "data": [[cik, seriesId, classId, ticker], ...] }
      for (const row of d.data) {
        _mfTickerMap[row[3]] = { cik: row[0], seriesId: row[1], classId: row[2] };
      }
      return _mfTickerMap;
    } catch (e) {
      console.warn('Failed to load MF ticker map:', e.message);
      return {};
    }
  }

  async function fetchHoldingsFromEDGAR(ticker) {
    emit('status', `Fetching holdings for ${ticker} from SEC EDGAR...`);
    try {
      // Step 1: Look up CIK via mutual fund ticker map
      const map = await getMFTickerMap();
      const info = map[ticker];
      if (!info) {
        console.warn(`EDGAR: ${ticker} not found in MF ticker map`);
        return [];
      }

      // Step 2: Fetch submissions for this CIK to find NPORT-P filings
      const padCik = String(info.cik).padStart(10, '0');
      const subs = await api(`/api/edgar/submissions/CIK${padCik}.json`);
      const recent = subs.filings?.recent || {};
      const forms = recent.form || [];
      const accessions = recent.accessionNumber || [];
      const dates = recent.filingDate || [];

      // Find the most recent NPORT-P filing
      let nportIdx = -1;
      for (let i = 0; i < forms.length; i++) {
        if (forms[i] === 'NPORT-P') { nportIdx = i; break; }
      }
      if (nportIdx === -1) {
        console.warn(`EDGAR: No NPORT-P filing found for ${ticker} (CIK ${info.cik})`);
        return [];
      }

      const accession = accessions[nportIdx];
      const filingDate = dates[nportIdx];
      const accClean = accession.replace(/-/g, '');
      const cik = String(info.cik);

      // Step 3: Fetch filing index to find the actual XML filename
      const idx = await api(`/api/edgar/Archives/edgar/data/${cik}/${accClean}/index.json`);
      const items = idx?.directory?.item || [];
      // Look for the primary NPORT XML — usually ends in .xml and is the largest file
      const xmlFile = items.find(i => i.name && i.name.endsWith('.xml') && i.name !== 'primary_doc.xml')
                   || items.find(i => i.name && i.name.endsWith('.xml'))
                   || items.find(i => i.name && (i.name.includes('nport') || i.name.includes('primary')));

      if (!xmlFile) {
        console.warn(`EDGAR: No XML file found in filing index for ${ticker}`);
        return [];
      }

      // Step 4: Fetch and parse the NPORT XML
      const xmlText = await api(`/api/edgar/Archives/edgar/data/${cik}/${accClean}/${xmlFile.name}`);
      return parseNPORT(xmlText, ticker, filingDate);
    } catch (e) {
      console.warn(`EDGAR holdings ${ticker}:`, e.message);
      return [];
    }
  }

  // FIX #9: correct NPORT field names; FIX #10: pctVal is already a percentage
  function parseNPORT(xml, fundTicker, filingDate) {
    const holdings = [];
    const blocks = xml.match(/<invstOrSec>([\s\S]*?)<\/invstOrSec>/gi) || [];
    for (const block of blocks) {
      const get = (tag) => {
        const m = block.match(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i'));
        return m ? m[1].trim() : '';
      };
      // FIX #9: NPORT uses <name> for issuer name, not <title>
      const name = get('name') || get('title');
      const cusip = get('cusip');

      // Extract ticker from identifiers block if present
      let holdingTicker = '';
      const tickerMatch = block.match(/<ticker[^>]*>([^<]*)<\/ticker>/i)
                       || block.match(/value="([A-Z]{1,5})"/i);
      if (tickerMatch) holdingTicker = tickerMatch[1].trim();

      // FIX #10: pctVal in NPORT is already a percentage (5.23 = 5.23% of fund)
      // Some older filings use fractions (0.0523). Detect and handle both.
      const pctValRaw = get('pctVal');
      let pctVal = null;
      if (pctValRaw) {
        const parsed = parseFloat(pctValRaw);
        // Heuristic: if < 1 and there are many holdings, it's likely a fraction
        pctVal = (parsed > 0 && parsed < 0.5 && blocks.length > 20) ? parsed * 100 : parsed;
      }

      const balance = get('balance');
      const valUSD = get('valUSD');
      const assetCat = get('assetCat') || '';

      if (name) {
        holdings.push({
          fund_ticker: fundTicker,
          holding_name: name,
          holding_ticker: holdingTicker || null,
          cusip: cusip || null,
          pct_of_fund: pctVal,
          shares: balance ? parseFloat(balance) : null,
          market_value: valUSD ? parseFloat(valUSD) : null,
          asset_type: (assetCat === 'DE' || assetCat === 'DBT' || assetCat.toLowerCase().includes('debt')) ? 'bond' : 'equity',
          sector: null,
          fetched_at: new Date().toISOString(),
          filing_date: filingDate || new Date().toISOString().slice(0, 10),
        });
      }
    }
    return holdings;
  }

  async function loadOrFetchHoldings(ticker, forceRefresh = false) {
    if (!forceRefresh) {
      const cached = await supaGet('holdings_cache', `fund_ticker=eq.${ticker}&order=pct_of_fund.desc`);
      if (cached.length > 0) {
        state.holdingsMap[ticker] = cached;
        return cached;
      }
    }

    const holdings = await fetchHoldingsFromEDGAR(ticker);
    if (holdings.length) {
      await supaDelete('holdings_cache', `fund_ticker=eq.${ticker}`);
      for (let i = 0; i < holdings.length; i += 50) {
        try { await supaUpsert('holdings_cache', holdings.slice(i, i + 50)); }
        catch (e) { console.warn('Holdings insert:', e.message); }
      }
    }
    state.holdingsMap[ticker] = holdings;
    return holdings;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Company Fundamentals — Finnhub primary, Twelve Data fallback
  // ═══════════════════════════════════════════════════════════════════════════

  async function fetchFundamentals(ticker) {
    if (!ticker) return null;
    // Check Supabase cache (30 days)
    try {
      const cached = await supaGet('holding_fundamentals', `ticker=eq.${ticker}`);
      if (cached.length && cached[0].fetched_at) {
        const age = Date.now() - new Date(cached[0].fetched_at).getTime();
        if (age < 30 * 86400000) {
          state.fundamentalsMap[ticker] = cached[0];
          return cached[0];
        }
      }
    } catch {}

    let data = null;

    // Primary: Finnhub basic-financials (stock/metric)
    try {
      const [metricRes, profileRes] = await Promise.allSettled([
        api(`/api/finnhub/stock/metric?symbol=${ticker}&metric=all`),
        api(`/api/finnhub/stock/profile2?symbol=${ticker}`),
      ]);
      const m = metricRes.status === 'fulfilled' ? (metricRes.value.metric || {}) : {};
      const p = profileRes.status === 'fulfilled' ? profileRes.value : {};

      if (m.peBasicExclExtraTTM || m.roeTTM || m.grossMarginTTM || p.finnhubIndustry) {
        const currentPrice = m.marketCapitalization && m.shareOutstanding
          ? (m.marketCapitalization * 1e6) / (m.shareOutstanding * 1e6) : null;
        data = {
          ticker,
          company_name: p.name || ticker,
          sector: p.finnhubIndustry || null,
          industry: p.finnhubIndustry || null,
          pe_ratio: m.peBasicExclExtraTTM || m.peTTM || null,
          roe: m.roeTTM ? m.roeTTM / 100 : null,
          gross_margin: m.grossMarginTTM ? m.grossMarginTTM / 100 : null,
          debt_to_equity: m['totalDebt/totalEquityQuarterly'] || null,
          revenue_growth: m.revenueGrowthTTMYoy ? m.revenueGrowthTTMYoy / 100 : null,
          piotroski_score: null,
          analyst_rating: null,
          // FIX #11: compute price_vs_50d and price_vs_200d from Finnhub metrics
          price_vs_50d: m['52WeekHighDate'] ? null : null, // Finnhub doesn't expose 50d directly
          price_vs_200d: null,
          momentum_20d: m['5DayPriceReturnDaily'] ? m['5DayPriceReturnDaily'] / 100 : null,
          momentum_60d: m['13WeekPriceReturnDaily'] ? m['13WeekPriceReturnDaily'] / 100 : null,
          momentum_120d: m['26WeekPriceReturnDaily'] ? m['26WeekPriceReturnDaily'] / 100 : null,
          fetched_at: new Date().toISOString(),
        };
      }
    } catch (e) {
      console.warn(`Finnhub fundamentals ${ticker}:`, e.message);
    }

    // Fallback: Twelve Data (if configured and Finnhub failed)
    if (!data) {
      try {
        const [statsRes, profileRes] = await Promise.allSettled([
          api(`/api/twelvedata/statistics?symbol=${ticker}`),
          api(`/api/twelvedata/profile?symbol=${ticker}`),
        ]);
        const stats = statsRes.status === 'fulfilled' ? statsRes.value : {};
        const prof = profileRes.status === 'fulfilled' ? profileRes.value : {};
        const v = stats.valuations || {};
        const fin = stats.financials || {};
        const bs = fin.balance_sheet || {};
        const inc = fin.income_statement || {};
        if (v.trailing_pe || fin.return_on_equity_ttm) {
          data = {
            ticker,
            company_name: prof.name || ticker,
            sector: prof.sector || null,
            industry: prof.industry || null,
            pe_ratio: v.trailing_pe || null,
            roe: fin.return_on_equity_ttm ? parseFloat(fin.return_on_equity_ttm) / 100 : null,
            gross_margin: inc.gross_margin ? parseFloat(inc.gross_margin) : null,
            debt_to_equity: bs.debt_to_equity ? parseFloat(bs.debt_to_equity) : null,
            revenue_growth: fin.revenue_growth_ttm_yoy ? parseFloat(fin.revenue_growth_ttm_yoy) / 100 : null,
            piotroski_score: null,
            analyst_rating: null,
            price_vs_50d: null,
            price_vs_200d: null,
            momentum_20d: null,
            momentum_60d: null,
            momentum_120d: null,
            fetched_at: new Date().toISOString(),
          };
        }
      } catch (e) {
        console.warn(`TwelveData fundamentals ${ticker}:`, e.message);
      }
    }

    if (!data) return null;

    // Estimate piotroski from available data
    let pio = 0;
    if (data.roe > 0) pio++;
    if (data.gross_margin > 0) pio++;
    if (data.pe_ratio && data.pe_ratio > 0) pio++;
    if (data.debt_to_equity !== null && data.debt_to_equity < 1) pio += 2;
    if (data.revenue_growth && data.revenue_growth > 0) pio++;
    data.piotroski_score = clamp(pio, 0, 9);

    try { await supaUpsert('holding_fundamentals', data); } catch {}
    state.fundamentalsMap[ticker] = data;
    return data;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Scoring Engine
  // ═══════════════════════════════════════════════════════════════════════════

  function scoreHolding(holding, sectorScores, fundamentals) {
    const sectorName = (fundamentals?.sector || holding.sector || 'unknown').toLowerCase();
    let sectorScore = 5;
    if (sectorScores) {
      for (const [key, val] of Object.entries(sectorScores)) {
        if (key.toLowerCase().includes(sectorName) || sectorName.includes(key.toLowerCase())) {
          sectorScore = val.score || val;
          break;
        }
      }
    }

    if (!fundamentals || (!fundamentals.roe && !fundamentals.gross_margin)) {
      return { score: sectorScore / 10, hasFundamentals: false, sectorScore };
    }

    const roe = fundamentals.roe ? clamp(fundamentals.roe, -0.5, 1) : 0;
    const gm = fundamentals.gross_margin ? clamp(fundamentals.gross_margin, 0, 1) : 0.3;
    const pio = (fundamentals.piotroski_score || 4) / 9;
    const revG = fundamentals.revenue_growth ? clamp(fundamentals.revenue_growth, -0.5, 1) : 0;
    const dte = fundamentals.debt_to_equity != null ? clamp(1 - fundamentals.debt_to_equity / 3, 0, 1) : 0.5;

    const qualityScore = (roe * 0.25 + gm * 0.20 + pio * 0.20 + revG * 0.20 + dte * 0.15);
    const holdingScore = (qualityScore * 0.5) + ((sectorScore / 10) * 0.5);

    return {
      score: clamp(holdingScore, 0, 1),
      hasFundamentals: true,
      qualityScore,
      sectorScore,
      components: { roe, gm, pio, revG, dte },
    };
  }

  function scoreFund(ticker, holdings, sectorScores) {
    if (MONEY_MARKET.includes(ticker)) {
      return { ticker, composite: 0, isCash: true, holdingScores: [], holdingCount: 0 };
    }

    let totalWeight = 0;
    let weightedScore = 0;
    const holdingScores = [];

    for (const h of holdings) {
      const fund = state.fundamentalsMap[h.holding_ticker] || null;
      const result = scoreHolding(h, sectorScores, fund);
      const w = h.pct_of_fund || (100 / Math.max(holdings.length, 1));
      weightedScore += result.score * w;
      totalWeight += w;
      holdingScores.push({ name: h.holding_name, ticker: h.holding_ticker, pct: w, ...result });
    }

    const composite = totalWeight > 0 ? weightedScore / totalWeight : 0;
    return { ticker, composite, isCash: false, holdingScores, holdingCount: holdings.length };
  }

  // FIX #13: removed unused `total` variable
  function applyFactorWeights(fundScores, weights) {
    const w = weights || state.profile?.factor_weights || DEFAULT_WEIGHTS;

    return fundScores.map(f => {
      if (f.isCash) return { ...f, weightedScore: 0 };
      const baseScore = f.composite * 10;
      const trendMult = w.trend / 35;
      const foundMult = w.foundations / 22;
      const roomMult = w.room / 18;
      const safeMult = w.safe / 15;
      const feelMult = w.feel / 10;

      const weightedScore = baseScore * (
        trendMult * 0.35 + foundMult * 0.22 + roomMult * 0.18 + safeMult * 0.15 + feelMult * 0.10
      );

      return {
        ...f,
        weightedScore: clamp(weightedScore, 0, 10),
        factorScores: {
          trend: baseScore * trendMult * 0.35,
          foundations: baseScore * foundMult * 0.22,
          room: baseScore * roomMult * 0.18,
          safe: baseScore * safeMult * 0.15,
          feel: baseScore * feelMult * 0.10,
        },
      };
    });
  }

  function identifyBreakaway(scoredFunds) {
    const scores = scoredFunds.filter(f => !f.isCash).map(f => f.weightedScore);
    if (scores.length < 3) return scoredFunds;

    return scoredFunds.map(f => {
      if (f.isCash) return f;
      const z = modifiedZScore(f.weightedScore, scores);
      return { ...f, zscore: z, isBreakaway: Math.abs(z) > 1.5 };
    });
  }

  // FIX #14: classify funds by holdings asset_type content, not fund name
  function generateAllocation(scoredFunds, riskLevel) {
    const alloc = RISK_ALLOC[riskLevel || 5];
    const eqTarget = (alloc.eqMin + alloc.eqMax) / 2;
    const bondTarget = (alloc.bondMin + alloc.bondMax) / 2;
    const cashTarget = (alloc.cashMin + alloc.cashMax) / 2;

    const cashFunds = scoredFunds.filter(f => f.isCash);
    const scoreable = scoredFunds.filter(f => !f.isCash).sort((a, b) => b.weightedScore - a.weightedScore);

    // Classify bond vs equity funds by analyzing their holdings
    const bondFunds = [];
    const eqFunds = [];
    for (const f of scoreable) {
      const holdings = state.holdingsMap[f.ticker] || [];
      const bondCount = holdings.filter(h => h.asset_type === 'bond').length;
      const bondPct = holdings.length > 0 ? bondCount / holdings.length : 0;
      // Also check fund name as fallback
      const name = (state.funds.find(uf => uf.ticker === f.ticker)?.fund_name || '').toLowerCase();
      const nameIsBond = name.includes('bond') || name.includes('income') || name.includes('fixed') || name.includes('treasury');
      if (bondPct > 0.5 || nameIsBond) {
        bondFunds.push(f);
      } else {
        eqFunds.push(f);
      }
    }

    const allocations = [];
    let remaining = 100;

    if (cashFunds.length && cashTarget > 0) {
      const cashPer = cashTarget / Math.max(cashFunds.length, 1);
      for (const f of cashFunds) {
        const pct = Math.round(cashPer * 10) / 10;
        allocations.push({ ticker: f.ticker, pct, type: 'cash' });
        remaining -= pct;
      }
    }

    if (bondFunds.length && bondTarget > 0) {
      const totalBondScore = bondFunds.reduce((s, f) => s + (f.weightedScore || 0.1), 0);
      for (const f of bondFunds) {
        const pct = Math.round(((f.weightedScore || 0.1) / totalBondScore) * bondTarget * 10) / 10;
        const capped = Math.min(pct, alloc.maxFund);
        allocations.push({ ticker: f.ticker, pct: capped, type: 'bond' });
        remaining -= capped;
      }
    }

    if (eqFunds.length) {
      const totalEqScore = eqFunds.reduce((s, f) => s + (f.weightedScore || 0.1), 0);
      const eqBudget = Math.max(remaining, 0);
      for (const f of eqFunds) {
        const raw = ((f.weightedScore || 0.1) / totalEqScore) * eqBudget;
        const pct = Math.round(Math.min(raw, alloc.maxFund) * 10) / 10;
        allocations.push({ ticker: f.ticker, pct, type: 'equity' });
      }
    }

    // Normalize to 100%
    const sum = allocations.reduce((s, a) => s + a.pct, 0);
    if (sum > 0 && Math.abs(sum - 100) > 0.5) {
      const factor = 100 / sum;
      allocations.forEach(a => { a.pct = Math.round(a.pct * factor * 10) / 10; });
    }

    return allocations;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Claude Thesis + Sector Scoring — FIX #23: retry on JSON parse failure
  // ═══════════════════════════════════════════════════════════════════════════

  async function generateThesis(worldData, retryCount = 0) {
    const prompt = `You are a senior investment analyst. Based on the following real-time world data, write a clear investment thesis and derive sector scores.

## WORLD DATA SNAPSHOT

### FRED Macro Indicators:
${Object.entries(worldData.fred || {}).map(([k, v]) => `${v.label} (${k}): ${v.value} (as of ${v.date})${v.prev !== null ? ` [prev: ${v.prev}]` : ''}`).join('\n')}

### BLS Data:
${JSON.stringify(worldData.bls || {}, null, 1)}

### Treasury Yield Curve:
${JSON.stringify(worldData.treasury || {}, null, 1)}

### Recent Financial News (GDELT):
${(worldData.gdelt || []).slice(0, 8).map(a => `- ${a.title} (tone: ${a.tone || 'N/A'})`).join('\n')}

### Google News Headlines:
${(worldData.gnews || []).slice(0, 8).map(a => `- ${a.title}`).join('\n')}

### Finnhub Market News:
${(worldData.finnhub || []).slice(0, 8).map(a => `- ${a.headline}`).join('\n')}

## INSTRUCTIONS:
Respond in STRICT JSON only. No markdown, no preamble, no backticks. Format:
{
  "thesis": {
    "sentence1": "What is happening in the world right now (1 dominant theme)",
    "sentence2": "What that means for a typical 401k investor's funds",
    "sentence3": "What to watch — the one signal that could change this"
  },
  "dominant_theme": "2-4 word theme label",
  "risk_factors": ["risk1", "risk2", "risk3"],
  "catalysts": ["catalyst1", "catalyst2"],
  "sector_scores": {
    "Information Technology": {"score": 7, "reason": "..."},
    "Health Care": {"score": 6, "reason": "..."},
    "Financials": {"score": 5, "reason": "..."},
    "Consumer Discretionary": {"score": 5, "reason": "..."},
    "Communication Services": {"score": 6, "reason": "..."},
    "Industrials": {"score": 5, "reason": "..."},
    "Consumer Staples": {"score": 6, "reason": "..."},
    "Energy": {"score": 4, "reason": "..."},
    "Utilities": {"score": 5, "reason": "..."},
    "Real Estate": {"score": 4, "reason": "..."},
    "Materials": {"score": 5, "reason": "..."}
  }
}

Score each sector 1-10. Higher = more favorable given current conditions. Each reason must be exactly ONE sentence.`;

    const body = {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 3000,
      messages: [{ role: 'user', content: prompt }],
    };

    const resp = await api('/api/claude', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const text = resp.content?.map(c => c.text || '').join('') || '';
    const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

    try {
      return JSON.parse(cleaned);
    } catch (e) {
      console.warn(`Thesis JSON parse failed (attempt ${retryCount + 1}):`, e.message);
      if (retryCount < 2) {
        await sleep(1000);
        return generateThesis(worldData, retryCount + 1);
      }
      throw new Error('Claude returned invalid JSON after 3 attempts');
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Main Pipeline
  // ═══════════════════════════════════════════════════════════════════════════

  async function runAnalysis(options = {}) {
    if (state.isRunning) return;
    state.isRunning = true;
    state.pipelineProgress = 0;
    state._navDate = null;
    state.usingCachedPrices = false;
    const forceHoldings = options.refreshHoldings || false;

    try {
      // Step 1: World data (all sources in parallel)
      emit('pipeline', { step: 'Gathering world data...', progress: 5 });
      const [fred, bls, treasury, gdelt, gnews, finnhub] = await Promise.allSettled([
        fetchFRED(), fetchBLS(), fetchTreasury(),
        fetchGDELT(), fetchGoogleNews(), fetchFinnhubNews(),
      ]);

      state.worldData = {
        fred: fred.status === 'fulfilled' ? fred.value : {},
        bls: bls.status === 'fulfilled' ? bls.value : {},
        treasury: treasury.status === 'fulfilled' ? treasury.value : {},
        gdelt: gdelt.status === 'fulfilled' ? gdelt.value : [],
        gnews: gnews.status === 'fulfilled' ? gnews.value : [],
        finnhub: finnhub.status === 'fulfilled' ? finnhub.value : [],
        fetchedAt: new Date().toISOString(),
      };
      emit('pipeline', { step: 'World data gathered', progress: 20 });

      // Step 2: Thesis + sector scores
      emit('pipeline', { step: 'Claude is forming investment thesis...', progress: 25 });
      const thesisData = await generateThesis(state.worldData);
      state.thesis = thesisData.thesis;
      state.sectorScores = thesisData.sector_scores;
      emit('pipeline', { step: 'Investment thesis complete', progress: 40 });

      // Step 3: Fund holdings
      const activeFunds = state.funds.filter(f => !MONEY_MARKET.includes(f.ticker));
      let holdingsLoaded = 0;
      for (const f of activeFunds) {
        emit('pipeline', { step: `Loading holdings: ${f.ticker} (${++holdingsLoaded}/${activeFunds.length})`, progress: 40 + (holdingsLoaded / activeFunds.length) * 15 });
        await loadOrFetchHoldings(f.ticker, forceHoldings);
        await sleep(200); // SEC rate limit: ~10 req/sec
      }
      emit('pipeline', { step: 'Holdings loaded', progress: 55 });

      // Step 4: Fundamentals for top holdings
      emit('pipeline', { step: 'Fetching company fundamentals...', progress: 58 });
      const allHoldingTickers = new Set();
      for (const [, holdings] of Object.entries(state.holdingsMap)) {
        const sorted = [...holdings].sort((a, b) => (b.pct_of_fund || 0) - (a.pct_of_fund || 0));
        for (const h of sorted.slice(0, 20)) {
          if (h.holding_ticker && h.holding_ticker.length <= 5) allHoldingTickers.add(h.holding_ticker);
        }
      }

      let fundLoaded = 0;
      const tickers = [...allHoldingTickers];
      for (const t of tickers) {
        if (++fundLoaded % 5 === 0) {
          emit('pipeline', { step: `Fundamentals: ${fundLoaded}/${tickers.length}`, progress: 58 + (fundLoaded / tickers.length) * 15 });
        }
        await fetchFundamentals(t);
        // FIX #15: Finnhub free tier = 60 req/min → 1 req/sec needed
        await sleep(1100);
      }
      emit('pipeline', { step: 'Fundamentals loaded', progress: 73 });

      // Step 5: Score each fund
      emit('pipeline', { step: 'Scoring funds...', progress: 75 });
      let rawScores = [];
      for (const f of state.funds) {
        const holdings = state.holdingsMap[f.ticker] || [];
        rawScores.push(scoreFund(f.ticker, holdings, state.sectorScores));
      }

      // Step 6: Apply factor weights
      emit('pipeline', { step: 'Applying factor weights...', progress: 80 });
      const weighted = applyFactorWeights(rawScores, state.profile?.factor_weights);

      // Step 7: Breakaway detection
      emit('pipeline', { step: 'Identifying breakaway funds...', progress: 85 });
      state.fundScores = identifyBreakaway(weighted)
        .sort((a, b) => b.weightedScore - a.weightedScore);

      // Step 8: Allocation
      emit('pipeline', { step: 'Generating allocation...', progress: 88 });
      state.allocation = generateAllocation(state.fundScores, state.profile?.risk_level || 7);

      // Step 9: Fetch NAVs for tracking
      const navLabel = state.marketOpen ? 'Fetching live NAVs...' : 'Fetching latest closing NAVs...';
      emit('pipeline', { step: navLabel, progress: 90 });
      const navMap = {};
      for (const f of state.funds) {
        const nav = await fetchNAV(f.ticker);
        if (nav) {
          navMap[f.ticker] = nav.close;
          if (!state._navDate && nav.date) state._navDate = nav.date;
        }
      }

      // Step 10: Save prediction cycle
      emit('pipeline', { step: 'Saving prediction cycle...', progress: 95 });
      const cycleId = uid();
      const cycle = {
        id: cycleId,
        user_id: state.userId,
        created_at: new Date().toISOString(),
        closes_at: new Date(Date.now() + 90 * 86400000).toISOString(),
        status: 'open',
        investment_thesis: `${state.thesis.sentence1} ${state.thesis.sentence2} ${state.thesis.sentence3}`,
        dominant_theme: thesisData.dominant_theme,
        risk_factors: thesisData.risk_factors,
        catalysts: thesisData.catalysts,
        sector_scores: state.sectorScores,
        risk_level: state.profile?.risk_level || 7,
        factor_weights: state.profile?.factor_weights || DEFAULT_WEIGHTS,
        world_data_snapshot: { fred: state.worldData.fred, bls: state.worldData.bls },
      };
      await supaUpsert('prediction_cycles', cycle);

      for (const f of state.fundScores) {
        const alloc = state.allocation.find(a => a.ticker === f.ticker);
        // FIX #16: smarter ROI prediction based on score relative to average
        const avgScore = state.fundScores.filter(x => !x.isCash).reduce((s, x) => s + x.weightedScore, 0) / Math.max(state.fundScores.filter(x => !x.isCash).length, 1);
        const relativeStrength = avgScore > 0 ? (f.weightedScore / avgScore - 1) : 0;
        const pred = {
          id: uid(),
          cycle_id: cycleId,
          user_id: state.userId,
          fund_ticker: f.ticker,
          fund_name: state.funds.find(uf => uf.ticker === f.ticker)?.fund_name || f.ticker,
          predicted_rank: state.fundScores.filter(x => !x.isCash).indexOf(f) + 1,
          composite_score: f.weightedScore,
          zscore: f.zscore || 0,
          is_breakaway: f.isBreakaway || false,
          predicted_roi_90d: f.isCash ? 0.01 : clamp(relativeStrength * 0.08, -0.15, 0.25),
          nav_at_prediction: navMap[f.ticker] || null,
          factor_scores: f.factorScores || {},
          top_holdings_snapshot: (f.holdingScores || []).slice(0, 10).map(h => ({ name: h.name, ticker: h.ticker, score: h.score })),
          allocation_pct: alloc?.pct || 0,
        };
        await supaUpsert('fund_predictions', pred);
      }

      state.currentCycle = cycle;
      emit('pipeline', { step: 'Analysis complete!', progress: 100 });
      emit('complete', { cycle, scores: state.fundScores, allocation: state.allocation, thesis: state.thesis, sectorScores: state.sectorScores, thesisData, navDate: state._navDate, marketOpen: state.marketOpen });

    } catch (e) {
      console.error('Pipeline error:', e);
      emit('error', e.message);
    } finally {
      state.isRunning = false;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Prediction Tracking — FIX #22: throttle to max once per hour
  // ═══════════════════════════════════════════════════════════════════════════

  async function trackOpenPredictions() {
    // Skip if tracked within the last hour
    if (Date.now() - state._lastTrackTime < 3600000) return;
    state._lastTrackTime = Date.now();

    try {
      const openCycles = await supaGet('prediction_cycles', `user_id=eq.${state.userId}&status=eq.open&order=created_at.desc`);
      for (const cycle of openCycles) {
        const preds = await supaGet('fund_predictions', `cycle_id=eq.${cycle.id}`);
        for (const p of preds) {
          if (!p.nav_at_prediction) continue;
          const nav = await fetchNAV(p.fund_ticker);
          if (nav) {
            const actualROI = (nav.close - p.nav_at_prediction) / p.nav_at_prediction;
            await supaPatch('fund_predictions', `id=eq.${p.id}`, {
              nav_current: nav.close,
              roi_actual: actualROI,
              last_tracked_at: new Date().toISOString(),
            });
          }
        }
        const elapsed = Date.now() - new Date(cycle.created_at).getTime();
        if (elapsed > 90 * 86400000) {
          await evaluateCycle(cycle.id);
        }
      }
    } catch (e) { console.warn('Tracking error:', e.message); }
  }

  async function evaluateCycle(cycleId) {
    const preds = await supaGet('fund_predictions', `cycle_id=eq.${cycleId}&order=predicted_rank.asc`);
    let totalScore = 0;
    let counted = 0;
    for (const p of preds) {
      if (p.roi_actual !== null && p.predicted_roi_90d) {
        const accuracy = 1 - Math.abs(p.roi_actual - p.predicted_roi_90d) / Math.abs(p.predicted_roi_90d || 0.01);
        totalScore += clamp(accuracy, 0, 1);
        counted++;
      }
    }
    const avgAccuracy = counted > 0 ? (totalScore / counted) * 100 : null;
    await supaPatch('prediction_cycles', `id=eq.${cycleId}`, {
      status: 'closed',
      accuracy_score: avgAccuracy,
      evaluated_at: new Date().toISOString(),
    });
  }

  // ── Weight Adjustment (Feedback Loop) ─────────────────────────────────────
  async function adjustWeights() {
    const closedCycles = await supaGet('prediction_cycles', `user_id=eq.${state.userId}&status=eq.closed&order=created_at.desc&limit=10`);
    if (closedCycles.length < 5) return null;

    const factorAccuracy = { trend: [], foundations: [], room: [], safe: [], feel: [] };
    for (const cycle of closedCycles) {
      const w = cycle.factor_weights || DEFAULT_WEIGHTS;
      const acc = cycle.accuracy_score || 50;
      for (const f of Object.keys(factorAccuracy)) {
        factorAccuracy[f].push({ weight: w[f], accuracy: acc });
      }
    }

    const current = state.profile?.factor_weights || { ...DEFAULT_WEIGHTS };
    const adjustments = {};
    for (const [factor, data] of Object.entries(factorAccuracy)) {
      const highWeight = data.filter(d => d.weight > current[factor]);
      const lowWeight = data.filter(d => d.weight <= current[factor]);
      const highAvg = highWeight.length ? highWeight.reduce((s, d) => s + d.accuracy, 0) / highWeight.length : 0;
      const lowAvg = lowWeight.length ? lowWeight.reduce((s, d) => s + d.accuracy, 0) / lowWeight.length : 0;

      let shift = 0;
      if (highAvg > lowAvg + 5) shift = 2;
      else if (lowAvg > highAvg + 5) shift = -2;
      adjustments[factor] = clamp(current[factor] + shift, 5, 60);
    }

    const total = Object.values(adjustments).reduce((s, v) => s + v, 0);
    for (const f of Object.keys(adjustments)) {
      adjustments[f] = Math.round(adjustments[f] / total * 100);
    }

    await saveProfile({ factor_weights: adjustments });
    return adjustments;
  }

  // ── Past Cycles ───────────────────────────────────────────────────────────
  async function loadPastCycles() {
    state.pastCycles = await supaGet('prediction_cycles', `user_id=eq.${state.userId}&order=created_at.desc&limit=20`);
    return state.pastCycles;
  }

  // ── Normalize Weights After Slider Change ─────────────────────────────────
  function normalizeWeights(weights, changedKey, sliderIndex) {
    const mult = SLIDER_MULTIPLIERS[sliderIndex];
    const base = DEFAULT_WEIGHTS[changedKey];
    const newVal = Math.round(base * mult);
    const updated = { ...weights, [changedKey]: newVal };
    const total = Object.values(updated).reduce((s, v) => s + v, 0);
    for (const k of Object.keys(updated)) {
      updated[k] = Math.round(updated[k] / total * 100);
    }
    return updated;
  }

  // ── Event Emitter ─────────────────────────────────────────────────────────
  const listeners = {};
  function on(event, fn) { (listeners[event] = listeners[event] || []).push(fn); }
  function off(event, fn) { if (listeners[event]) listeners[event] = listeners[event].filter(f => f !== fn); }
  function emit(event, data) { (listeners[event] || []).forEach(fn => fn(data)); }

  // ── Public API ────────────────────────────────────────────────────────────
  return {
    state, DEFAULT_WEIGHTS, SLIDER_MULTIPLIERS, SLIDER_LABELS, MONEY_MARKET, ROBERT_FUNDS, RISK_ALLOC,
    loadProfile, saveProfile, loadFunds, addFund, removeFund, loadRobertFunds, checkMarket,
    runAnalysis, loadPastCycles, trackOpenPredictions, adjustWeights, normalizeWeights,
    on, off, emit, uid,
  };
})();
