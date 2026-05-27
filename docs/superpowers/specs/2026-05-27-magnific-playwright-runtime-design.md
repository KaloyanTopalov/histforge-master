# Design: HistForge-managed Playwright Chromium runtime for magnific-ext

**Date:** 2026-05-27
**Author:** design session (Claude + user)
**Status:** Pending implementation plan
**Related skill:** `domain-magnific-coordinator`
**Related spec:** `2026-05-27-magnific-narrative-image-generation-design.md` (the narrative provider that consumes this runtime)
**Branch base:** `master` (post-pacing merge)

## Context

The magnific-ext Chrome extension currently runs inside the operator's
own Chrome browser. To process a Magnific queue row, the operator must:

1. Keep Chrome running on the host machine.
2. Keep a Magnific tab open and logged in.
3. Have the magnific-ext extension installed in that Chrome instance.

Every one of those steps is a manual touchpoint the operator wants to
eliminate. The goal is a self-managed runtime: HistForge launches its
own Playwright-controlled Chromium with magnific-ext preloaded, persists
the Magnific session across runs, and exposes start/stop/connect
controls through the dashboard. After a one-time login, the operator
never touches their real Chrome for HistForge work.

A 10-minute spike on 2026-05-27 confirmed Playwright Chromium reaches
`magnific.com` without Cloudflare Turnstile blocking the navigation —
the login page rendered cleanly with all auth options visible. That
removes the biggest unknown about whether this architecture is viable.

This runtime is foundational for the upcoming **Magnific narrative
image generation** feature (separate spec). The narrative provider
generates hundreds of images per video; without an unattended runtime,
that volume is impractical against the operator's real Chrome.

## Scope

### In scope

1. **A new `magnific-runtime` subsystem** under `src/lib/magnific-runtime/`
   that wraps Playwright's `chromium.launchPersistentContext()` with a
   persistent userDataDir, the magnific-ext loaded via
   `--load-extension`, and lifecycle methods (`start`, `stop`,
   `status`, `connect`).
2. **Worker integration** in `src/worker/index.ts`: when the worker
   starts, it boots the runtime if `magnific_runtime_enabled=true` and
   the userDataDir exists. If userDataDir is missing, the runtime
   reports `status='disconnected'` and waits for the operator to
   trigger the connect flow from the dashboard.
3. **New API routes** under `src/app/api/magnific/runtime/`:
   - `POST /start` — launch the browser.
   - `POST /stop` — close the browser.
   - `GET /status` — `{running, connected, session_valid, last_error}`.
   - `POST /connect` — launch the browser if not running, navigate to
     `/log-in`, return 200 once the operator completes the login (URL
     transitions to `/app/projects/work` within a timeout).
4. **Settings → Magnific tab** gains a "Runtime" section:
   - `magnific_runtime_enabled` toggle (default `false`; flipping to
     `true` boots the runtime on the next worker tick).
   - Status row: running / connected / disconnected / session_expired.
   - "Connect Magnific" button (triggers the connect flow).
   - "Restart browser" + "Stop browser" buttons.
5. **Headed mode with positioned window.** Playwright launches with
   `headless: false` (Chrome extensions don't load in pure headless),
   but the spec defaults the window position off-screen. Operator can
   override to make it visible during debugging via
   `magnific_runtime_window_visible` setting.
6. **Persistent context** at `data/magnific-userdata/` (configurable
   via `magnific_runtime_user_data_dir` setting). Cookies, localStorage,
   IndexedDB persist across HistForge restarts and host machine reboots.
7. **Extension token injection.** The magnific-ext popup currently
   takes a token typed by the operator. In the Playwright-loaded
   extension, HistForge writes the token into `chrome.storage.local`
   by opening a bridge page at `chrome-extension://<id>/blank.html`
   shipped inside magnific-ext and evaluating
   `chrome.storage.local.set` in that page's context (Decision 1).
   The extension's SW then picks it up without operator intervention.
8. **Health monitoring.** Playwright's `browser.on('disconnected')`
   event triggers an auto-relaunch with exponential backoff (1s, 2s,
   4s, 8s, cap 60s). The `last_error` field on `/status` surfaces the
   most recent failure.
9. **Hard cut from operator-Chrome magnific-ext.** Once the runtime
   ships, the operator-installed Chrome extension path is deprecated.
   The extension itself remains buildable / installable for power
   users, but HistForge's documentation, dashboard, and onboarding all
   point at the runtime. Migration: operator clicks "Connect Magnific"
   once in the new UI and logs in inside the Playwright window.

### Out of scope

- **Multi-tab parallelism.** Single Chromium, single tab. Magnific
  narrative throughput is bottlenecked by serial generation (~50min/
  video) but that matches the operator's stated tolerance.
- **Pure headless mode.** Chrome extensions don't work in `headless:
  true`. New-headless (`--headless=new`) supports extensions but the
  Cloudflare detection risk is unknown — defer to a follow-up if RAM
  / window-management becomes a complaint.
- **Child-process isolation.** v1 imports Playwright directly in the
  worker. If browser crashes start taking down the worker, lift this
  into a child process via `child_process.fork` later.
- **Cross-platform packaging.** Windows-first (operator's platform).
  Linux / macOS support is "best-effort, untested" in v1. Playwright
  itself is cross-platform; the spec doesn't deliberately Windows-
  ify anything.
- **Bring-your-own Chromium.** Use Playwright's bundled Chromium.
  Avoids the install-path-resolution problem and keeps the extension
  loading deterministic.
- **Stealth patches.** Spike confirmed default Playwright passes
  Cloudflare. If detection tightens later, `playwright-stealth` or
  manual `navigator.webdriver` evasions are a future addition.
- **Operator-Chrome migration path.** Hard cut. The operator runs
  "Connect Magnific" once after upgrade and that's the migration.
- **Multi-account Magnific runtime.** One runtime, one Magnific
  account. Mirrors the existing magnific-coordinator's single-account
  design (skill §"Single account").
- **Browser tab UI inside HistForge.** No live-mirror of the browser
  window into the dashboard. Operator opens the actual Playwright
  window if they need to see what's happening.

## Architecture

```
HistForge worker process
  ├── runner loop (existing)
  └── magnific-runtime subsystem (new)
        ├── Playwright BrowserContext
        │     - launched via chromium.launchPersistentContext()
        │     - userDataDir: data/magnific-userdata/
        │     - args: ['--load-extension=extensions/magnific-ext',
        │              '--disable-extensions-except=...',
        │              '--window-position=...']
        ├── lifecycle: start | stop | status | connect
        ├── health: on('disconnected') → backoff relaunch
        └── extension token injection via bridge page
              (navigate chrome-extension://<id>/blank.html → chrome.storage.local.set)
              ↓
        Playwright Chromium (one process, one persistent tab)
              ├── magnific-ext loaded
              │     ├── SW polls localhost:3000/api/magnific/next-task
              │     └── Content scripts inject on magnific.com/*
              └── magnific.com tab(s)
                    - persistent login via cookies in userDataDir

Dashboard
  └── /settings (Magnific tab → Runtime section)
        ├── Status indicator (running / connected / session_expired)
        ├── Connect Magnific button → POST /api/magnific/runtime/connect
        ├── Stop button → POST /api/magnific/runtime/stop
        └── Restart button → stop + start
```

## Data model changes

### Settings (`src/lib/settings.ts` + `src/lib/db.ts`)

Add to `DEFAULT_SETTINGS`:

```ts
magnific_runtime_enabled: "false",
magnific_runtime_user_data_dir: "data/magnific-userdata",
magnific_runtime_window_visible: "false",
magnific_runtime_extension_path: "extensions/magnific-ext",
```

Add to `SETTING_SCHEMAS`:

```ts
magnific_runtime_enabled: z.enum(["true","false"]).transform(v => v === "true"),
magnific_runtime_user_data_dir: z.string(),
magnific_runtime_window_visible: z.enum(["true","false"]).transform(v => v === "true"),
magnific_runtime_extension_path: z.string(),
```

Add to `TAB_FIELDS.magnific` in `src/lib/settings-tabs.ts`:

```ts
"magnific_runtime_enabled",
"magnific_runtime_user_data_dir",
"magnific_runtime_window_visible",
"magnific_runtime_extension_path",
```

`INSERT OR IGNORE` migrations for upgraded DBs to gain the four
defaults.

### No new tables

Runtime state is in-memory inside the worker process; no DB rows
needed. The persistent userDataDir on disk is the only persistent
artifact, and that's managed by Playwright, not HistForge's DB.

## Runtime module (`src/lib/magnific-runtime/`)

### `runtime.ts` — singleton lifecycle

```ts
import { chromium, type BrowserContext } from "playwright";

export class MagnificRuntime {
  private context: BrowserContext | null = null;
  private lastError: string | null = null;
  private backoffMs = 1000;

  async start(): Promise<void> {
    if (this.context) return;
    const userDataDir = path.resolve(getSetting("magnific_runtime_user_data_dir"));
    const extensionPath = path.resolve(getSetting("magnific_runtime_extension_path"));
    const visible = getSetting("magnific_runtime_window_visible");

    this.context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: [
        `--load-extension=${extensionPath}`,
        `--disable-extensions-except=${extensionPath}`,
        ...(visible ? [] : ["--window-position=4000,4000"]),
      ],
      viewport: { width: 1280, height: 800 },
    });

    // Inject the magnific_token into the extension's chrome.storage so
    // the extension's SW doesn't need operator-typed config.
    await this.injectExtensionToken();

    this.context.on("close", () => this.handleDisconnect());
  }

  async stop(): Promise<void> {
    if (!this.context) return;
    await this.context.close();
    this.context = null;
  }

  async connect(timeoutMs = 5 * 60 * 1000): Promise<{success: boolean, reason?: string}> {
    if (!this.context) await this.start();
    const page = await this.context!.newPage();

    // Reposition the off-screen window onto a visible monitor so the
    // operator can actually see the login flow, then best-effort raise.
    const cdp = await this.context!.newCDPSession(page);
    const { windowId } = await cdp.send("Browser.getWindowForTarget");
    await cdp.send("Browser.setWindowBounds", {
      windowId,
      bounds: { left: 100, top: 100, width: 1280, height: 800, windowState: "normal" },
    });
    await page.bringToFront();

    await page.goto("https://www.magnific.com/log-in");
    try {
      await page.waitForURL(/\/app\//, { timeout: timeoutMs });
    } catch {
      // Leave the window visible so the operator can see what stalled.
      return { success: false, reason: "timeout" };
    }

    // Login succeeded — slide the window back off-screen.
    await cdp.send("Browser.setWindowBounds", {
      windowId,
      bounds: { left: 4000, top: 4000 },
    });
    return { success: true };
  }

  async status(): Promise<RuntimeStatus> {
    if (!this.context) {
      return { running: false, connected: false, session_valid: false, last_error: this.lastError };
    }
    const userDataDirExists = existsSync(getSetting("magnific_runtime_user_data_dir"));
    return {
      running: true,
      connected: userDataDirExists,
      session_valid: !getSetting("magnific_relogin_needed"),
      last_error: this.lastError,
    };
  }

  private async handleDisconnect(): Promise<void> {
    this.context = null;
    if (!getSetting("magnific_runtime_enabled")) return;
    setTimeout(() => this.start().catch(e => { this.lastError = String(e); }), this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, 60_000);
  }

  private async injectExtensionToken(): Promise<void> {
    const token = getSetting("magnific_token");
    // Decision 1: navigate a hidden page at the extension's own origin
    // and call chrome.storage.local.set there. Pages on the
    // chrome-extension:// origin have direct chrome.* API access.
    const extId = await resolveExtensionId(this.context!);
    const page = await this.context!.newPage();
    try {
      await page.goto(`chrome-extension://${extId}/blank.html`);
      await page.evaluate(
        (t) => chrome.storage.local.set({ magnific_token: t }),
        token,
      );
    } finally {
      await page.close();
    }
  }
}

export const magnificRuntime = new MagnificRuntime();
```

(The above is a sketch; the implementation will refine error handling
and the `resolveExtensionId` helper — it derives the deterministic
extension ID from magnific-ext's manifest `"key"` field, with a
fallback to discovering the SW URL via `context.serviceWorkers()`.)

### `userdata.ts` — userDataDir helpers

Manage the persistent directory: create on first run, check existence,
expose path resolution. Stays out of `runtime.ts` so the lifecycle
class stays narrow.

### `extension-token.ts` — magnific-ext token injection

The extension reads its token from `chrome.storage.local`. Playwright's
`context.addInitScript` runs in the page world, not the extension's SW
world, so a direct `chrome.storage.local.set` won't reach the
extension. **Decision 1** picked the bridge-page approach: ship an
empty `blank.html` inside magnific-ext, mark it
`web_accessible_resources`, navigate Playwright to
`chrome-extension://<id>/blank.html`, and call
`chrome.storage.local.set` from that page — pages on the
`chrome-extension://` origin have direct `chrome.*` API access.

This module exposes two helpers:

- `resolveExtensionId(context)` — returns the deterministic ID
  derived from magnific-ext's manifest `"key"` field. Falls back to
  scanning `context.serviceWorkers()` for a `chrome-extension://`
  URL if the key isn't present (test environments).
- `injectToken(context, token)` — opens the bridge page, writes the
  token, closes the page.

Both are testable in isolation: `resolveExtensionId` against a
fixture manifest, `injectToken` against a mocked Playwright context.

## Worker integration

`src/worker/index.ts` boot sequence:

```ts
// Skip auto-start in dev so tsx watch reloads don't fight over the
// userDataDir lock. Operator clicks "Connect Magnific" in the dashboard
// when they need the runtime during a dev session.
if (process.env.NODE_ENV !== "development"
    && getSetting("magnific_runtime_enabled")) {
  void magnificRuntime.start().catch(e => log("magnific-runtime start failed:", e));
}
// existing runner loop continues
```

Worker shutdown: SIGTERM handler awaits `magnificRuntime.stop()`
before exit. The browser context closes cleanly so cookies / IndexedDB
get flushed.

The runtime is NOT a blocker for the worker loop — if it fails to
start, the rest of HistForge keeps running. The only thing that breaks
is Magnific queue processing (which already fails gracefully on the
`session_expired` path).

## API routes (`src/app/api/magnific/runtime/`)

### `POST /start`, `POST /stop`

Operator-facing controls. Call the runtime methods, return
`{success: true}` on completion.

### `GET /status`

Returns the runtime status payload. Dashboard polls this on the
existing 5-second cadence to drive banner UI.

### `POST /connect`

Triggers the connect flow:
1. `magnificRuntime.start()` if not running.
2. Open a new tab navigating to `magnific.com/log-in`.
3. Reposition the window from off-screen to visible (CDP
   `Browser.setWindowBounds` to `(100, 100)`, `1280×800`, `windowState:
   normal`) and call `page.bringToFront()` as a best-effort focus
   raise. OS focus-stealing prevention may block the raise; the
   dashboard modal covers that case.
4. Wait for URL transition to `/app/*` (operator completed login) or
   timeout after 5 minutes.
5. On success, CDP `setWindowBounds` back to `(4000, 4000)` so the
   window returns to its hidden position.
6. Return `{success: true, session_valid: true}` on success or
   `{success: false, reason: "timeout"}` on timeout (window stays
   visible so the operator can see why it stalled).

The dashboard's "Connect Magnific" button POSTs here and shows a
modal: "A browser window has opened — log in to Magnific in that
window. If you don't see it, check your taskbar. This dialog will
close when you're done."

## Settings UI

### `src/app/settings/magnific-tab.tsx` — new Runtime section

Below the existing token + model fields, add a `<FieldGroup
title="Runtime">` containing:

```tsx
<BoolField id="magnific_runtime_enabled" label="Enable runtime"
  value={values.magnific_runtime_enabled}
  onChange={v => update("magnific_runtime_enabled", v)} />

<MagnificRuntimeStatus />  {/* live polls /api/magnific/runtime/status */}

<Button onClick={() => fetch("/api/magnific/runtime/connect", {method:"POST"})}>
  Connect Magnific
</Button>

<TextField id="magnific_runtime_user_data_dir" label="User data directory"
  value={values.magnific_runtime_user_data_dir}
  onChange={v => update("magnific_runtime_user_data_dir", v)}
  hint="Persistent cookies / login. Default 'data/magnific-userdata'." />

<BoolField id="magnific_runtime_window_visible" label="Show browser window"
  value={values.magnific_runtime_window_visible}
  onChange={v => update("magnific_runtime_window_visible", v)} />

<TextField id="magnific_runtime_extension_path" label="Extension path"
  value={values.magnific_runtime_extension_path}
  onChange={v => update("magnific_runtime_extension_path", v)}
  hint="Path to magnific-ext directory loaded into the runtime." />
```

The `MagnificRuntimeStatus` component (new) shows a colored pill:
- 🟢 Connected
- 🟡 Running but session expired (offer Reconnect button)
- 🔴 Stopped (offer Start button)
- ⚫ Disabled (toggle off)

## Dependency changes

`package.json` gains:

```json
"dependencies": {
  "playwright": "^1.48.0"
}
```

(`playwright` is already in devDependencies for the existing test
infra. Promoting to a runtime dep makes the install size implication
explicit: Chromium ~150MB, downloaded on first `npm install` via
`postinstall`.)

`scripts/ensure-native-modules.js` may need a sister
`scripts/ensure-playwright-chromium.js` that verifies Chromium is
downloaded — to avoid runtime failures on first start with a fresh
install. Out of v1 if the default `npm install` hooks suffice.

## Error handling

| Failure | Surface | Behavior |
|---|---|---|
| Chromium binary missing | Runtime `start()` | Throws; `last_error` set; dashboard banner: "Chromium not installed. Run `npx playwright install chromium`." |
| Extension path invalid | Runtime `start()` | Throws; banner: "Extension not found at path X." |
| userDataDir locked (another Chromium running on it) | Runtime `start()` | Throws; banner: "Another HistForge or Chrome instance is using the user data directory. Close it and retry." |
| Login flow timeout | `POST /connect` | Returns 200 `{success: false, reason: "timeout"}`; dashboard shows error |
| Browser crashes mid-task | `on('disconnected')` | Exponential backoff relaunch (1s, 2s, 4s, 8s, ...60s cap); `last_error` updated each retry |
| Cloudflare / reCAPTCHA challenges login | Operator handles inside window | Connect flow repositions the window onto a visible monitor before navigating to `/log-in`, so the operator can always reach the challenge. Dashboard surfaces "If the challenge is taking longer than expected, complete it in the open window" after 60s |
| Session expires (Magnific 401) | Existing `/api/magnific/status/[token]` flips `magnific_relogin_needed=true` | Dashboard shows "Session expired — click Reconnect"; queue processing pauses; operator clicks Reconnect → triggers `/connect` flow |
| Worker crash with browser running | OS-level cleanup | Browser process orphaned; next worker start sees lock file in userDataDir → throws "userDataDir locked"; operator kills the Chromium process manually or via a "Force-clear lock" button (deferred) |

## Testing strategy

1. **`__tests__/unit/lib/magnific-runtime/runtime.test.ts`** (new) —
   Playwright mocked. Lifecycle invariants: `start()` idempotent,
   `stop()` releases context, `status()` reflects state. No real
   browser launch.

2. **`__tests__/unit/lib/magnific-runtime/extension-token.test.ts`** (new) —
   token injection script renders correctly for various token values.

3. **`__tests__/api/magnific/runtime/status/route.test.ts`** (new) —
   route returns the right shape for each runtime state.

4. **`__tests__/api/magnific/runtime/connect/route.test.ts`** (new) —
   mocked Playwright; verifies the connect flow waits on URL pattern
   and returns timeout on no-redirect.

5. **`__tests__/components/settings/magnific-runtime-status.test.tsx`** (new) —
   status pill rendering for each state.

6. **`__tests__/integration/magnific-runtime-smoke.test.ts`** (new,
   env-gated) — actually launches Playwright Chromium, loads the
   extension, navigates to magnific.com, verifies the page loaded.
   Skipped by default; runs when `MAGNIFIC_RUNTIME_SMOKE=1` is set.
   Not in CI; manual operator verification.

## File-level deliverables

- `package.json` — promote `playwright` to dependencies.
- `src/lib/settings.ts` — four new keys.
- `src/lib/db.ts` — four `INSERT OR IGNORE` migrations.
- `src/lib/settings-tabs.ts` — four new keys in `TAB_FIELDS.magnific`.
- `src/lib/magnific-runtime/runtime.ts` — main lifecycle class.
- `src/lib/magnific-runtime/userdata.ts` — userDataDir helpers.
- `src/lib/magnific-runtime/extension-token.ts` — token injection
  (bridge-page approach, Decision 1).
- `src/lib/magnific-runtime/index.ts` — barrel export.
- `src/worker/index.ts` — boot the runtime if enabled, guarded by
  `NODE_ENV !== "development"` (Decision 3).
- `src/app/api/magnific/runtime/start/route.ts` — new.
- `src/app/api/magnific/runtime/stop/route.ts` — new.
- `src/app/api/magnific/runtime/status/route.ts` — new.
- `src/app/api/magnific/runtime/connect/route.ts` — new.
- `src/app/settings/magnific-tab.tsx` — Runtime section.
- `src/app/settings/magnific-runtime-status.tsx` — status pill.
- `extensions/magnific-ext/manifest.json` — add `"key"` for
  deterministic extension ID; add `blank.html` to
  `web_accessible_resources` (Decision 1).
- `extensions/magnific-ext/blank.html` — empty bridge page
  (Decision 1).
- All `__tests__/...` files listed above.
- `docs/histforge-spec.md` — append §"Magnific runtime" with the new
  settings + lifecycle overview.
- `CLAUDE.md` — one-line entry under "Key Conventions" pointing at the
  runtime as the canonical Magnific dispatch path.

Estimated ~16 files + 6 test files. Single PR off `master`.

## Rollout / risk

- **Hard cut from operator-Chrome.** Old extension-in-Chrome path
  stops being the recommended deployment. Operators of the existing
  music-video Magnific flow must run "Connect Magnific" once after
  the runtime ships. The operator-installed extension still works if
  someone wants to keep it, but documentation points at the runtime.
- **Install size.** Playwright Chromium adds ~150MB to the dependency
  footprint. Acceptable for an unattended-pipeline tool.
- **Cloudflare risk.** Mitigated by the 2026-05-27 spike — default
  Playwright passes. If Cloudflare tightens later, `playwright-stealth`
  is the next step; not in v1.
- **reCAPTCHA on login.** First-time login asks the operator to
  complete reCAPTCHA inside the Playwright window. One-time event;
  cookies persist. Session expiry triggers it again — surface via
  banner so the operator doesn't get stuck.
- **Headed window.** v1 puts the window off-screen by default
  (`--window-position=4000,4000`). Operator flips
  `magnific_runtime_window_visible=true` if they want to watch / debug.
  True headless is out of scope (extensions don't load).
- **Worker stability coupling.** v1 imports Playwright directly in
  the worker. A Playwright crash can take the worker down. Mitigation:
  Playwright's own error handling + the `on('disconnected')` relaunch
  loop. If we see worker crashes traced to Playwright in practice,
  lift the runtime into a child process in a follow-up.
- **PR shape.** All commits prefixed `magnific-runtime:`. Single PR
  off `master`. Estimated 1 week of focused work.

## Implementation method

TDD where possible (the route handlers and the status pill have clear
test surfaces). The lifecycle class itself is hard to unit-test
end-to-end because it wraps Playwright — mock at the
`chromium.launchPersistentContext` boundary and write the env-gated
smoke test for end-to-end validation.

Sessioning suggestion (operator confirms in the implementation
plan-mode pass):

- **Session 1: foundation.** package.json + settings + db migrations +
  the empty `magnific-runtime/` module skeleton with passing-but-noop
  tests.
- **Session 2: lifecycle.** Real `start()` / `stop()` / `status()` +
  health monitor + extension-token injection. Tests mock Playwright.
- **Session 3: API + UI.** Route handlers, settings tab section,
  status pill component.
- **Session 4: smoke + docs.** Env-gated integration smoke; spec
  + CLAUDE.md updates; PR.

Final pre-PR: `npm run lint`, `npm run test`, `npm run build`. All
clean. Smoke test run manually against a fresh Magnific account.

PR title: `magnific-runtime: HistForge-managed Playwright Chromium
with persistent context and one-time login`.

## Resolved decisions (2026-05-27 brainstorm)

The four spec-level uncertainties were resolved in a brainstorm before
the implementation plan was written. The choices below are committed;
the rejected alternatives stay in this section as historical context
so a future spike has a starting point if any decision turns out wrong.

### Decision 1: Extension token injection — bridge page

The runtime injects the magnific token by opening a hidden page at
`chrome-extension://<magnific-ext-id>/blank.html` (a one-line bridge
page shipped inside magnific-ext) and evaluating
`chrome.storage.local.set({ magnific_token: "..." })` in that page's
context. Pages on the `chrome-extension://` origin have direct
`chrome.*` API access, so this writes the extension's real storage
without the extension needing to expose a network endpoint.

To keep the extension ID deterministic across runs and operator
machines, magnific-ext's `manifest.json` gains a `"key"` field (the
public half of an RSA keypair). The runtime computes the extension ID
from this key once and reuses it.

**Rejected:** (b) SW fetches token on boot — circular (SW needs the
HistForge base URL configured somewhere first) and forces extension
code changes. (c) Templated manifest build — token rotation would
require rebuilding the extension; not a real fit for a runtime
secret.

**Fallback if (a) fails during implementation:** (b) is still the
cleanest backup; spike before pivoting.

### Decision 2: Window hiding — off-screen position

Runtime launches with `--window-position=4000,4000` whenever
`magnific_runtime_window_visible=false` (the default). Verified
against the operator's Windows + multi-monitor setup on 2026-05-27.

macOS / Linux behavior of the same flag is documented as
"best-effort, untested" in v1. If a non-Windows operator surfaces,
the spec revisits.

**Rejected:** (b) `--start-minimized` — adds a persistent taskbar
icon, more user-visible noise. (c) Always-show — defeats the
unattended-pipeline goal. (d) Hybrid off-screen-then-minimized
fallback — more code paths, more failure modes, no clear payoff.

### Decision 3: Worker hot-reload — skip auto-start in dev

The worker boot code wraps the auto-start in a guard:

```ts
if (process.env.NODE_ENV !== "development"
    && getSetting("magnific_runtime_enabled")) {
  void magnificRuntime.start().catch(e => log("…", e));
}
```

In dev (`tsx watch`), the runtime never auto-boots — every file save
restarts the worker cleanly without trying to grab a userDataDir
lock. When a developer is actively working on the runtime, they
click the dashboard's "Connect Magnific" button once per dev
session to bring the browser up manually.

**Rejected:** (b) Force-kill orphaned Chromium on start — real
footgun if `npm run dev` ever runs alongside a production HistForge
on the same userDataDir; cross-platform process killing is fiddly.
(c) Accept the breakage and document — every dev save would surface
a runtime error in the dashboard.

**Future enhancement (out of v1):** A dashboard "Force-clear lock"
button that targets the specific lock-holder PID after user
confirmation. Useful for crash recovery in prod; not needed yet.

### Decision 4: Connect-flow window focus — CDP reposition + bringToFront

`POST /api/magnific/runtime/connect` does the following:

1. `magnificRuntime.start()` if not running.
2. Open a new page navigating to `https://www.magnific.com/log-in`.
3. Via a CDP session: `Browser.getWindowForTarget` → `Browser.setWindowBounds`
   to move the window from `(4000, 4000)` to a visible position
   (default `(100, 100)`, size `1280×800`) and set state `normal`.
4. `await page.bringToFront()` as a best-effort focus raise. Modern
   Windows focus-stealing prevention may intercept; that's expected.
5. Dashboard shows a modal: "A browser window has opened — log in to
   Magnific in that window. If you don't see it, check your taskbar."
6. Wait for URL transition to `/app/*` (operator finished login) or
   timeout after 5 minutes.
7. On success, CDP `setWindowBounds` back to `(4000, 4000)` so the
   window returns to its hidden position.
8. Return `{success: true, session_valid: true}`, or
   `{success: false, reason: "timeout"}` on timeout (window stays
   visible in the timeout case so the operator can see why it
   stalled).

**Rejected:** (b) + PowerShell `SetForegroundWindow` shell-out —
Windows-only, brittle across Chromium versions, marginal UX gain
(one click saved at most). (c) Reposition only, no `bringToFront`
— `bringToFront()` is cheap and works when focus-stealing isn't
blocked, so there's no reason not to call it.

## Ripple effects of the decisions above

The decisions add or change the following beyond what the earlier
sections describe:

- **magnific-ext manifest gains a `"key"` field** (Decision 1). One
  new line in `extensions/magnific-ext/manifest.json`. The RSA
  keypair is generated once and the public half checked into the
  repo; the private half stays out of source.
- **magnific-ext ships a tiny `blank.html`** (Decision 1). Empty
  `<html><body></body></html>` accessible at the extension's
  `chrome-extension://<id>/blank.html`. Listed in `web_accessible_resources`.
- **Worker boot code checks `NODE_ENV`** (Decision 3). The snippet
  in §"Worker integration" needs the guard.
- **Connect-flow route uses CDP** (Decision 4). The route handler
  imports the runtime's connect method, which internally opens a CDP
  session via `context.newCDPSession(page)` for the window bounds
  calls.
- **Error-handling table — Cloudflare-on-login row updates** (Decision 4):
  the window is now repositioned visible during connect, so the
  "if window is hidden, operator gets stuck" caveat no longer
  applies during connect. The 60-second "make sure the window is
  visible" hint becomes "if reCAPTCHA is taking longer than
  expected, complete it in the open window."

These ripples are absorbed into the existing sections during the
implementation plan; they do not change the architecture.

## Appendix A: Manual probe — extension-ID derivation

The runtime's bridge-page strategy (Decision 1) requires that the ID
computed by `resolveExtensionId(context)` (from the manifest `"key"`)
matches the ID Chromium assigns to the loaded extension at runtime
(`chrome.runtime.id`). The algorithm is mechanical (SHA-256 of the
DER-decoded base64 key → first 16 bytes → nibble-remapped to a..p),
but a divergence between the documented algorithm and Chromium's actual
behavior would silently break token injection in every later session.

This appendix documents the one-shot manual probe that proves the two
match. **Running it once and observing a green MATCH is the gate on
completing SESSION 2.** Without that probe the implementation could be
green in tests yet wrong at runtime — every test mocks Playwright at
the type boundary and never touches a real Chromium.

### Procedure

1. From the repo root: `npx tsx scripts/probe-extension-id.ts`
2. The script launches a headed Playwright Chromium with magnific-ext
   loaded via `--load-extension`, off-screen at `(4000, 4000)`.
3. It computes three IDs independently and compares all pairs:
   - `chrome.runtime.id` from the extension's service worker context.
   - `deriveIdFromKey(manifest.key)` — primary derivation, called
     directly from the manifest. Bypasses `resolveExtensionId`'s
     SW-scan fallback so a missing manifest key fails loud rather than
     silently producing a false MATCH via the fallback.
   - `resolveExtensionId(context)` — the production helper.
4. Expected output: all three IDs equal
   `blkhajpjohgopchihlaeeagamopdpfmd`, final line reads
   `MATCH = true`, exit code 0. Any pair mismatch prints the
   disagreement and exits 1.

### When to re-run

- After rotating the manifest `"key"` per
  `docs/magnific-ext-key-rotation.md`.
- After upgrading Playwright across a major Chromium version.
- If `resolveExtensionId` or `deriveIdFromKey` is refactored.
