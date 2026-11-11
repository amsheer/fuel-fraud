// FleetYes fuel-fraud sample: API clients + pure decision logic (no I/O in the logic, so it is testable).
const fs = require('fs'), path = require('path'), crypto = require('crypto');

// ---- config -------------------------------------------------------------
const env = {};
try { fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/).forEach(l => { const i = l.indexOf('='); if (i > 0) env[l.slice(0, i).trim()] = l.slice(i + 1).trim(); }); } catch (e) {}
const need = k => { const v = env[k] || process.env[k]; if (!v) throw new Error('missing ' + k + ' in .env or the environment'); return v; };
const payer = () => ({ PayerId: +need('SHELL_PAYER_ID'), PayerNumber: need('SHELL_PAYER_NUMBER') }); // from Shell loggedinuser

// ---- helpers ------------------------------------------------------------
const norm = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const km = (a, b, c, d) => { const R = 6371, r = x => x * Math.PI / 180, dl = r(c - a), dn = r(d - b); const h = Math.sin(dl / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(dn / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
// Purchase instant in UTC: local date+time minus UTCOffset (confirmed against GPS earlier).
function purchaseUtc(t) {
  const d = String(t.TransactionDate), tm = String(t.TransactionTime); // 'YYYYMMDD', 'HH:MM:SS'
  const local = Date.parse(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${tm}Z`);
  const m = /^([+-])(\d\d):(\d\d)/.exec(String(t.UTCOffset || '+00:00')); // '+01:00:00'
  const off = m ? (m[1] === '-' ? -1 : 1) * (+m[2] * 60 + +m[3]) * 60000 : 0;
  return new Date(local - off);
}

// ---- API clients ---------------------------------------------------------
let shellTok = null;
async function shellToken() {
  if (shellTok && shellTok.exp > Date.now() + 60000) return shellTok.v;
  const r = await fetch('https://api.shell.com/v2/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', RequestId: crypto.randomUUID() }, body: new URLSearchParams({ client_id: need('SHELL_CLIENT_ID'), client_secret: need('SHELL_CLIENT_SECRET'), grant_type: 'client_credentials', scope: 'exp-scol-reports/read' }), signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error('Shell token HTTP ' + r.status);
  const j = await r.json(); shellTok = { v: j.access_token, exp: Date.now() + (j.expires_in || 899) * 1000 }; return shellTok.v;
}
async function shellTransactions(from, to) { // from/to YYYYMMDD; pages until a short page
  const all = [];
  for (let page = 1; page < 20; page++) {
    const r = await fetch('https://api.shell.com/transaction-data/v1/multipayerspricedtransactions', { method: 'POST', headers: { Authorization: 'Bearer ' + await shellToken(), 'Content-Type': 'application/json', RequestId: crypto.randomUUID() }, body: JSON.stringify({ Page: page, PageSize: 50, Filters: { ColCoCode: 5, Accounts: [payer()], InvoiceStatus: 'A', FromDate: from, ToDate: to, FuelOnly: true, IncludeFees: false, CurrentPage: page, PageSize: 50 } }), signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw new Error('Shell transactions HTTP ' + r.status);
    const j = await r.json(), rows = (j.Data && j.Data[0] && j.Data[0].Transactions) || [];
    all.push(...rows); if (page >= (j.TotalPages || 1)) break;
  }
  return all;
}
let geoSess = null;
async function geo(method, params, retry = true) {
  if (!geoSess) {
    const a = await (await fetch('https://my.geotab.com/apiv1', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'Authenticate', params: { database: need('GEOTAB_DATABASE'), userName: need('GEOTAB_USER'), password: need('GEOTAB_PASSWORD') } }), signal: AbortSignal.timeout(60000) })).json();
    if (!a.result) throw new Error('Geotab auth failed');
    geoSess = a.result.credentials;
  }
  const j = await (await fetch('https://my.geotab.com/apiv1', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params: { ...params, credentials: geoSess } }), signal: AbortSignal.timeout(60000) })).json();
  if (j.error && retry && /InvalidUser|session/i.test(JSON.stringify(j.error))) { geoSess = null; return geo(method, params, false); }
  if (j.error) throw new Error('Geotab ' + method + ': ' + (j.error.message || '').slice(0, 120));
  return j.result;
}
const geoGet = (typeName, search) => geo('Get', { typeName, search });
const geoMulti = calls => geo('ExecuteMultiCall', { calls: calls.map(([method, params]) => ({ method, params })) });

// ---- decision logic (pure) -----------------------------------------------
// Allowed gap between litres bought and litres seen: the larger of a fixed number of litres or a share of the purchase.
// Set in rules.json. 30 L / 10% is wider than the demo's 15 L / 5% because the tank-level sensor reads whole percent
// steps (about 4 L each on a 440 L tank) and the tank size is itself an estimate. Not tuned on known fraud cases.
const tolerance = (purchasedL, cfg = {}) => Math.max(cfg.min_litres ?? 30, (cfg.percent ?? 10) / 100 * purchasedL);
const MIN_FILL_L = 10; // a gain below this is not counted as a fill (demo rule)

// Step 0: is the purchase allowed by the partner's rules? Returns null when allowed.
function checkPolicy(tx, rules) {
  const sc = String(tx.SiteCode);
  const b = rules.city_boundary;
  if (b && b.enabled && tx.lat != null) {
    const d = km(b.centre.lat, b.centre.lon, tx.lat, tx.lon);
    if (d > b.radius_km) return `Station is ${d.toFixed(0)} km from the depot; the rule allows ${b.radius_km} km.`;
  }
  const a = rules.approved_stations;
  if (a && a.enabled && !a.site_codes.includes(sc)) return `Station ${sc} is not on the approved list.`;
  return null;
}

// Step 1: which vehicle? plate first, then card history, then place and time. Returns {device, how} or {device:null, how, note}.
function identifyVehicle(tx, ctx) {
  const plate = norm(tx.VehicleRegistration);
  if (plate && ctx.byPlate[plate]) return { device: ctx.byPlate[plate], how: 'plate' };
  const viaCard = ctx.cardMap[tx.CardId];
  if (viaCard) return { device: viaCard, how: 'card history' };
  const near = ctx.nearby || [];
  if (near.length === 1) return { device: near[0], how: 'location and time' };
  if (near.length > 1) return { device: null, how: 'ambiguous', note: near.length + ' vehicles were at the station' };
  return { device: null, how: 'none', note: plate ? `Plate ${plate} is not in Geotab` : 'No plate on the purchase' };
}

// Step 2-3: compare litres with the fill Geotab saw. fill = {litres} | null (no data)
function compareLitres(tx, fill, tolCfg) {
  const bought = Number(tx.Quantity);
  if (!fill) return { outcome: 'insufficient', reason: 'Geotab has no fill-up for this vehicle near the purchase time.' };
  if (fill.noCap) return { outcome: 'insufficient', reason: fill.what, noCap: true };
  const diff = bought - fill.litres, tol = tolerance(bought, tolCfg), seen = (fill.what || 'Tank gained') + ` ${fill.litres.toFixed(1)} L.`;
  if (Math.abs(diff) <= tol) return { outcome: 'supported', reason: `Bought ${bought.toFixed(1)} L. ${seen} Within ${tol.toFixed(1)} L.`, diff };
  if (fill.spread > 1.2) return { outcome: 'ambiguous', reason: `Bought ${bought.toFixed(1)} L. ${seen} ${Math.abs(diff).toFixed(1)} L ${diff > 0 ? 'unexplained' : 'more than bought'}, but this truck's tank-level readings are not consistent (the implied tank size on its other purchases ranges ${fill.capRange}), so the gap is not conclusive.`, diff };
  return { outcome: 'quantity', reason: `Bought ${bought.toFixed(1)} L. ${seen} ${diff > 0 ? diff.toFixed(1) + ' L unexplained' : (-diff).toFixed(1) + ' L more than bought'}; allowed ${tol.toFixed(1)} L.`, diff };
}

// Distance check: litres bought now should roughly match what the truck burned since the previous purchase.
// Assumes the previous purchase filled the tank. Returns {lPer100, flag}; km is the distance driven in between.
function consumption(litres, km, maxLPer100) {
  if (km == null) return null;
  if (km < 1) return { lPer100: null, flag: litres > MIN_FILL_L };      // bought fuel, truck barely moved
  const l = litres / km * 100;
  return { lPer100: +l.toFixed(1), flag: l > maxLPer100 };
}

// Where was one truck around the payment? points = its GPS (LogRecord). Same idea as the colleague's script.
//  stoppedHere: at the station (within radiusKm) and slow (<= 5 km/h) at any time in the window
//  posKnown/payDistKm: where it was AT payment time (a point within 10 min, or the same place just before and after)
function presence(points, lat, lon, payMs, radiusKm = 0.3, stoppedKmh = 5, gapMin = 10) {
  const r = { stoppedHere: false, closestKm: null, posKnown: false, payDistKm: null };
  if (!points.length) return r;
  const at = p => Date.parse(p.dateTime);
  for (const p of points) {
    const d = km(lat, lon, p.latitude, p.longitude);
    r.closestKm = r.closestKm == null ? d : Math.min(r.closestKm, d);
    if (d <= radiusKm && p.speed <= stoppedKmh) r.stoppedHere = true;
  }
  const pts = [...points].sort((a, b) => at(a) - at(b));
  const nearest = pts.reduce((m, p) => Math.abs(at(p) - payMs) < Math.abs(at(m) - payMs) ? p : m);
  let ref = null;
  if (Math.abs(at(nearest) - payMs) <= gapMin * 60000) ref = nearest;
  else { // a parked truck reports rarely: same place before and after still tells us where it was
    const before = pts.filter(p => at(p) <= payMs), after = pts.filter(p => at(p) > payMs);
    if (before.length && after.length && km(before[before.length - 1].latitude, before[before.length - 1].longitude, after[0].latitude, after[0].longitude) <= radiusKm) ref = before[before.length - 1];
  }
  if (ref) { r.posKnown = true; r.payDistKm = km(lat, lon, ref.latitude, ref.longitude); }
  return r;
}

// One edit (swap, add or drop a character) apart: a typed plate this close to a Geotab plate is most likely a typo.
const within1 = (a, b) => {
  if (a === b) return true; if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return a.length === b.length ? a.slice(i + 1) === b.slice(i + 1) : a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
};
const REGISTRATION = /^[A-Z]{2}\d{2}[A-Z]{3}$/; // current UK format; other formats and placeholders (TRUCK 1) are never called "not in Geotab"
// We are SURE a vehicle is not in Geotab only when: the plate is a real registration, it is not a Geotab plate, no card
// history or override links it to one, and it is not one character away from a Geotab plate (a probable typo).
function notInGeotab(tx, ctx) {
  const plate = norm(tx.VehicleRegistration);
  if (!REGISTRATION.test(plate) || ctx.byPlate[plate] || ctx.cardMap[tx.CardId]) return { sure: false };
  const typo = (ctx.geoPlates || []).find(p => within1(p, plate));
  return typo ? { sure: false, typo } : { sure: true };
}

function assess(tx, ctx, rules) {
  const policy = checkPolicy(tx, rules);
  const absent = notInGeotab(tx, ctx);
  const v = absent.sure ? { device: null, how: 'none' } : identifyVehicle(tx, ctx);
  const base = { id: tx.TransactionId, line: tx.TransactionLine, when: tx.utc, site: tx.SiteName, siteCode: tx.SiteCode, plate: tx.VehicleRegistration, card: tx.CardId, litres: Number(tx.Quantity), vehicle: v.device ? v.device.name : null, matchedBy: v.how, distanceKm: ctx.distanceKm == null ? null : +ctx.distanceKm.toFixed(2) };
  if (policy) return { ...base, outcome: 'policy', reason: policy };
  const here = (ctx.atStation || []).map(d => String(d.name).split('_').pop());
  if (absent.sure) {
    const seen = here.length ? ` Tracked trucks stopped at the station: ${here.join(', ')}.` : '';
    return { ...base, outcome: 'notgeotab', reason: `Plate ${tx.VehicleRegistration} is not a Geotab vehicle (${(ctx.geoPlates || []).length} Geotab vehicles checked). There is no tank, GPS or odometer to compare, so this is Shell data only.` + seen, likely: here };
  }
  if (!v.device) {
    const typoNote = absent.typo ? ` The plate is one character from the Geotab vehicle ${absent.typo}: probably a typo. If so, add it to plate_overrides.` : '';
    const seen = here.length ? ` Tracked trucks stopped at the station: ${here.join(', ')}.` : '';
    return { ...base, outcome: v.how === 'ambiguous' ? 'ambiguous' : 'unidentified', reason: v.note + '.' + typoNote + seen, likely: here };
  }
  const c = compareLitres(tx, ctx.fillFor(v.device, tx), rules.tolerance);
  // A place-and-time match is only a guess. A litres mismatch on a guess goes to review, not to "exception".
  if (v.how === 'location and time' && c.outcome === 'quantity') return { ...base, ...c, outcome: 'ambiguous', reason: `Possible vehicle ${v.device.name} (the plate on the purchase is ${tx.VehicleRegistration || 'blank'}). ${c.reason}` };
  const P = ctx.presenceOf ? ctx.presenceOf(v.device) : ctx.presence;
  if (c.outcome !== 'insufficient' || c.noCap || !P) return { ...base, ...c };
  // No litres evidence for this truck. Use where it was: being at the pump is evidence, being elsewhere is a flag.
  const name = base.vehicle;
  if (v.how === 'location and time') return { ...base, outcome: 'unidentified', reason: `Plate ${tx.VehicleRegistration || '(blank)'} is not in Geotab. Tracked truck ${name} was at the station and may have received the fuel; the litres cannot be confirmed.`, likely: [name] };
  if (P.stoppedHere) {
    if (ctx.hasSensor && ctx.hasSensor(v.device)) return { ...base, outcome: 'ambiguous', reason: `${name} was stopped at the station and has a fuel sensor, but no refuel was recorded. The fuel may not have gone into its tank (or it was a small top-up that Geotab does not log as a fill).` };
    return { ...base, outcome: 'partly', reason: `${name} was stopped at the station (${Math.round((P.closestKm || 0) * 1000)} m away). The litres cannot be confirmed: this truck has no fuel-level data.` };
  }
  if (P.posKnown) {
    const away = `${name} was ${P.payDistKm.toFixed(1)} km from the station at payment time.`;
    if (here.length) return { ...base, outcome: 'ambiguous', reason: `${away} Fuel most likely went into ${here.join(', ')}.`, likely: here };
    return { ...base, outcome: 'suspect', reason: `${away} No tracked fleet truck was at the station.` };
  }
  return { ...base, ...c };
}

module.exports = { within1, presence, norm, km, purchaseUtc, shellTransactions, geoGet, geoMulti, geo, tolerance, MIN_FILL_L, checkPolicy, consumption, identifyVehicle, compareLitres, assess };
