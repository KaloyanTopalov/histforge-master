# GET `/v1/google-flow/accounts/captcha-stats`

Source: https://useapi.net/docs/api-google-flow-v1/get-google-flow-accounts-captcha-stats

Returns captcha-solving statistics for the account: per-call records (timestamps, provider used, status code, retry count, durations) plus an aggregated `summary` block (success rate by provider, average solve/API latency, status-code distribution split between image and video routes).

Companion to the configuration endpoints — [`GET /captcha-providers`](./get-captcha-providers.md) reports *what is configured*, this endpoint reports *how it has been performing*.

---

## Endpoint

```
GET https://api.useapi.net/v1/google-flow/accounts/captcha-stats
```

## Authentication

Bearer token, obtained from useapi.net setup.

| Header          | Value                | Required |
| --------------- | -------------------- | -------- |
| `Authorization` | `Bearer {API token}` | yes      |

## Request

- **Path parameters:** none
- **Body:** none

### Query parameters

| Parameter    | Required | Type                          | Description |
| ------------ | -------- | ----------------------------- | ----------- |
| `date`       | no       | string (`YYYY-MM-DD`)         | Restrict to a single UTC date. Defaults to **today** when `limit` is not supplied. |
| `limit`      | no       | number (max **50000**)        | Return the last N records across all dates. When supplied, `date` is **ignored**. |
| `provider`   | no       | string enum                   | Restrict to one provider. Allowed: `CapSolver`, `AntiCaptcha`, `YesCaptcha`, `CapMonster`, `SolveCaptcha`, `2Captcha`, `EzCaptcha`, `UserProvided`. (`UserProvided` corresponds to requests that passed a pre-solved `captchaToken`.) |
| `anonymized` | no       | boolean                       | When `true`, returns an aggregated summary across **all users**, using the last 5000 records globally. Ignores `date` / `limit` / `provider`. Returns the `summary` block only — **no individual `data` rows**. |

---

## Response

### 200 OK

```json
{
  "date": "2026-02-03",
  "limit": 50000,
  "provider": "AntiCaptcha",
  "total": 42,
  "summary": {
    "from": "2026-02-03T00:05:23.000Z",
    "to": "2026-02-03T23:58:47.000Z",
    "time_span": "23 hours 53 minutes",
    "sample_size_by_provider": {
      "CapSolver": 24,
      "AntiCaptcha": 10,
      "EzCaptcha": 8
    },
    "success_rate_by_provider": {
      "CapSolver": 97.50,
      "AntiCaptcha": 96.67,
      "EzCaptcha": 91.67
    },
    "by_status_code_images": {
      "200": 85.71,
      "403": 14.29
    },
    "by_status_code_videos": {
      "200": 94.29,
      "403": 5.71
    },
    "avg_captcha_ms": 8500,
    "avg_api_ms": 1200,
    "avg_attempt": 1.2
  },
  "data": [
    {
      "timestamp": "2026-02-03T10:30:00.000Z",
      "jobId": "20260203103000123-user:123-bot:google-flow",
      "provider": "AntiCaptcha",
      "taskId": "abc123-task-id",
      "route": "post-videos",
      "statusText": "OK",
      "pageAction": "VIDEO_GENERATION",
      "error": "",
      "statusCode": 200,
      "captchaDurationMs": 8500,
      "apiDurationMs": 1200,
      "attemptNumber": 1
    }
  ]
}
```

### Top-level fields

| Field      | Type   | Description |
| ---------- | ------ | ----------- |
| `date`     | string | The `date` filter that was applied (`YYYY-MM-DD`). |
| `limit`    | number | The `limit` filter that was applied. |
| `provider` | string | The `provider` filter that was applied. |
| `total`    | number | Number of records returned in `data[]` after filtering. |
| `summary`  | object | Aggregated rollup over the same filtered set. **Omitted entirely when no records match the filters.** |
| `data`     | array  | Per-call records. Empty in `anonymized=true` mode. |

### `summary` fields

| Field                       | Type                        | Description |
| --------------------------- | --------------------------- | ----------- |
| `from`                      | string (ISO 8601)           | Earliest record timestamp in the filtered set. |
| `to`                        | string (ISO 8601)           | Latest record timestamp in the filtered set. |
| `time_span`                 | string                      | Human-readable span between `from` and `to` (e.g., `"2 days 5 hours"`). |
| `sample_size_by_provider`   | object<string, number>      | Record count per provider. **Excludes HTTP 503 responses.** |
| `success_rate_by_provider`  | object<string, number>      | Success percentage (0–100) per provider. **Excludes HTTP 503 responses.** |
| `by_status_code_images`     | object<string, number>      | Percentage distribution of HTTP status codes across `IMAGE_GENERATION` calls (keys are stringified codes like `"200"`, `"403"`). |
| `by_status_code_videos`     | object<string, number>      | Same as above for `VIDEO_GENERATION` calls. |
| `avg_captcha_ms`            | number                      | Average captcha solve duration (ms) across the filtered set. |
| `avg_api_ms`                | number                      | Average Flow API call duration (ms) across the filtered set. |
| `avg_attempt`               | number                      | Average attempt number across the filtered set (1.0 = no retries needed; higher values mean retries happened). |

### `data[]` record fields

| Field               | Type   | Description |
| ------------------- | ------ | ----------- |
| `timestamp`         | string (ISO 8601) | When this captcha attempt happened. |
| `jobId`             | string | Unique job identifier — format `{YYYYMMDDHHmmssSSS}-user:{userId}-bot:google-flow`. Useful for correlating with our worker logs. |
| `provider`          | string | Which provider was used (`CapSolver`, `AntiCaptcha`, …, or `UserProvided`). |
| `taskId`            | string | Provider-side task ID — opaque to us, useful for opening tickets with the captcha vendor. |
| `route`             | string | Flow API route invoked: `post-images`, `post-videos`, `post-videos-upscale`, `post-videos-extend`, etc. |
| `statusText`        | string | HTTP status text (`OK`, `Forbidden`, `NetworkError`). |
| `pageAction`        | string | reCAPTCHA action label (`IMAGE_GENERATION`, `VIDEO_GENERATION`). |
| `error`             | string | Error message; **empty string on success**. |
| `statusCode`        | number | HTTP status code returned by Flow. `0` indicates a network error (no HTTP response received). |
| `captchaDurationMs` | number | Time spent solving the captcha (ms). |
| `apiDurationMs`     | number | Time spent on the Flow API call (ms). |
| `attemptNumber`     | number | 1 = initial attempt, 2+ = retry within the same Flow request. |

### Error responses

| Status | Body                          | Cause                                   |
| ------ | ----------------------------- | --------------------------------------- |
| 400    | `{ "error": "<message>" }`    | Invalid query parameter (bad date, unknown provider name, limit out of range, …). |
| 401    | `{ "error": "Unauthorized" }` | Missing or invalid `Authorization` token. |

---

## Status codes

| Code | Meaning |
| ---- | ------- |
| 200  | Success — statistics returned (possibly with empty `data` / omitted `summary` if no records match). |
| 400  | Invalid or missing query parameters; response body includes an `error` string. |
| 401  | Invalid or missing API token. |

---

## Behavior, freshness, retention

- **Latency from event to stats:** minimum 5 minutes, should not exceed 15 minutes — do **not** poll this endpoint immediately after a Flow call expecting the record to be present.
- **Retention:** records are kept for **3 months**.
- **Response caching:** server-side cached for **5 minutes** — repeated calls within that window return identical data.
- **`summary` omission:** if no records match the filters, `summary` is omitted from the response entirely (rather than being returned as an empty object).
- **`anonymized` mode:** uses the last 5000 records across all useapi.net accounts; useful as a community-wide baseline. Returns the `summary` block only — `data[]` is not populated.
- **503 exclusion:** `sample_size_by_provider` and `success_rate_by_provider` ignore HTTP 503 responses (treated as transient/server-side, not provider-attributable).

---

## Examples

### curl

```bash
# Today's statistics (default)
curl -H "Authorization: Bearer YOUR_API_TOKEN" \
     "https://api.useapi.net/v1/google-flow/accounts/captcha-stats"

# A specific date
curl -H "Authorization: Bearer YOUR_API_TOKEN" \
     "https://api.useapi.net/v1/google-flow/accounts/captcha-stats?date=2026-02-01"

# Last 1000 records across all dates
curl -H "Authorization: Bearer YOUR_API_TOKEN" \
     "https://api.useapi.net/v1/google-flow/accounts/captcha-stats?limit=1000"

# Filter by provider
curl -H "Authorization: Bearer YOUR_API_TOKEN" \
     "https://api.useapi.net/v1/google-flow/accounts/captcha-stats?provider=AntiCaptcha"

# Anonymized rollup across all users
curl -H "Authorization: Bearer YOUR_API_TOKEN" \
     "https://api.useapi.net/v1/google-flow/accounts/captcha-stats?anonymized=true"
```

### JavaScript (fetch)

```javascript
const apiUrl = 'https://api.useapi.net/v1/google-flow/accounts/captcha-stats';
const token = 'YOUR_API_TOKEN';

const response = await fetch(apiUrl, {
  headers: { Authorization: `Bearer ${token}` },
});

const stats = await response.json();
console.log(`Total records: ${stats.total}`);
console.log('Success rates:', stats.summary?.success_rate_by_provider);
console.log('Data:', stats.data);
```

### Python (requests)

```python
import requests

api_url = 'https://api.useapi.net/v1/google-flow/accounts/captcha-stats'
token = 'YOUR_API_TOKEN'
headers = {'Authorization': f'Bearer {token}'}

# Today's stats
response = requests.get(api_url, headers=headers)
stats = response.json()
print(f"Total records: {stats['total']}")
print(f"Success rates: {stats.get('summary', {}).get('success_rate_by_provider')}")

# Filter by provider
response = requests.get(
    api_url,
    params={'provider': 'AntiCaptcha'},
    headers=headers,
)
```

---

## Implementation notes for HistForge

Notes for wiring this endpoint into our Google Flow coordinator, Settings > Google Flow UI, and the per-request captcha policy.

- **Settings UI panel.** Render the `summary` block on Settings > Google Flow next to the configured keys: a small table of provider → success rate (last 24h) + sample size, plus `avg_captcha_ms`. If a configured provider shows 0 samples while others have many, the key is likely either misconfigured or down — flag it visually.
- **Dynamic `captchaOrder`.** Periodically (e.g., once per worker boot, or once per N video runs) pull stats with `provider` unset and a recent `limit`, then build `captchaOrder` sorted by `success_rate_by_provider` descending, tiebreaker `avg_captcha_ms` ascending. This adapts to provider degradation without us hardcoding the static default order.
- **Anonymized fallback.** On a brand-new account or after a long quiet period, our own `sample_size_by_provider` will be small and noisy. Fall back to `anonymized=true` to get a community-wide ordering until our own sample is large enough (e.g., ≥ 50 records per provider).
- **Failure correlation.** When a Flow generation fails with a captcha-related error (HTTP 403 from the Flow side, or our own captcha-retry exhaustion), record the timestamp + Flow `jobId` we got back, then fetch this endpoint with a tight `date` filter to retrieve the matching `data[]` row and surface `provider`, `attemptNumber`, and `error` in our worker logs. Don't query immediately — wait at least 5 minutes for the record to land (see latency note above).
- **Don't poll hot.** 5-minute server cache means anything below a 5-minute polling interval is wasted. A periodic fetch (e.g., every 10–15 minutes for the dashboard, once on demand for debug correlation) is plenty.
- **Cost tracking.** Multiply `sample_size_by_provider` by per-provider per-1000 cost (see [`post-captcha-providers.md`](./post-captcha-providers.md) cost table) to get a rough daily spend estimate per provider. Useful for the Settings UI cost panel.
- **`UserProvided` provider.** If we ever pass a pre-solved `captchaToken` on a generation request, it shows up in stats under `provider: "UserProvided"`. Distinguish it from third-party-solved records when building cost/health views.
- **Retention is 3 months.** If we want longer history (trend graphs over quarters), we have to snapshot these responses into our own SQLite — they won't be reachable on the upstream after 90 days.

---

_Source page references the same Dec 2025 / Feb 2026 documentation revision as the providers endpoints._
