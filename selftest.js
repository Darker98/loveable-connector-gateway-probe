'use strict';
// Sanity-checks the probe server itself (not Lovable). Run: node selftest.js
const assert = require('node:assert/strict');
const { createServer } = require('./server');

const server = createServer();
server.listen(0, async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (p, opts) => fetch(base + p, opts);
  try {
    // 429 then success, with Retry-After variants
    let r = await get('/scenario/rate-limit?key=a&fail=1&retryAfter=3');
    assert.equal(r.status, 429);
    assert.equal(r.headers.get('retry-after'), '3');
    assert.equal((await get('/scenario/rate-limit?key=a&fail=1')).status, 200);
    r = await get('/scenario/rate-limit?key=d&fail=all&retryAfter=date');
    assert.match(r.headers.get('retry-after'), /GMT$/);
    r = await get('/scenario/rate-limit?key=n&fail=all&retryAfter=none');
    assert.equal(r.headers.get('retry-after'), null);

    // 5xx
    for (const s of [500, 502, 503, 504]) assert.equal((await get(`/scenario/5xx/${s}?key=s${s}&fail=all`)).status, s);
    const f1 = await get('/scenario/5xx/503?key=flaky&fail=2');
    const f2 = await get('/scenario/5xx/503?key=flaky&fail=2');
    const f3 = await get('/scenario/5xx/503?key=flaky&fail=2');
    assert.deepEqual([f1.status, f2.status, f3.status], [503, 503, 200]);

    // 4xx passthrough shape
    r = await get('/scenario/4xx/422?key=v');
    assert.equal(r.status, 422);
    assert.equal((await r.json()).error.fields[0].field, 'email');

    // timeout: delayed reply, and a client abort is recorded
    r = await get('/scenario/timeout?key=slow&ms=300');
    assert.equal(r.status, 200);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    await get('/scenario/timeout?key=hang&ms=hang', { signal: ac.signal }).catch(() => {});
    await new Promise((res) => setTimeout(res, 100));
    const log = await (await get('/_admin/log?key=hang')).json();
    assert.equal(log[0].aborted, true);

    // auth
    assert.equal((await get('/scenario/auth/protected?key=u')).status, 401);
    assert.equal((await get('/scenario/auth/protected?key=u', { headers: { authorization: 'Bearer nope' } })).status, 401);
    const good = { authorization: 'Bearer lovable-test-key' };
    assert.equal((await get('/scenario/auth/protected?key=u', { headers: good })).status, 200);
    assert.equal((await get('/scenario/auth/protected?key=u', { headers: { 'x-api-key': 'lovable-test-key' } })).status, 200);
    assert.equal((await get('/scenario/auth/forbidden?key=u', { headers: good })).status, 403);
    assert.equal((await get('/scenario/auth/expired?key=e&fail=1', { headers: good })).status, 401);
    assert.equal((await get('/scenario/auth/expired?key=e&fail=1', { headers: good })).status, 200);

    // POST body echoed and credentials redacted in the log
    r = await get('/scenario/echo?key=p', { method: 'POST', headers: { ...good, 'content-type': 'application/json' }, body: '{"x":1}' });
    assert.deepEqual((await r.json()).body, { x: 1 });
    const echoLog = await (await get('/_admin/log?key=p')).json();
    assert.match(echoLog[0].headers.authorization, /…/);

    console.log('selftest passed');
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    server.close();
  }
});
