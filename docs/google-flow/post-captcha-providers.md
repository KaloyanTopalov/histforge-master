# POST `/v1/google-flow/accounts/captcha-providers`

Source: https://useapi.net/docs/api-google-flow-v1/post-google-flow-accounts-captcha-providers

Configures the captcha-solving providers used by useapi.net when Google Flow image/video generation triggers a reCAPTCHA v3 Enterprise challenge. useapi.net automatically forwards each challenge to the configured third-party solver(s) and submits the resulting token on the user's behalf — the caller never sees the captcha directly.

This is the write-side companion to [`GET /v1/google-flow/accounts/captcha-providers`](./get-captcha-providers.md). For runtime performance/usage data on the configured providers, see [`GET /captcha-stats`](./get-captcha-stats.md).

---

## Endpoint

```
POST https://api.useapi.net/v1/google-flow/accounts/captcha-providers
```

## Authentication

Bearer token, obtained from useapi.net setup.

| Header          | Value                                                        | Required |
| --------------- | ------------------------------------------------------------ | -------- |
| `Authorization` | `Bearer {API token}`                                         | yes      |
| `Content-Type`  | `application/json` **or** `multipart/form-data`              | yes      |

## Request

- **Query parameters:** none
- **Path parameters:** none

### Body schema

All fields are **optional**. Include only the providers you want to set or clear. Omitted providers are left unchanged.

| Field          | Type   | Description |
| -------------- | ------ | ----------- |
| `CapSolver`    | string | API key from [capsolver.com](https://capsolver.com). Promo code `useapi` gives 8% discount. |
| `AntiCaptcha`  | string | API key from [anti-captcha.com](https://anti-captcha.com). |
| `YesCaptcha`   | string | API key from [yescaptcha.com](https://yescaptcha.com). |
| `SolveCaptcha` | string | API key from [solvecaptcha.com](https://solvecaptcha.com). |
| `2Captcha`     | string | API key from [2captcha.com](https://2captcha.com). |
| `EzCaptcha`    | string | API key from [ez-captcha.com](https://ez-captcha.com). |

Special values:

- **Empty string (`""`)** — removes that provider from the configuration.
- **Field omitted** — leaves the existing value for that provider unchanged.

Free-tier behavior:

- Each useapi.net account gets **100 free CapSolver credits** on its first Google Flow account.
- After free credits are exhausted, **at least one provider key must be configured**, otherwise Flow generations that require a captcha will fail.

> Note: although the GET response can include a `CapMonster` field, `CapMonster` is **not** a writable key on this POST endpoint. The body schema above lists every writable provider.

---

## Response

### 200 OK — providers configured

Returns the current provider map with **masked** API keys. The shape mirrors `GET /captcha-providers` exactly.

```json
{
  "CapSolver": "abc...***...xyz",
  "AntiCaptcha": "def...***...uvw"
}
```

### 200 OK — all providers cleared (free credits remain)

If the resulting configuration has no provider keys but free credits remain:

```json
{
  "freeCaptchaCredits": 100
}
```

### Response schema

```typescript
type PostCaptchaProvidersResponse = {
  CapSolver?: string;            // masked
  AntiCaptcha?: string;          // masked
  YesCaptcha?: string;           // masked
  CapMonster?: string;           // masked (read-only field)
  SolveCaptcha?: string;         // masked
  '2Captcha'?: string;           // masked
  EzCaptcha?: string;            // masked
  freeCaptchaCredits?: number;   // present only when no provider keys configured
};
```

### Error responses

| Status | Cause                                                   |
| ------ | ------------------------------------------------------- |
| 400    | Bad Request — an invalid provider name was specified in the body. |
| 401    | Unauthorized — missing or invalid API token.            |

---

## Status codes

| Code | Meaning |
| ---- | ------- |
| 200  | Success — masked keys for the resulting provider configuration, or `freeCaptchaCredits` if no providers remain configured. |
| 400  | Body contained an unknown provider field. |
| 401  | Invalid or missing API token. |

---

## Supported captcha providers

useapi.net solves the captcha by forwarding the challenge to one of the third-party services below. Costs, latencies, and "reports back" behaviors are useapi.net's published guidance (your mileage may vary by region/load).

| Provider       | ~Cost / 1K solves | ~Solve time   | Reports failures back to provider | Site                                |
| -------------- | ----------------- | ------------- | --------------------------------- | ----------------------------------- |
| CapSolver      | ~$3.00            | ~8–12 s       | Yes                               | [capsolver.com](https://capsolver.com)       |
| AntiCaptcha    | ~$2.00            | ~8–12 s       | Yes                               | [anti-captcha.com](https://anti-captcha.com) |
| YesCaptcha     | varies            | ~8–12 s       | No                                | [yescaptcha.com](https://yescaptcha.com)     |
| SolveCaptcha   | ~$0.80            | ~30–60 s ⚠️    | Yes                               | [solvecaptcha.com](https://solvecaptcha.com) |
| 2Captcha       | ~$2.99            | ~30–60 s ⚠️    | Yes                               | [2captcha.com](https://2captcha.com)         |
| EzCaptcha      | ~$2.50            | ~8–12 s       | No                                | [ez-captcha.com](https://ez-captcha.com)     |

⚠️ SolveCaptcha and 2Captcha have noticeably longer solve times — useapi.net's guidance is to use them as **fallback** providers, not primary.

### Default solver order

When the caller does not specify `captchaOrder` (see below), useapi.net cycles through providers in this fixed sequence:

```
CapSolver → AntiCaptcha → YesCaptcha → CapMonster → SolveCaptcha → 2Captcha → EzCaptcha
```

Only providers with a configured key participate; the rest are skipped.

---

## Captcha-related parameters on generation endpoints

These configuration keys are stored once on the account. Each individual generation request can additionally pass one of the following **mutually exclusive** parameters to control captcha behavior for that call. They are accepted on:

- `POST /v1/google-flow/images`
- `POST /v1/google-flow/images/upscale`
- `POST /v1/google-flow/videos`
- `POST /v1/google-flow/videos/upscale`
- `POST /v1/google-flow/videos/extend`

| Parameter      | Type   | Notes |
| -------------- | ------ | ----- |
| `captchaToken` | string | A pre-solved reCAPTCHA token supplied by the caller. **Single attempt, no retry.** If the token is rejected, the request fails immediately. |
| `captchaRetry` | number (1–10, default **3**) | Number of solve attempts cycling through the configured providers in `captchaOrder` (or the default order). |
| `captchaOrder` | string | Comma-separated provider sequence (max 10 entries) overriding the default solve order, e.g. `"CapSolver,AntiCaptcha,EzCaptcha"`. |

Only one of `captchaToken` / `captchaRetry` / `captchaOrder` may be supplied per request.

---

## Examples

### curl

```bash
curl -X POST "https://api.useapi.net/v1/google-flow/accounts/captcha-providers" \
  -H "Authorization: Bearer YOUR_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "AntiCaptcha": "<your AntiCaptcha API key>",
    "CapSolver": "<your CapSolver API key>"
  }'
```

### Example response (200 OK)

```json
{
  "CapSolver": "abc...***...xyz",
  "AntiCaptcha": "def...***...uvw"
}
```

### After removing every provider (and credits remain)

```json
{
  "freeCaptchaCredits": 100
}
```

### JavaScript (fetch)

```javascript
const response = await fetch(
  'https://api.useapi.net/v1/google-flow/accounts/captcha-providers',
  {
    method: 'POST',
    headers: {
      Authorization: `Bearer YOUR_API_TOKEN`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      AntiCaptcha: '<your AntiCaptcha API key>',
      CapSolver: '<your CapSolver API key>',
    }),
  },
);

const result = await response.json();
console.log('Captcha providers configured:', result);
```

### Python (requests)

```python
import requests

url = 'https://api.useapi.net/v1/google-flow/accounts/captcha-providers'
headers = {
    'Authorization': 'Bearer YOUR_API_TOKEN',
    'Content-Type': 'application/json',
}
body = {
    'AntiCaptcha': '<your AntiCaptcha API key>',
    'CapSolver': '<your CapSolver API key>',
}

response = requests.post(url, headers=headers, json=body)
print(response.status_code, response.json())
```

### Clearing a single provider

Send an empty string for the provider to remove:

```json
{
  "EzCaptcha": ""
}
```

---

## Implementation notes for HistForge

Notes for wiring this endpoint into our Google Flow coordinator, Settings > Google Flow UI, and the per-request captcha policy on `lib/flow-*` providers.

- **Persistence on useapi.net side.** The configured keys live on the useapi.net account; we do **not** need to send them per generation request. Configure once at setup, re-POST only when keys rotate.
- **Storage on our side.** If we persist provider keys in HistForge settings (so we can re-apply them after a useapi.net reset), store them as opaque secrets. The masked values returned from this endpoint are display-only and cannot be round-tripped back.
- **Choosing a default `captchaOrder`.** The published default order favors fast solvers first (CapSolver, AntiCaptcha, YesCaptcha, CapMonster), then the slow fallbacks (SolveCaptcha, 2Captcha, EzCaptcha). For latency-sensitive video generation we should generally keep the slow ones at the end of `captchaOrder`, matching the published default.
- **Free-credit transition.** New accounts have 100 free CapSolver credits. Settings UI should show "Free credits remaining: N" (from GET response's `freeCaptchaCredits`) and warn before they run out — once exhausted, image/video generation fails with a captcha error until at least one provider is configured.
- **`CapMonster` is read-only here.** Even though it appears in the default solver order and the GET response, this POST endpoint does not accept it. If users want CapMonster configured, that goes through a different setup path (not covered by this endpoint).
- **Errors are sticky per-request, not global.** A 400 means our body had a bad field name (likely a typo or an unsupported provider like `capmonster`). Validate field names against the allowed set on the client side before sending.

---

_Source page last updated alongside the GET endpoint (Dec 2025 / Feb 2026 revision)._
