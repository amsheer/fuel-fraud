// Replaces plates, cards, stations and transaction ids with stable labels, and drops coordinates and prices.
// Labels are keyed hashes (HMAC with a secret salt), so the same truck gets the same label on every request
// but the label cannot be turned back into the plate without the salt.
const crypto = require('crypto');
const PLATE = /\b(?:[A-Z]{2}\d{2} ?[A-Z]{3}|TRUCK ?\d+|SPARE ?\d+)\b/g; // UK plates and the placeholder plates seen in Shell data
const DEVICE = /AFP_[A-Z]+_Diesel_([A-Z0-9]+)/g;                          // Geotab device names end with the plate
const norm = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function anonymise(result, salt) {
  if (!salt) throw new Error('anonymise needs a salt');
  const tag = (kind, v) => kind + '-' + crypto.createHmac('sha256', salt).update(kind + '|' + v).digest('hex').slice(0, 4).toUpperCase();
  const cards = [...new Set(result.rows.map(r => String(r.card)))], sites = [...new Set(result.rows.map(r => String(r.siteCode)))];
  const plates = new Set(); // plates typed in Shell, even odd ones the pattern does not know
  result.rows.forEach(r => { if (r.plate) plates.add(norm(r.plate)); });
  const clean = s => {
    if (typeof s !== 'string') return s;
    s = s.replace(DEVICE, (m, p) => 'Truck ' + tag('VEH', norm(p))).replace(PLATE, m => tag('VEH', norm(m)));
    plates.forEach(p => { if (p.length > 3) s = s.replace(new RegExp(esc(p).split('').join(' ?'), 'g'), tag('VEH', p)); });
    cards.forEach(c => { s = s.replace(new RegExp('\\b' + esc(c) + '\\b', 'g'), tag('CARD', c)); });
    sites.forEach(c => { s = s.replace(new RegExp('(Station (?:code )?)' + esc(c) + '\\b', 'g'), '$1' + tag('S', c)); });
    return s;
  };
  const rows = result.rows.map(r => ({
    ...r, id: tag('T', r.id), plate: r.plate ? tag('VEH', norm(r.plate)) : '', vehicle: r.vehicle ? 'Truck ' + tag('VEH', norm(String(r.vehicle).split('_').pop())) : null,
    card: tag('CARD', String(r.card)), siteCode: tag('S', String(r.siteCode)), site: 'Station ' + tag('S', String(r.siteCode)),
    coords: null, price: null, odometerTyped: null, reason: clean(r.reason), signals: (r.signals || []).map(clean),
    likely: (r.likely || []).map(x => clean('AFP_X_Diesel_' + x)) }));
  return { ...result, rows, repeats: (result.repeats || []).map(x => ({ ...x, plate: x.plate ? tag('VEH', norm(x.plate)) : '', card: tag('CARD', String(x.card)) })), anonymised: true };
}
module.exports = { anonymise };
