// Run: node engine.test.js   (checks the decision logic with made-up purchases; no network)
const assert = require('assert'), L = require('./lib');
const dev = { id: 'b1', name: 'AFP_MAN_Diesel_AB12CDE' }, dev2 = { id: 'b2', name: 'AFP_DAF_Diesel_ZZ99ZZZ' };
const tx = (o = {}) => ({ TransactionId: 'T1', Quantity: 100, VehicleRegistration: 'AB12 CDE', CardId: 7, SiteCode: '1001', lat: 52, lon: -1, ...o });
const ctx = (o = {}) => ({ byPlate: { AB12CDE: dev }, cardMap: {}, nearby: [], distanceKm: null, fillFor: () => ({ litres: 100 }), ...o });
const R = { city_boundary: { enabled: false }, approved_stations: { enabled: false } };
const out = (t, c, r = R) => L.assess(t, c, r).outcome;

assert.equal(out(tx(), ctx()), 'supported');                                              // litres match
assert.equal(out(tx({ Quantity: 100 }), ctx({ fillFor: () => ({ litres: 50 }) })), 'quantity'); // 50 L unexplained
assert.equal(out(tx({ Quantity: 100 }), ctx({ fillFor: () => ({ litres: 90 }) })), 'supported'); // 10 L is inside 15 L
assert.equal(out(tx(), ctx({ fillFor: () => null })), 'insufficient');
assert.equal(out(tx(), ctx({ fillFor: () => ({ noCap: true, what: 'x' }) })), 'insufficient');       // fill seen but tank size unknown                    // no fuel data
assert.equal(out(tx({ VehicleRegistration: 'TRUCK 1' }), ctx()), 'unidentified');         // plate not in Geotab
assert.equal(out(tx({ VehicleRegistration: '' }), ctx()), 'unidentified');                 // blank plate
assert.equal(out(tx({ VehicleRegistration: 'TRUCK 1' }), ctx({ cardMap: { 7: dev } })), 'supported'); // card history rescues it
assert.equal(out(tx({ VehicleRegistration: 'X' }), ctx({ nearby: [dev, dev2] })), 'ambiguous');       // two vehicles at station
assert.equal(out(tx({ VehicleRegistration: 'X' }), ctx({ nearby: [dev] })), 'supported');               // one vehicle, litres match
assert.equal(out(tx({ VehicleRegistration: 'X' }), ctx({ nearby: [dev], fillFor: () => ({ litres: 10 }) })), 'ambiguous'); // guess + mismatch goes to review
assert.equal(out(tx(), ctx(), { ...R, approved_stations: { enabled: true, site_codes: ['2002'] } }), 'policy');   // station not approved
assert.equal(out(tx(), ctx(), { ...R, approved_stations: { enabled: true, site_codes: ['1001'] } }), 'supported');
assert.equal(out(tx({ lat: 55, lon: -4 }), ctx(), { ...R, city_boundary: { enabled: true, centre: { lat: 52, lon: -1 }, radius_km: 50 } }), 'policy'); // far from depot
assert.equal(L.purchaseUtc({ TransactionDate: '20261023', TransactionTime: '01:42:58', UTCOffset: '+01:00:00' }).toISOString(), '2026-10-23T00:42:58.000Z');
assert.deepEqual(L.consumption(270, 100, 60), { lPer100: 270, flag: true });   // 270 L for 100 km: too much
assert.deepEqual(L.consumption(270, 700, 60), { lPer100: 38.6, flag: false }); // normal lorry use
assert.equal(L.consumption(270, 0, 60).flag, true);                            // bought fuel, did not move
assert.equal(L.consumption(270, null, 60), null);                              // no trip data, no opinion
// --- where the truck was (no litres evidence)
const pt = (min, lat, speed = 0) => ({ latitude: lat, longitude: -1, speed, dateTime: new Date(Date.UTC(2026, 9, 1, 12, min)).toISOString() });
const T0 = Date.UTC(2026, 9, 1, 12, 10);
assert.equal(L.presence([pt(8, 52), pt(12, 52)], 52, -1, T0).stoppedHere, true);                  // stopped at the pump
assert.equal(L.presence([pt(8, 52, 60)], 52, -1, T0).stoppedHere, false);                         // driving past
const T1 = Date.UTC(2026, 9, 1, 12, 40);
assert.equal(L.presence([pt(20, 53), pt(60, 53)], 52, -1, T1).posKnown, true);                    // parked elsewhere before and after
assert.equal(L.presence([pt(20, 53), pt(60, 52.5)], 52, -1, T1).posKnown, false);                 // moved in between, so unknown
assert.equal(L.presence([], 52, -1, T0).closestKm, null);
const noFill = { fillFor: () => null };
const here = L.presence([pt(10, 52)], 52, -1, T0), away = L.presence([pt(10, 53)], 52, -1, T0);
assert.equal(out(tx(), ctx({ ...noFill, presence: here })), 'partly');                           // at the pump, no fuel sensor
assert.equal(out(tx(), ctx({ ...noFill, presence: here, hasSensor: () => true })), 'ambiguous'); // sensor saw no refuel
assert.equal(out(tx(), ctx({ ...noFill, presence: away })), 'suspect');                          // truck 111 km away, nobody else there
assert.equal(out(tx(), ctx({ ...noFill, presence: away, atStation: [dev2] })), 'ambiguous');     // another truck was there
assert.equal(out(tx(), ctx({ ...noFill })), 'insufficient');                                     // no GPS at all
assert.equal(out(tx(), ctx({ fillFor: () => ({ noCap: true, what: 'x' }), presence: here })), 'insufficient'); // sensor truck, tank size unknown
assert.equal(L.assess(tx({ VehicleRegistration: 'X' }), ctx({ atStation: [dev2] }), R).likely[0], 'ZZ99ZZZ');  // names who was at the station
assert.equal(out(tx(), ctx({ fillFor: () => ({ litres: 50, spread: 1.4, capRange: '360 to 505 L' }) })), 'ambiguous');  // noisy level sensor: not conclusive
assert.equal(out(tx(), ctx({ fillFor: () => ({ litres: 50, spread: 1.05 }) })), 'quantity');                         // steady sensor: still an exception
assert.equal(out(tx({ VehicleRegistration: 'X' }), ctx({ nearby: [dev], fillFor: () => null, presence: here })), 'unidentified'); // guess + no litres: not partly verified
// --- anonymiser: no plate, card, station or coordinate may survive, labels are stable, same truck = same label
const { anonymise } = require('./anonymise');
const fake = { rows: [{ id: 'T9X', plate: 'QX12 RSZ', vehicle: 'AFP_MAN_Diesel_QX12RSZ', card: 4518725, siteCode: '2340', site: 'SHELL EXAMPLE SITE', coords: [52.7, -1.3], price: 1.5, odometerTyped: 123456,
  reason: 'AFP_MAN_Diesel_QX12RSZ was stopped at the station. Card 4518725 at Station code 2340 near XY99TWZ.', signals: ['Fleet ID typed at the pump is QR12STU, but the card\'s vehicle is QX12 RSZ'], likely: ['LM34NPZ'] }], repeats: [{ plate: 'QX12 RSZ', card: 4518725, litres: 50, times: 3 }] };
const a1 = JSON.stringify(anonymise(fake, 'salt1')), a2 = JSON.stringify(anonymise(fake, 'salt1')), a3 = JSON.stringify(anonymise(fake, 'salt2'));
['QX12', 'RSZ', 'XY99', 'TWZ', 'QR12', 'LM34', '4518725', '2340', 'SHELL EXAMPLE', '52.7', '123456', 'AFP_'].forEach(s => assert.ok(!a1.includes(s), 'leaked ' + s));
assert.equal(a1, a2);                    // stable for one salt
assert.notEqual(a1, a3);                 // different salt, different labels
const A = JSON.parse(a1).rows[0];
assert.equal(A.vehicle, 'Truck ' + A.plate);                      // plate typed and device name give the same label
assert.ok(A.reason.includes(A.plate) && A.reason.includes(A.card)); // labels are used inside the sentences
assert.equal(A.coords, null);
console.log('all checks passed');
