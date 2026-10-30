'use strict';
// Usage: node report.js <baseUrl> [adminToken] [key]
// Prints, per scenario/key, every attempt the server saw: arrival gap, status,
// and whether the caller hung up (that's how a gateway timeout shows itself).

const [base, token, key] = process.argv.slice(2);
if (!base) {
  console.error('usage: node report.js <baseUrl> [adminToken] [key]');
  process.exit(1);
}

(async () => {
  const u = new URL('/_admin/log', base);
  if (token) u.searchParams.set('token', token);
  if (key) u.searchParams.set('key', key);
  const rows = await (await fetch(u)).json();

  const groups = new Map();
  for (const r of rows) {
    const g = `${r.scenario}  key=${r.key}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(r);
  }

  for (const [g, rs] of groups) {
    console.log(`\n${g}  (${rs.length} request${rs.length === 1 ? '' : 's'} reached the server)`);
    let prev = null;
    for (const r of rs) {
      const t = Date.parse(r.receivedAt);
      const gap = prev == null ? '      -' : `+${((t - prev) / 1000).toFixed(2).padStart(6)}s`;
      prev = t;
      const outcome = r.aborted ? `ABORTED by caller after ${r.elapsedMs} ms` : `${r.status} in ${r.elapsedMs} ms`;
      const ua = r.headers['user-agent'] || '?';
      console.log(`  #${String(r.attempt).padEnd(2)} ${r.method.padEnd(6)} ${gap}  ${outcome}   ua=${ua}`);
    }
  }
  if (!rows.length) console.log('log is empty');
})();
