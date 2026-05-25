# GET `/v1/google-flow/accounts/captcha-providers`

Source: https://useapi.net/docs/api-google-flow-v1/get-google-flow-accounts-captcha-providers

Retrieves the captcha provider API keys currently configured on the useapi.net account, returned in **masked** form. When no providers are configured, returns the remaining free CapSolver credits balance instead.

This is the read-side companion to [`POST /v1/google-flow/accounts/captcha-providers`](./post-captcha-providers.md), which writes the provider configuration. For runtime performance/usage data on those configured providers, see [`GET /captcha-stats`](./get-captcha-stats.md).

---

## Endpoint

```
GET https://api.useapi.net/v1/google-flow/accounts/captcha-providers
```

## Authentication

Bearer token, obtained from useapi.net setup.

| Header          | Value                       | Required |
| --------------- | --------------------------- | -------- |
| `Authorization` | `Bearer {API token}`        | yes      |
| `Accept`        | `application/json`          | recommended |

## Request

- **Query parameters:** none
- **Path parameters:** none
- **Body:** none

---

## Response

### 200 OK — providers configured

Returns a JSON object whose keys are the names of configured providers. Each value is the configured API key, **masked** for security (only a prefix/suffix is shown, the middle is elided).

```json
{
  "CapSolver": "abc12…",
  "AntiCaptcha": "def34…"
}
```

### 200 OK — no providers configured

When the account has no captcha provider keys saved but still has remaining free CapSolver credits, the response is the credits balance instead of a provider map:

```json
{
  "freeCaptchaCredits": 100
}
```

`freeCaptchaCredits` is **only** present in this no-providers-configured state. As soon as any provider key is saved via POST, `freeCaptchaCredits` is dropped from the response.

### Response schema

```typescript
type GetCaptchaProvidersResponse = {
  CapSolver?: string;            // masked API key
  AntiCaptcha?: string;          // masked API key
  YesCaptcha?: string;           // masked API key
  CapMonster?: string;           // masked API key
  SolveCaptcha?: string;         // masked API key
  '2Captcha'?: string;           // masked API key
  EzCaptcha?: string;            // masked API key
  freeCaptchaCredits?: number;   // remaining free CapSolver credits;
                                 // present only when no provider keys configured
};
```

Notes on the schema:

- All provider-key fields are **optional** — only configured providers appear.
- The `2Captcha` key is a numeric-prefixed property name; in TypeScript/JS use bracket access (`response['2Captcha']`).
- `CapMonster` appears as a response field but is **not** writable via POST (the POST endpoint accepts the other six providers; CapMonster is included in the default solver order but its configuration path differs — see POST doc).

### Error responses

| Status | Body                          | Cause                                    |
| ------ | ----------------------------- | ---------------------------------------- |
| 401    | `{ "error": "Unauthorized" }` | Missing or invalid `Authorization` token |

---

## Status codes

| Code | Meaning |
| ---- | ------- |
| 200  | Success — masked provider keys, or free-credits balance if no providers configured |
| 401  | Invalid or missing API token |

---

## Examples

### curl

```bash
curl -H "Accept: application/json" \
     -H "Authorization: Bearer YOUR_API_TOKEN" \
     "https://api.useapi.net/v1/google-flow/accounts/captcha-providers"
```

### JavaScript (fetch)

```javascript
const response = await fetch(
  'https://api.useapi.net/v1/google-flow/accounts/captcha-providers',
  {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  },
);
const result = await response.json();
```

### Python (requests)

```python
import requests

response = requests.get(
    'https://api.useapi.net/v1/google-flow/accounts/captcha-providers',
    headers={'Authorization': f'Bearer {token}'},
)
```

---

## Implementation notes for HistForge

These are notes for wiring this endpoint into our Google Flow coordinator and Settings UI.

- **Read-only / safe to poll.** Returns masked keys, so it is safe to call from the dashboard to display current configuration state.
- **Detecting "no providers + no credits":** if the response is `{}` (empty object), neither providers nor `freeCaptchaCredits` are present — the account has no captcha capacity and Flow image/video requests requiring a captcha will fail until a provider is configured via POST.
- **Detecting "free tier":** presence of `freeCaptchaCredits` means **no** paid provider is configured; the value is the remaining count.
- **Mask format is opaque:** treat the returned string values as display-only. Do not attempt to reconstruct or validate the actual keys from the masked form — write through POST instead.
- **Source-of-truth coupling:** this endpoint reports useapi.net's state, not HistForge's. If we store provider keys in our own settings, they must be sync'd by replaying POST on changes; never trust the masked GET response as the canonical key value.

---

_Source page last updated: December 23, 2025 (revised February 18, 2026)._
