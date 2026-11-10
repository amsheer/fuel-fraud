// Firebase entry point: the public, read-only API for the demo page (https://amsheer.github.io/fuel-fraud/).
// Keys are Firebase secrets (see README). The page calls this URL, so CORS allows only that origin.
const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { run, loadRules } = require('./app');
const { handle } = require('./publicApi');

const secrets = ['SHELL_CLIENT_ID', 'SHELL_CLIENT_SECRET', 'SHELL_PAYER_ID', 'SHELL_PAYER_NUMBER',
  'GEOTAB_DATABASE', 'GEOTAB_USER', 'GEOTAB_PASSWORD', 'ANON_SALT'].map(n => defineSecret(n));

// maxInstances keeps the bill and the load on Shell and Geotab small even if the link spreads.
exports.fuelApi = onRequest({ region: 'europe-west2', timeoutSeconds: 300, memory: '512MiB', maxInstances: 2, concurrency: 4,
  cors: ['https://amsheer.github.io'], secrets }, async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  const r = await handle(req.query, { run, rules: loadRules(), salt: process.env.ANON_SALT });
  res.set('Cache-Control', 'public, max-age=300');
  res.status(r.status).json(r.body);
});
