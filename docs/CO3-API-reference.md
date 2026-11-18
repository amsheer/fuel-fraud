# CO3 API reference

Base URL: `https://openapi.co3.tech`
Token URL: `https://openapi.co3.tech/auth/token`
Auth: OAuth2 client credentials. Token expires in 360 seconds — refetch before each batch of calls.

Credentials are stored in `fuel-fraud-repo/.env` (`CO3_CLIENT_ID`, `CO3_CLIENT_SECRET`) — not repeated here.

Copy-paste credentials into Postman/curl rather than retyping — `0`/`O` and `1`/`l` look alike and cause silent auth failures.

---

## 1. Get token

| | |
|---|---|
| Method | `POST` |
| URL | `https://openapi.co3.tech/auth/token` |
| Auth | None |
| Headers | `Content-Type: application/x-www-form-urlencoded` |
| Body | `grant_type=client_credentials&client_id=<CLIENT_ID>&client_secret=<CLIENT_SECRET>` |

```bash
curl -s -X POST "https://openapi.co3.tech/auth/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials&client_id=<CLIENT_ID>&client_secret=<CLIENT_SECRET>"
```

Response: `access_token`, `expires_in` (360), `scope`. Save `access_token` as `$TOKEN`.

---

## 2. Onboard a vehicle

### 2a. Create onboarding
| | |
|---|---|
| Method | `POST` |
| URL | `https://openapi.co3.tech/api/assets/onboardings` |
| Auth | Bearer `$TOKEN` |
| Headers | `API-Version: 2.0`, `Content-Type: application/json` |
| Body | `{ "assets": [{ "assetIdentifier": "NU25DPO", "assetIdentifierType": "license-plate" }] }` |

```bash
curl -s -X POST "https://openapi.co3.tech/api/assets/onboardings" \
  -H "API-Version: 2.0" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"assets":[{"assetIdentifier":"NU25DPO","assetIdentifierType":"license-plate"}]}'
```
Returns `202` + `{ "data": { "id": "<onboarding-id>" } }`.

### 2b. Check batch status
| | |
|---|---|
| Method | `GET` |
| URL | `https://openapi.co3.tech/api/assets/onboardings/<onboarding-id>` |
| Auth | Bearer `$TOKEN` |
| Headers | `API-Version: 2.0` |

```bash
curl -s "https://openapi.co3.tech/api/assets/onboardings/$ONBOARD_ID" \
  -H "API-Version: 2.0" -H "Authorization: Bearer $TOKEN"
```
Status values seen: `PENDING`, `FAILED`.

### 2c. Check per-vehicle detail
| | |
|---|---|
| Method | `GET` |
| URL | `https://openapi.co3.tech/api/assets/onboardings/<onboarding-id>/details` |
| Auth | Bearer `$TOKEN` |
| Headers | `API-Version: 2.0` |

```bash
curl -s "https://openapi.co3.tech/api/assets/onboardings/$ONBOARD_ID/details" \
  -H "API-Version: 2.0" -H "Authorization: Bearer $TOKEN"
```
Note: batch status and per-vehicle detail can disagree (seen batch=`PENDING` while detail=`FAILED` for the same onboarding).

---

## 3. List onboarded vehicles

| | |
|---|---|
| Method | `GET` |
| URL | `https://openapi.co3.tech/api/assets?pageSize=100&page=1` |
| Auth | Bearer `$TOKEN` |
| Headers | `API-Version: 2.0` |

```bash
curl -s "https://openapi.co3.tech/api/assets?pageSize=100&page=1" \
  -H "API-Version: 2.0" -H "Authorization: Bearer $TOKEN"
```
Returns each vehicle's `id` (CO3 UUID), `assetIdentifiers` (vin, license-plate), `traceabilityStatus`.

---

## 4. Activate a subscription (required before reading tracking data)

| | |
|---|---|
| Method | `POST` |
| URL | `https://openapi.co3.tech/api/asset-subscriptions/subscriptions` |
| Auth | Bearer `$TOKEN` |
| Headers | `API-Version: 2.0`, `Content-Type: application/json` |
| Body | `{ "assetIdentifier": "NU25DPO", "assetIdentifierType": "license-plate", "modules": ["GPS_POSITION"] }` |

```bash
curl -s -X POST "https://openapi.co3.tech/api/asset-subscriptions/subscriptions" \
  -H "API-Version: 2.0" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"assetIdentifier":"NU25DPO","assetIdentifierType":"license-plate","modules":["GPS_POSITION"]}'
```
Modules: `GPS_POSITION`, `ETA_PREDICTION`, `CO2E_EMISSIONS`, `TEMPERATURE`, `TACHOGRAPH`. Requires `asset.subscriptions` scope and the feature enabled for the company (not yet confirmed enabled). Not yet run live — pending go-ahead, since it changes real account state.

## 5. Deactivate a subscription

Endpoint exists in CO3's docs nav ("Deactivate subscription") but its method/path haven't been read in detail yet.

---

## 6. Last known position / fuel / ignition

| | |
|---|---|
| Method | `GET` |
| URL | `https://openapi.co3.tech/api/trackings/perm/last-trace?assetIdentifier=<plate>&assetIdentifierType=license-plate&groups=position,engine,ignition` |
| Auth | Bearer `$TOKEN` |
| Headers | `API-Version: 2.0` |

```bash
curl -s "https://openapi.co3.tech/api/trackings/perm/last-trace?assetIdentifier=NU25DPO&assetIdentifierType=license-plate&groups=position,engine,ignition" \
  -H "API-Version: 2.0" -H "Authorization: Bearer $TOKEN"
```

`groups` options: `position`, `ignition`, `driver`, `telematics`, `engine`, `weight`, `trailer`, `reefer`.
`engine` group fields: `fuelLevel` (%), `fuelLevelInMilliliters`, `totalFuelUsed` (L), `mileage` (km), `wheelBasedSpeed`, `totalTime`.

Returns `404 ASSET_NOT_FOUND` until the vehicle has an active subscription (step 4) and is actually receiving data.

---

## 7. Historical position / fuel / ignition (time series)

| | |
|---|---|
| Method | `GET` |
| URL | `https://openapi.co3.tech/api/trackings/perm/historical-traces?assetIdentifier=<plate>&assetIdentifierType=license-plate&groups=position,engine,ignition&dateFrom=<ISO8601>&dateTo=<ISO8601>&pageSize=500&page=1` |
| Auth | Bearer `$TOKEN` |
| Headers | `API-Version: 2.0` |

```bash
curl -s "https://openapi.co3.tech/api/trackings/perm/historical-traces?assetIdentifier=NU25DPO&assetIdentifierType=license-plate&groups=position,engine,ignition&dateFrom=2026-11-01T00:00:00Z&dateTo=2026-11-18T00:00:00Z&pageSize=500&page=1" \
  -H "API-Version: 2.0" -H "Authorization: Bearer $TOKEN"
```

This is the call our fraud-check logic would use (equivalent to Geotab's FillUp + LogRecord + Trip combined). Defaults to last 24h if no dates given. Max `pageSize` 2000.

---

## Status as tested (2026-11-18)

| Step | Result |
|---|---|
| Token | Working |
| Onboard vehicle | Working — 8 of 10 fleet plates now listed in `GET /api/assets` |
| GPS connection (Geotab, via CO3 portal) | Created, status `Pending`, 0 devices integrated |
| `last-trace` for onboarded plate | `404 ASSET_NOT_FOUND` — blocked until a subscription is activated (step 4) |

## Open questions

- Does activating a `GPS_POSITION` subscription actually unblock `last-trace`/`historical-traces`? Not yet tried — needs go-ahead, it's a write action on the live account.
- Is the `asset.subscriptions` feature enabled for this CO3 account at all?
- Full details for the "Deactivate subscription" endpoint.
