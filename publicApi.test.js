// Run: node publicApi.test.js   (no network)
const assert = require('assert'), { handle, cache } = require('./publicApi');
const NOW = Date.UTC(2026, 10, 10);
const fakeRun = async () => ({ rows: [{ id: 'T1', plate: 'QX12 RSZ', vehicle: null, card: 1, siteCode: '1', site: 'S', reason: 'x', signals: [] }], repeats: [], counts: {} });
const ok = { run: fakeRun, rules: {}, salt: 's', now: NOW };
(async () => {
  assert.equal((await handle({ from: '20261001', to: '20261031' }, ok)).status, 200);
  assert.equal((await handle({ from: '20261001' }, ok)).status, 400);                         // missing date
  assert.equal((await handle({ from: '20260231', to: '20261031' }, ok)).status, 400);         // not a real date
  assert.equal((await handle({ from: '20261031', to: '20261001' }, ok)).status, 400);        // reversed
  assert.equal((await handle({ from: '20261001', to: '20261110' }, ok)).status, 400);        // 41 days
  assert.equal((await handle({ from: '20261101', to: '20261201' }, ok)).status, 400);        // future
  assert.equal((await handle({ from: '20250101', to: '20250110' }, ok)).status, 400);        // too old
  let calls = 0; const counting = { ...ok, run: async () => { calls++; await new Promise(r => setTimeout(r, 20)); return fakeRun(); } };
  cache.clear(); await Promise.all([handle({ from: '20261005', to: '20261010' }, counting), handle({ from: '20261005', to: '20261010' }, counting)]);
  assert.equal(calls, 1);                                                                     // two visitors, one upstream run
  cache.clear(); const bad = { ...ok, run: async () => { throw new Error('Shell secret detail'); } };
  const r = await handle({ from: '20261005', to: '20261010' }, bad);
  assert.equal(r.status, 502); assert.ok(!JSON.stringify(r).includes('secret'));              // no upstream detail leaks
  assert.equal(cache.size, 0);                                                                // failure not cached
  const body = (await handle({ from: '20261001', to: '20261002' }, ok)).body;
  assert.ok(!JSON.stringify(body).includes('QX12'));                                          // output is anonymised
  console.log('public api checks passed');
})();
