// Public, read-only endpoint for the demo page. Pure logic (no Firebase code) so it can be tested.
// Safe by construction: output is anonymised, the date range is capped, results are cached and shared between
// simultaneous requests, and upstream error details never reach the browser.
const { anonymise } = require('./anonymise');
const MAX_DAYS = 31, MAX_AGE_DAYS = 180, TTL_MS = 10 * 60000;
const cache = new Map(); // "from-to" -> { t, promise }

const toDate = s => new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)));
const valid = s => /^\d{8}$/.test(s || '') && toDate(s).toISOString().slice(0, 10).replace(/-/g, '') === s;

async function handle(query, { run, rules, salt, now = Date.now() }) {
  const { from, to } = query || {};
  if (!valid(from) || !valid(to)) return { status: 400, body: { error: 'Choose a from and a to date.' } };
  const days = (toDate(to) - toDate(from)) / 86400000 + 1;
  if (days < 1) return { status: 400, body: { error: 'The from date must not be after the to date.' } };
  if (days > MAX_DAYS) return { status: 400, body: { error: `Choose at most ${MAX_DAYS} days.` } };
  if (toDate(to) > now) return { status: 400, body: { error: 'The to date is in the future.' } };
  if (now - toDate(from) > MAX_AGE_DAYS * 86400000) return { status: 400, body: { error: `Dates older than ${MAX_AGE_DAYS} days are not available.` } };
  const key = from + '-' + to;
  const hit = cache.get(key);
  if (!hit || now - hit.t > TTL_MS) {
    const promise = run(from, to, rules).then(r => anonymise(r, salt));
    cache.set(key, { t: now, promise });
    promise.catch(() => cache.delete(key)); // never cache a failure
  }
  try { return { status: 200, body: await cache.get(key).promise }; }
  catch (e) { console.error('check failed', e.message); return { status: 502, body: { error: 'The live check failed. Try again in a minute.' } }; }
}
module.exports = { handle, cache };
