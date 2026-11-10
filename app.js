// FleetYes fuel-fraud SAMPLE system. Run: node app.js  ->  http://localhost:8800
// Read-only against Shell and Geotab. Keys come from .env (never sent to the browser).
const http = require('http'), fs = require('fs'), path = require('path');
const L = require('./lib');
const PORT = 8800, RULES = path.join(__dirname, 'rules.json');
const loadRules = () => JSON.parse(fs.readFileSync(RULES, 'utf8'));
const ymdToIso = (s, add = 0) => new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)) + add * 86400000).toISOString();
const MIN = 60000, NEAR_KM = 0.3, FILL_WINDOW = 90 * MIN, GPS_WINDOW = 15 * MIN;

async function logPoints(calls) { // calls: [{dev, from, to}] -> array of point arrays, batched
  const out = [];
  for (let i = 0; i < calls.length; i += 20) {
    const batch = calls.slice(i, i + 20);
    const res = await L.geoMulti(batch.map(c => ['Get', { typeName: 'LogRecord', search: { deviceSearch: { id: c.dev }, fromDate: c.from, toDate: c.to } }]));
    out.push(...res);
  }
  return out;
}
const closest = (pts, lat, lon) => pts.reduce((m, p) => Math.min(m, L.km(lat, lon, p.latitude, p.longitude)), Infinity);

async function run(from, to, rules) {
  // Read 45 extra days of history before the chosen period, so each truck's tank size is learned from enough purchases
  // even when the period is short. Only purchases inside the period are shown.
  const lookFrom = ymdToIso(from, -45).slice(0, 10).replace(/-/g, '');
  const [rawAll, devices, fills] = await Promise.all([
    L.shellTransactions(lookFrom, to), L.geoGet('Device'),
    L.geoGet('FillUp', { fromDate: ymdToIso(lookFrom, -1), toDate: ymdToIso(to, 2) })]);
  const inRange = t => t.TransactionDate >= from && t.TransactionDate <= to, raw = rawAll.filter(inRange);

  // One Shell transaction can hold several lines (the pump split one fill into 100 L parts, or AdBlue sits on line 1).
  // Fuel = Diesel lines summed per TransactionId; AdBlue is not fuel and is skipped.
  const groups = new Map(); let adblueSkipped = 0;
  for (const t of rawAll) {
    if (t.ProductName !== 'Diesel AGO') { adblueSkipped++; continue; }
    const g = groups.get(t.TransactionId); if (g) { g.Quantity += Number(t.Quantity); g.lines++; } else groups.set(t.TransactionId, { ...t, Quantity: Number(t.Quantity), lines: 1 });
  }
  const txsAll = [...groups.values()], txs = txsAll.filter(inRange);
  txsAll.forEach(t => { t.utc = L.purchaseUtc(t); const l = t.Location || {}; t.lat = l.Latitude ? +l.Latitude : null; t.lon = l.Longitude ? +l.Longitude : null; });

  const byPlate = {};
  devices.forEach(d => { byPlate[L.norm(String(d.name).split('_').pop())] = d; if (d.licensePlate) byPlate[L.norm(d.licensePlate)] = d; });
  // plate typed wrongly at the pump for a tracked truck (assumed typo, confirm with the customer): rules.json plate_overrides
  Object.entries(rules.plate_overrides || {}).forEach(([from, to]) => { if (byPlate[L.norm(to)]) byPlate[L.norm(from)] = byPlate[L.norm(to)]; });
  const fillsBy = {}; fills.forEach(f => (fillsBy[f.device.id] = fillsBy[f.device.id] || []).push(f));

  // history: a card that always paired with one Geotab vehicle by plate
  const hist = {};
  txsAll.forEach(t => { const d = byPlate[L.norm(t.VehicleRegistration)]; if (d) (hist[t.CardId] = hist[t.CardId] || new Set()).add(d.id); });
  const cardMap = {}; devices.forEach(d => { for (const [c, s] of Object.entries(hist)) if (s.size === 1 && s.has(d.id)) cardMap[c] = d; });

  // GPS presence per purchase and truck: stopped at the station? where was it at payment time? (15 min either side)
  const idOf = t => L.norm(t.VehicleRegistration), ownDev = t => byPlate[idOf(t)] || cardMap[t.CardId];
  const presenceBy = txs.map(() => ({}));
  const fetchPresence = async jobs => {
    const pts = await logPoints(jobs.map(j => ({ dev: j.dev, from: new Date(txs[j.i].utc - GPS_WINDOW).toISOString(), to: new Date(+txs[j.i].utc + GPS_WINDOW).toISOString() })));
    jobs.forEach((j, k) => { const t = txs[j.i]; presenceBy[j.i][j.dev] = L.presence(pts[k].filter(p => p.id), t.lat, t.lon, +t.utc); }); // id null = calculated edge point
  };
  await fetchPresence(txs.flatMap((t, i) => t.lat == null ? [] : ownDev(t) ? [{ i, dev: ownDev(t).id }] : devices.map(d => ({ i, dev: d.id }))));
  // card truck is not at the station: who else was?
  await fetchPresence(txs.flatMap((t, i) => { const o = ownDev(t), P = o && presenceBy[i][o.id]; return P && !P.stoppedHere ? devices.filter(d => d.id !== o.id).map(d => ({ i, dev: d.id })) : []; }));

  const devById = Object.fromEntries(devices.map(d => [d.id, d]));
  // A Geotab fill-up is a PERIOD: it starts at the last low tank reading (dateTime) and ends when the level peaks
  // (maximaPoint.dateTime, capped at 2 h). Shell books the payment inside that period, often 60 to 150 min after the start,
  // because a parked or sparse tracker reports rarely. Match when the payment is inside the period (10 min before to 30 min after).
  const periodOf = f => { const s = Date.parse(f.dateTime), pk = f.tankLevelExtrema.maximaPoint.dateTime; return [s, pk ? Math.min(Date.parse(pk), s + 120 * MIN) : s]; };
  const fillWin = (dev, t) => (fillsBy[dev.id] || []).map(f => { const [s, e] = periodOf(f); return { f, gap: t.utc < s ? s - t.utc : t.utc > e ? t.utc - e : 0 }; })
    .filter(x => x.gap <= 30 * MIN && (+t.utc - periodOf(x.f)[0]) >= -10 * MIN).sort((a, b) => a.gap - b.gap || Math.abs(Date.parse(a.f.dateTime) - t.utc) - Math.abs(Date.parse(b.f.dateTime) - t.utc))[0]?.f;
  const jumpOf = f => f.tankLevelExtrema.maximaPoint.data - f.tankLevelExtrema.minimaPoint.data; // tank level rise, percentage points
  // Tank size per truck: customer value in rules.json, else the median of litres bought / level rise from the truck's own history.
  const implied = {}; txsAll.forEach(t => { const dev = byPlate[idOf(t)] || cardMap[t.CardId], f = dev && fillWin(dev, t); if (f && jumpOf(f) >= 20) (implied[dev.id] = implied[dev.id] || []).push(Number(t.Quantity) / jumpOf(f) * 100); });
  const median = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const capOf = (dev, t) => { const given = (rules.tank_litres || {})[L.norm(String(dev.name).split('_').pop())]; if (given) return { cap: given, src: 'from rules.json' }; const a = implied[dev.id]; const q = a && [...a].sort((x, y) => x - y); return a && a.length >= 4 ? { cap: median(a), spread: q[Math.floor((q.length - 1) * .75)] / q[Math.floor((q.length - 1) * .25)], range: Math.round(q[Math.floor((q.length - 1) * .25)]) + ' to ' + Math.round(q[Math.floor((q.length - 1) * .75)]) + ' L (middle half)', src: 'learned from this truck\'s own purchases' } : null; };
  const fillFor = (dev, t) => {
    const f = fillWin(dev, t); if (!f) return null;
    const j = jumpOf(f), lo = f.tankLevelExtrema.minimaPoint.data, hi = f.tankLevelExtrema.maximaPoint.data, c = capOf(dev, t);
    if (!c || j < 5) return { noCap: true, what: `Geotab saw the tank rise from ${lo.toFixed(0)}% to ${hi.toFixed(0)}%, but this truck's tank size is not known (add it to rules.json under tank_litres).` };
    return { litres: j / 100 * c.cap, what: `Tank level rose from ${lo.toFixed(0)}% to ${hi.toFixed(0)}% (${j.toFixed(0)} points). At a tank size of ${c.cap.toFixed(0)} L (${c.src}) that is`, cap: Math.round(c.cap), spread: c.spread, capRange: c.range };
  };
  const rows = txs.map((t, i) => {
    const dev = ownDev(t), pres = presenceBy[i], own = dev ? pres[dev.id] : null;
    const atStation = devices.filter(d => (!dev || d.id !== dev.id) && pres[d.id] && pres[d.id].stoppedHere);
    const r = L.assess(t, { byPlate, cardMap, nearby: dev ? [] : atStation, atStation, presence: own, presenceOf: d => pres[d.id], hasSensor: d => !!fillsBy[d.id], distanceKm: own ? (own.payDistKm != null ? own.payDistKm : own.closestKm) : null, fillFor }, rules);
    r.coords = t.lat == null ? null : [t.lat, t.lon];
    r.odometerTyped = t.OdometerInput || null;
    r.signals = [];
    r.lines = t.lines; r.network = t.DelcoName + (t.IsShellSite ? '' : ' (not a Shell site)'); r.price = t.UnitPriceInTransactionCurrency;
    const typedId = L.norm(t.FleetIdInput); if (typedId && typedId !== L.norm(t.VehicleRegistration)) r.signals.push(`Fleet ID typed at the pump is ${t.FleetIdInput}, but the card's vehicle is ${t.VehicleRegistration}`);
    if (r.distanceKm != null && r.distanceKm > 1) r.signals.push(`Vehicle GPS was ${r.distanceKm.toFixed(1)} km from the station`);
    if (dev && t.lat != null && own && own.closestKm == null) r.signals.push('Vehicle sent no GPS near the purchase time');
    if (t.lat == null) r.signals.push('Shell gave no station coordinates');
    return r;
  });
  // typed odometer (driver keys it at the pump; filled on few rows): km since the previous typed reading, works without Geotab
  const cons0 = rules.consumption || { enabled: false };
  [...new Set(rows.map(r => L.norm(r.plate)))].forEach(pl => {
    const mine = rows.filter(r => L.norm(r.plate) === pl && r.odometerTyped).sort((a, b) => a.when - b.when);
    mine.forEach((r, k) => {
      if (!k) return; const prev = mine[k - 1], km = r.odometerTyped - prev.odometerTyped;
      r.typed = { km, since: prev.when.toISOString(), lPer100: km > 0 ? +(r.litres / km * 100).toFixed(1) : null };
      if (km <= 0) r.signals.push(`Odometer typed ${r.odometerTyped} is not higher than the previous reading ${prev.odometerTyped}`);
      else if (cons0.enabled && r.typed.lPer100 > cons0.max_l_per_100km) r.signals.push(`Typed odometer: ${km} km since the previous reading but bought ${r.litres} L (${r.typed.lPer100} L per 100 km, limit ${cons0.max_l_per_100km})`);
    });
  });
  // distance driven since the previous purchase of the same vehicle (Geotab Trip distance, km)
  const names = [...new Set(rows.filter(r => r.vehicle).map(r => r.vehicle))], devByName = Object.fromEntries(devices.map(d => [d.name, d]));
  const trips = {}; await Promise.all(names.map(async n => { trips[n] = await L.geoGet('Trip', { deviceSearch: { id: devByName[n].id }, fromDate: ymdToIso(from, -1), toDate: ymdToIso(to, 2) }); }));
  const cons = rules.consumption || { enabled: false };
  names.forEach(n => {
    const mine = rows.filter(r => r.vehicle === n).sort((a, b) => (a.when - b.when));
    mine.forEach((r, k) => {
      if (!k) return;
      const prev = mine[k - 1], between = trips[n].filter(x => Date.parse(x.start) >= +prev.when && Date.parse(x.start) < +r.when);
      if (!between.length) return; // no trips at all (silent device) means no data, not "parked"
      const km = between.reduce((s, x) => s + x.distance, 0), c = L.consumption(r.litres, km, cons.max_l_per_100km);
      r.drove = { km: +km.toFixed(0), since: prev.when.toISOString(), lPer100: c && c.lPer100 };
      if (cons.enabled && c && c.flag) r.signals.push(`Drove ${r.drove.km} km since the previous purchase (${r.drove.since.slice(0, 10)}) but bought ${r.litres} L` + (c.lPer100 ? `: ${c.lPer100} L per 100 km, limit ${cons.max_l_per_100km}` : ''));
    });
  });
  rows.forEach(r => { // tell the reviewer where the truck was when no fuel data exists
    if (r.outcome !== 'insufficient') return;
    r.reason += r.distanceKm != null ? ` The nearest GPS point within 15 min of payment was ${r.distanceKm < 1 ? Math.round(r.distanceKm * 1000) + ' m' : r.distanceKm.toFixed(1) + ' km'} from the station.` : ' No GPS from this truck near the purchase time.';
  });
  // engine on or off at payment time, for suspected purchases (Geotab ignition)
  await Promise.all(rows.filter(r => r.outcome === 'suspect').map(async r => {
    try {
      const d = byPlate[L.norm(r.plate)] || cardMap[r.card];
      const res = await L.geoGet('StatusData', { deviceSearch: { id: d.id }, diagnosticSearch: { id: 'DiagnosticIgnitionId' }, fromDate: new Date(r.when - 3 * 3600000).toISOString(), toDate: r.when.toISOString() });
      const last = res.filter(x => Date.parse(x.dateTime) <= +r.when).sort((a, b) => Date.parse(a.dateTime) - Date.parse(b.dateTime)).pop();
      if (last) r.reason += last.data ? ' Engine was on at payment time.' : ' Engine was off at payment time.';
    } catch (e) { /* ignition is extra evidence only */ }
  }));
  // repeats: same card, same litres, 3 or more times
  const rep = {}; rows.forEach(r => { const k = r.card + '|' + r.litres; (rep[k] = rep[k] || []).push(r); });
  const repeats = Object.values(rep).filter(a => a.length >= 3);
  repeats.forEach(a => a.forEach(r => r.signals.push(`Same card bought exactly ${r.litres} L ${a.length} times`)));
  const counts = {}; rows.forEach(r => counts[r.outcome] = (counts[r.outcome] || 0) + 1);
  const unexplained = rows.filter(r => r.outcome === 'quantity' && r.diff > 0).reduce((s, r) => s + r.diff, 0);
  return { generated: new Date().toISOString(), range: { from, to }, shellRows: raw.length, mergedLines: txs.reduce((s, x) => s + x.lines - 1, 0), adblueSkipped, devices: devices.length, devicesWithFills: Object.keys(fillsBy).length, counts, unexplainedLitres: +unexplained.toFixed(1), repeats: repeats.map(a => ({ card: a[0].card, plate: a[0].plate, litres: a[0].litres, times: a.length })), rows };
}

const cache = new Map();
const send = (res, code, type, body) => { res.writeHead(code, { 'Content-Type': type }); res.end(body); };
const ok = new Set(['localhost:' + PORT, '127.0.0.1:' + PORT]);
if (require.main === module) http.createServer(async (req, res) => {
  if (!ok.has(req.headers.host)) return send(res, 403, 'text/plain', 'bad host');
  const u = new URL(req.url, 'http://x');
  try {
    const page = { '/': 'index.html', '/scenarios.html': 'scenarios.html' }[u.pathname];
    if (page) return send(res, 200, 'text/html; charset=utf-8', fs.readFileSync(path.join(__dirname, 'docs', page)));
    if (u.pathname === '/api/rules' && req.method === 'GET') return send(res, 200, 'application/json', JSON.stringify(loadRules()));
    if (u.pathname === '/api/rules' && req.method === 'PUT') {
      let b = ''; for await (const c of req) b += c;
      const n = JSON.parse(b), r = loadRules();
      r.city_boundary.enabled = !!n.city_boundary.enabled; r.city_boundary.radius_km = Math.max(1, +n.city_boundary.radius_km || r.city_boundary.radius_km);
      r.approved_stations.enabled = !!n.approved_stations.enabled; r.approved_stations.site_codes = n.approved_stations.site_codes.map(String);
      if (n.tolerance) { r.tolerance = { min_litres: Math.max(0, +n.tolerance.min_litres || 0), percent: Math.max(0, +n.tolerance.percent || 0) }; }
      if (n.consumption) { r.consumption.enabled = !!n.consumption.enabled; r.consumption.max_l_per_100km = Math.max(1, +n.consumption.max_l_per_100km || r.consumption.max_l_per_100km); }
      fs.writeFileSync(RULES, JSON.stringify(r, null, 2)); cache.clear();
      return send(res, 200, 'application/json', JSON.stringify(r));
    }
    if (u.pathname === '/api/assess') {
      const from = u.searchParams.get('from') || '20261020', to = u.searchParams.get('to') || '20261109';
      if (!/^\d{8}$/.test(from) || !/^\d{8}$/.test(to)) return send(res, 400, 'application/json', '{"error":"from/to must be YYYYMMDD"}');
      const key = from + to + JSON.stringify(loadRules());
      if (!cache.has(key) || cache.get(key).t < Date.now() - 600000 || u.searchParams.get('refresh')) cache.set(key, { t: Date.now(), v: await run(from, to, loadRules()) });
      return send(res, 200, 'application/json', JSON.stringify(cache.get(key).v));
    }
    send(res, 404, 'text/plain', 'not found');
  } catch (e) { send(res, 500, 'application/json', JSON.stringify({ error: String(e.message) })); }
}).listen(PORT, '127.0.0.1', () => console.log('FleetYes sample on http://localhost:' + PORT));
module.exports = { run };
