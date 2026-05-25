# Suno sidecar

Python sidecar that mediates between AmbientForge's Node bridge and Suno's
direct API. Replaces the Chrome-extension content-script approach.

## Architecture

```
Node bridge (extensions/suno-runner/bridge.ts, port 7341)
  └─ child_process.spawn('python', ['sidecars/suno/sidecar.py'])
       └─ JSON-RPC over stdio
            └─ imports SunoAuth / SunoDirectClient from vendored suno_client.py
                 └─ POST https://studio-api.prod.suno.com/api/generate/v2-web/
                 └─ Chrome at --remote-debugging-port=9333 (for hCaptcha)
```

## Operator setup

1. **Install Python deps:**
   ```
   pip install -r sidecars/suno/requirements.txt
   ```
   The vendored client (`suno_client.py`) needs only `requests` (already in
   requirements.txt) — no external-project deps, no `SUNO_BOT_PATH`.

2. **Login to Suno:** `npm run suno:login`. This launches a dedicated Chrome
   profile at `data/suno-profile/chrome/` with `--remote-debugging-port=9333`,
   prompts you to log in, then captures the session cookie to
   `data/suno-profile/.env` as `SUNO_COOKIE=...`. Leave the Chrome window
   open during dev sessions — the sidecar uses it to solve hCaptcha
   inline via CDP.

3. **Run AmbientForge:** `npm run dev`. The bridge spawns the sidecar
   automatically. On crash, the bridge respawns it with backoff.

## RPC methods

One JSON object per line on stdin/stdout. Stderr is logs.

| method | params | result |
|---|---|---|
| `submit` | `{model, mode, stylePrompt, lyrics?, title?, instrumental, personaId?}` | `{taskId, clipIds: [a, b]}` |
| `poll` | `{taskId}` | `{status: 'pending'\|'ready'\|'failed', clips, error?}` |
| `download_wav` | `{taskId}` | `{path, bytes}` |
| `credits` | `{}` | `{credits: number}` |
| `auth_status` | `{}` | `{cookieValid}` |

Errors: `{id, error: {code, message}}` where `code` is one of
`SUNO_AUTH`, `SUNO_CAPTCHA`, `SUNO_DOWNLOAD_FAILED`, `SUNO_BRIDGE_ERROR`,
`PERSONA_PAYLOAD_NOT_CAPTURED`, `INVALID_MODE`, `UNKNOWN_TASK`,
`SIDECAR_INTERNAL`, `BAD_REQUEST`, `UNKNOWN_METHOD`.

## Modes

- `custom` — Suno's "explicit lyrics" mode. Body: `{prompt: lyrics, tags: stylePrompt, title, mv: model, make_instrumental}`.
- `description` — Suno writes the lyrics. Body: `{gpt_description_prompt: stylePrompt, mv: model, make_instrumental}`.
- `persona` — pending. Schema and dispatch are wired; the sidecar fails fast
  with `PERSONA_PAYLOAD_NOT_CAPTURED` until the request body is captured
  from suno.com's network tab and added to `handle_submit`.

## Limitations / TODOs

- Vendoring: **DONE.** `SunoAuth` + `SunoDirectClient` are vendored in
  `suno_client.py` and `BrowserCaptchaSolver` in `captcha.py` (both extracted
  from RAP SUNO's `suno_bot.py`). No `SUNO_BOT_PATH` dependency. If Suno's
  internal API drifts and the upstream `suno_bot.py` changes, re-copy the
  affected class bodies into `suno_client.py` / `captcha.py`.
- Captcha fallback (2captcha API) is not wired. Browser-CDP is the only path.
- WAV download uses `client._session` (the underlying requests.Session).
  Suno's auth refresh is automatic via `SunoAuth.get_token()`; if they ever
  decouple wav-fetching auth, we'll need a small adapter.
