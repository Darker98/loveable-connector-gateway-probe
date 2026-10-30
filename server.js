'use strict';
// Fault-injection REST API for observing how Lovable's connector gateway
// behaves on 429 / 5xx / slow responses / vendor 4xx / missing credentials.
//
// Every request hitting /scenario/* is logged with a per-(scenario,key) attempt
// number, so retries by the gateway show up as attempt 2, 3, ... with exact
// arrival timestamps. Read the log via /_admin/log or `node report.js`.

const http = require('node:http');

const API_KEY = process.env.PROBE_API_KEY || 'lovable-test-key';
const ADMIN_TOKEN = process.env.PROBE_ADMIN_TOKEN || ''; // empty = admin open (local use only)
const MAX_LOG = 5000;

function createServer() {
  const log = [];
  const counters = new Map(); // "scenario|key" -> attempts seen
  let seq = 0;

  const redact = (v) => (v == null ? v : `${String(v).slice(0, 12)}… (len ${String(v).length})`);

  function safeHeaders(h) {
    const out = { ...h };
    for (const k of ['authorization', 'x-api-key', 'cookie', 'proxy-authorization']) {
      if (out[k] !== undefined) out[k] = redact(out[k]);
    }
    return out;
  }

  function send(res, status, body, headers = {}) {
    const payload = body === undefined ? '' : JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(payload);
  }

  function failCount(q) {
    const f = q.get('fail');
    if (f === 'all') return Infinity;
    const n = Number(f ?? 1);
    return Number.isFinite(n) ? n : 1;
  }

  function retryAfterHeader(q, defaultSeconds) {
    const v = q.get('retryAfter') ?? String(defaultSeconds);
    if (v === 'none') return {};
    if (v === 'date') return { 'retry-after': new Date(Date.now() + 2000).toUTCString() };
    return { 'retry-after': v };
  }

  // Each handler gets (req, res, ctx) and returns after responding (or deliberately not).
  function handle(req, res, url, ctx) {
    const parts = url.pathname.split('/').filter(Boolean); // ['scenario', name, ...]
    const name = parts[1];
    const q = url.searchParams;
    const base = { scenario: name, key: ctx.key, attempt: ctx.attempt, receivedAt: ctx.receivedAt };

    switch (name) {
      case 'ok':
        return send(res, 200, { ...base, ok: true });

      case 'echo':
        return send(res, 200, {
          ...base,
          method: req.method,
          query: Object.fromEntries(q),
          headers: safeHeaders(req.headers),
          body: ctx.body,
        });

      // 1. Rate limiting: first `fail` attempts get 429, then 200.
      //    ?retryAfter=<seconds>|date|none  ?fail=<n>|all
      case 'rate-limit': {
        if (ctx.attempt <= failCount(q)) {
          return send(
            res,
            429,
            { error: { code: 'VENDOR_RATE_LIMITED', message: 'Too many requests', attempt: ctx.attempt } },
            retryAfterHeader(q, 1),
          );
        }
        return send(res, 200, { ...base, ok: true, note: 'succeeded after rate limiting' });
      }

      // 2. Server errors: /scenario/5xx/<status>?fail=<n>|all  (optional ?retryAfter=)
      case '5xx': {
        const status = Number(parts[2] || 500);
        if (ctx.attempt <= failCount(q)) {
          const extra = q.has('retryAfter') ? retryAfterHeader(q, 1) : {};
          return send(res, status, { error: { code: `VENDOR_${status}`, message: 'Upstream failure', attempt: ctx.attempt } }, extra);
        }
        return send(res, 200, { ...base, ok: true, note: 'succeeded after server errors' });
      }

      // 3. Timeouts: /scenario/timeout?ms=<n> delays the reply; ms=hang never replies.
      //    The log records when the caller closed the connection (aborted + elapsedMs).
      case 'timeout': {
        const ms = q.get('ms');
        if (ms === 'hang') {
          ctx.timer = null; // never respond; the connection closing is the signal
          return;
        }
        ctx.timer = setTimeout(() => send(res, 200, { ...base, ok: true, delayedMs: Number(ms || 0) }), Number(ms || 0));
        return;
      }

      // 4. Vendor 4xx: /scenario/4xx/<status>. Distinctive body + header to check passthrough.
      case '4xx': {
        const status = Number(parts[2] || 400);
        const body = { error: { code: `VENDOR_${status}`, message: `Vendor says ${status}`, vendorRequestId: ctx.id } };
        if (status === 422) body.error.fields = [{ field: 'email', problem: 'must be a valid email' }];
        return send(res, status, body, { 'x-vendor-error': String(status) });
      }

      // 5. Authentication.
      //    protected: needs `Authorization: Bearer <API_KEY>` or `X-API-Key: <API_KEY>`
      //    forbidden: always 403 (valid creds, insufficient scope)
      //    expired:   valid creds but 401 TOKEN_EXPIRED for first `fail` attempts, then 200
      case 'auth': {
        const sub = parts[2];
        const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '')?.[1];
        const provided = bearer ?? req.headers['x-api-key'];
        const challenge = { 'www-authenticate': 'Bearer realm="gateway-probe"' };
        if (!provided) {
          return send(res, 401, { error: { code: 'MISSING_CREDENTIALS', message: 'No credentials supplied' } }, challenge);
        }
        if (provided !== API_KEY) {
          return send(res, 401, { error: { code: 'INVALID_CREDENTIALS', message: 'Credentials rejected' } }, challenge);
        }
        if (sub === 'forbidden') {
          return send(res, 403, { error: { code: 'INSUFFICIENT_SCOPE', message: 'Key lacks required scope' } });
        }
        if (sub === 'expired' && ctx.attempt <= failCount(q)) {
          return send(res, 401, { error: { code: 'TOKEN_EXPIRED', message: 'Token expired', attempt: ctx.attempt } }, challenge);
        }
        return send(res, 200, { ...base, ok: true, authenticated: true });
      }

      default:
        return send(res, 404, {
          error: { code: 'UNKNOWN_SCENARIO', message: `No scenario '${name}'` },
          scenarios: ['ok', 'echo', 'rate-limit', '5xx/<status>', 'timeout', '4xx/<status>', 'auth/protected', 'auth/forbidden', 'auth/expired'],
        });
    }
  }

  function admin(req, res, url) {
    if (ADMIN_TOKEN) {
      const t = url.searchParams.get('token') || /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '')?.[1];
      if (t !== ADMIN_TOKEN) return send(res, 401, { error: 'admin token required' });
    }
    const q = url.searchParams;
    switch (url.pathname) {
      case '/_admin/log': {
        let rows = log;
        if (q.get('key')) rows = rows.filter((r) => r.key === q.get('key'));
        if (q.get('scenario')) rows = rows.filter((r) => r.scenario === q.get('scenario'));
        return send(res, 200, rows);
      }
      case '/_admin/reset':
        log.length = 0;
        counters.clear();
        return send(res, 200, { reset: true });
      default:
        return send(res, 404, { error: 'unknown admin path' });
    }
  }

  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/health') return send(res, 200, { ok: true });
    if (url.pathname.startsWith('/_admin/')) return admin(req, res, url);
    if (!url.pathname.startsWith('/scenario/')) return send(res, 404, { error: 'not found' });

    const scenario = url.pathname.split('/').filter(Boolean).slice(1).join('/');
    const key = url.searchParams.get('key') || req.headers['x-test-key'] || 'default';
    const counterId = `${scenario}|${key}`;
    const attempt = (counters.get(counterId) || 0) + 1;
    counters.set(counterId, attempt);

    const startedAt = Date.now();
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = raw;
      try { body = raw ? JSON.parse(raw) : undefined; } catch { /* keep raw */ }

      const ctx = {
        id: `r${++seq}`,
        key,
        attempt,
        receivedAt: new Date(startedAt).toISOString(),
        body,
        timer: undefined,
      };
      const entry = {
        id: ctx.id,
        receivedAt: ctx.receivedAt,
        method: req.method,
        scenario,
        key,
        attempt,
        query: Object.fromEntries(url.searchParams),
        headers: safeHeaders(req.headers),
        bodyBytes: raw.length,
        status: null,
        aborted: false,
        elapsedMs: null,
      };
      log.push(entry);
      if (log.length > MAX_LOG) log.shift();

      res.on('finish', () => {
        entry.status = res.statusCode;
        entry.elapsedMs = Date.now() - startedAt;
        console.log(JSON.stringify({ id: entry.id, t: entry.receivedAt, m: entry.method, scenario, key, attempt, status: entry.status, ms: entry.elapsedMs }));
      });
      res.on('close', () => {
        if (!res.writableFinished) {
          entry.aborted = true;
          entry.elapsedMs = Date.now() - startedAt;
          if (ctx.timer) clearTimeout(ctx.timer);
          console.log(JSON.stringify({ id: entry.id, t: entry.receivedAt, m: entry.method, scenario, key, attempt, aborted: true, ms: entry.elapsedMs }));
        }
      });

      handle(req, res, url, ctx);
    });
  });
}

module.exports = { createServer };

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  createServer().listen(port, () => {
    console.log(`gateway-probe listening on :${port} (API_KEY ${API_KEY === 'lovable-test-key' ? 'default' : 'custom'}, admin ${ADMIN_TOKEN ? 'protected' : 'OPEN'})`);
  });
}
