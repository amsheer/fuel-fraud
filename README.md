# fuel-fraud
Sample system that checks Shell fuel-card purchases against Geotab telematics. Read-only against both APIs.

Demo (anonymised sample data, no keys): https://amsheer.github.io/fuel-fraud/ . Scenario guide: https://amsheer.github.io/fuel-fraud/scenarios.html

## Run
1. Copy `.env.example` to `.env` and fill in the Shell and Geotab values (never commit `.env`).
2. `node app.js` (Node 18 or newer), then open http://localhost:8800 and press **Check purchases** (a 40-day period takes about 1 to 2 minutes). The pages are in `docs/`; without the server, `docs/index.html` shows the anonymised sample in `docs/demo-data.json`.
3. `node engine.test.js` runs the decision-logic checks (no network).

## How a purchase is checked
1. Diesel lines of one Shell transaction are added together; AdBlue is skipped.
2. Partner rules in `rules.json` (city boundary, approved stations) are applied first.
3. The vehicle is found by plate, then card history, then who was at the station (GPS).
4. Litres bought are compared with the Geotab tank-level rise times the truck's tank size
   (learned from the truck's own purchases unless `tank_litres` is set). The allowed gap is `tolerance` in `rules.json`.
5. Without fuel data: a truck stopped at the station is "Partly verified"; a truck elsewhere with no other fleet truck there is "Suspected".

Values in `rules.json` are samples. Use `plate_overrides` for a plate typed wrongly for a tracked truck, for example `{"AB12CDE": "AB12CDF"}`.
