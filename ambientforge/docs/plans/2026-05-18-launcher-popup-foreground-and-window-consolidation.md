# Launcher: Popup-to-Front + One-Console Consolidation

## Overview

Two operator-experience fixes for the medieval-path launcher: (1) the cover-pick
popup must force itself in front of everything (incl. fullscreen Chrome) the
moment the 4 images load, not just flash the taskbar; (2) one `.bat` click
should open ONE log console instead of five `cmd` windows. The cover-pick relay
itself was just proven working (commit `8555158`) — this is purely launch
ergonomics, no pipeline changes.

## Current State

**Popup foreground** — `scripts/pick-popup.ps1`:
- `Show-Offer` (`pick-popup.ps1:76-103`) is the single chokepoint, called only
  when a NEW offer arrives (`Poll-Bridge`, `pick-popup.ps1:132-136`) — correct
  place to force focus; do not force on every 2s poll.
- Current attempt (`pick-popup.ps1:98-103`): `$form.WindowState='Normal'` →
  `$form.Activate()` → TopMost false/true toggle + `SystemSounds.Exclamation`.
- Form is created `TopMost=$true` (`pick-popup.ps1:26`). The gap is the INITIAL
  foreground grab while another app owns focus: Windows' `SetForegroundWindow`
  foreground-lock demotes a non-foreground process's `.Activate()`/TopMost
  toggle to a taskbar flash. Known reliable workaround: briefly satisfy the
  "user-input" exemption (synthetic ALT via `keybd_event`) or `AttachThreadInput`
  to the foreground thread, then `SetForegroundWindow` + `SetWindowPos`
  `HWND_TOPMOST`; `FlashWindowEx` as a last-resort fallback.
- `Add-Type` P/Invoke goes next to the existing assembly loads
  (`pick-popup.ps1:14-16`). Show-Offer runs on the WinForms timer/UI thread
  (`pick-popup.ps1:148-152`) so `$form.Handle` is valid and UI calls are safe.

**Window count** — `make-medieval-video.bat`:
- Interactive, must stay in the `.bat`: `DISTROKID_MODE=mock` (`:6`),
  loop-factor prompt (`:26-30`), YES cost-gate (`:36-45`),
  `AMBIENT_VIDEO_LOOP_FACTOR` export (`:29`).
- Then 5 windows via `start "..." cmd /k` / `powershell` (`:50-65`):
  suno-bridge, freepik-bridge, freepik-chrome (`scripts/freepik-login.ts`),
  cover-picker (`pick-popup.ps1`), worker (`scripts/make-medieval-video.ts`),
  plus the `.bat`'s own window (ends in `pause`, `:70`). Six total.
- `timeout /t 6` (`:64`) staggers the worker so bridges bind first.
- The repo already standardises multi-process consoles on `concurrently`:
  `package.json:9` `dev` = `concurrently -n web,worker,suno-br,flow-br,dk-br -c
  blue,magenta,cyan,yellow,green "next dev -p 3003" "tsx watch …" …`. Mirror it.
- Robustness already in place: `make-medieval-video.ts:22` self-defaults
  `DISTROKID_MODE=mock`; `:58` startup `/pick-clear` is best-effort
  (`.catch(()=>{})`), so a not-yet-bound freepik-bridge is harmless. The worker
  doesn't touch suno-bridge until step 03 (minutes in) or freepik until 05a, so
  the `timeout /t 6` is a safety margin, not a hard requirement.

Operator decision (2026-05-18): **one VISIBLE prefixed console** for
suno-bridge + freepik-bridge + freepik-login + worker; the popup stays its own
GUI window; the suno `:9333` Chrome and the freepik Playwright Chrome remain
separate (required GUI windows, unchanged).

## Scope

**Doing**: force the popup to true foreground on new-offer; add a `concurrently`
npm script for the 4 medieval processes; slim `make-medieval-video.bat` to
prompts + gate + popup window + that one console; preserve every gate/env var.

**Not doing**: any pipeline/worker/relay logic change; touching the suno `:9333`
or freepik Playwright Chrome windows; `concurrently --kill-others*` (a transient
bridge blip must not nuke a billable Suno run — match `npm run dev`'s no-kill
default); changing `pick-popup.ps1`'s bridge polling or pick round-trip (proven
in `8555158`).

## Tasks

### Phase 1: Popup forces itself to the foreground

- [x] **Task 1: Force `pick-popup.ps1` to true foreground when the offer arrives**
  **Files**: `scripts/pick-popup.ps1`
  **What**: When `Show-Offer` renders the 4 images, the window must reliably
  come to the front above a fullscreen browser and take focus (not just flash
  the taskbar), then stay on top until the operator picks (existing
  `Submit-Choice`/clear behavior unchanged). Keep the alert sound. Must NOT
  re-grab focus on every 2s `Poll-Bridge` tick — only on a new offer.
  **Context**: Add a P/Invoke `Add-Type` block by `pick-popup.ps1:14-16`
  exposing the Win32 calls needed to defeat the `SetForegroundWindow`
  foreground-lock (synthetic-ALT or `AttachThreadInput` exemption →
  `SetForegroundWindow` + `SetWindowPos HWND_TOPMOST` → restore if minimized;
  `FlashWindowEx` fallback if the OS still denies). Call it from `Show-Offer`
  replacing the weak `:98-103` block. Show-Offer is already new-offer-gated
  (`pick-popup.ps1:132-136`) and runs on the UI thread (`:148-152`) so
  `$form.Handle` is valid; ensure any synthetic ALT keydown is paired with a
  keyup so the key isn't left stuck.

### Phase 2: One console instead of five cmd windows

- [x] **Task 2: Add a `concurrently` script for the 4 medieval processes**
  **Files**: `package.json`
  **What**: One npm script that runs suno-bridge, freepik-bridge,
  `scripts/freepik-login.ts`, and `scripts/make-medieval-video.ts` together in a
  single console with distinct name/color prefixes, so all logs (Suno
  captcha/credit, freepik, worker progress) are visible in one scrollable
  window. No kill-others behavior.
  **Context**: Copy the exact shape of `package.json:9` (`dev`): `concurrently
  -n <names> -c <colors> "tsx extensions/suno-runner/bridge.ts" "tsx
  extensions/freepik-runner/bridge.ts" "tsx scripts/freepik-login.ts" "tsx
  scripts/make-medieval-video.ts"`. `concurrently` is already a devDependency
  (`package.json:49`). Env (`DISTROKID_MODE`, `AMBIENT_VIDEO_LOOP_FACTOR`) set
  by the `.bat` propagates through `npm run` → concurrently → tsx children
  (same process tree); `make-medieval-video.ts:22` also self-defaults DK mock as
  a backstop.

- [x] **Task 3: Slim `make-medieval-video.bat` to prompts + gate + popup + the one console**
  **Files**: `make-medieval-video.bat`
  **What**: Keep the banner, loop-factor prompt, YES cost-gate, and env exports
  exactly as-is. Replace the five `start` windows with: one `start` for the
  cover-picker popup (it's a GUI — stays its own window), then run the Task 2
  npm script in the launcher's OWN window (becomes the single visible console;
  drop the trailing `pause` — closing/ Ctrl+C-ing this one window stops the
  whole run). Preserve the bridges-before-worker intent (the `timeout /t 6`
  rationale): either keep a short pre-flight delay or note that the worker's
  first bridge contact is minutes away so concurrent start is safe — implementer
  picks, but the reasoning must not be silently lost.
  **Context**: Mirrors how `npm run dev` is one window for many processes. The
  popup launch line stays like the current `start "AF cover-picker" powershell
  -NoProfile -ExecutionPolicy Bypass -Sta -File "scripts\pick-popup.ps1"`
  (`make-medieval-video.bat:60`). Net: 6 windows → 1 console + popup + the two
  required Chromes.

### Phase 3: Verify

- [x] **Task 4: Dry verify (no Suno bill)** — DONE. Foreground validated live
  by the operator via direct bridge offer injection (`POST /pick-offer` with
  4 synthesized tiles — even cheaper than the smoke button: no Chrome/SW/Suno;
  isolates `Set-Foreground`). Operator confirmed the popup jumps in front of a
  maximized window + the pick round-trips server-side. Window consolidation is
  verified-by-construction (one `start` + `call npm run medieval`; same
  `concurrently` mechanism as the proven `dev` script) — not billed to count
  windows. **Bonus (operator request, validated): popup is now fullscreen +
  adaptive 2×2 grid** (was a small 900×780 window) — `pick-popup.ps1`
  `WindowState=Maximized` + `TableLayoutPanel`; committed separately.
  **Files**: `make-medieval-video.bat`, `scripts/pick-popup.ps1`,
  `package.json`
  **What**: Confirm one `.bat` click = exactly one log console (4 prefixed
  streams) + the popup window + the two Chromes; abort at the YES gate to avoid
  a Suno bill. Separately confirm the popup snaps to the foreground over a
  maximized window using the offline relay (start freepik bridge + popup +
  freepik-login, click the purple "AF smoke: test cover-pick popup" — proven
  path from `8555158`) — the popup must jump in front and a hand-click still
  resolves.
  **Context**: Foreground behavior can't be asserted from logs — it's a visual
  check the operator runs (Playwright/console can't see Z-order). The Suno-free
  smoke button is the zero-cost way to trigger a real offer; gate the full
  billable `.bat` per the stop-and-gate convention — do not trigger it to test.

## References
- `scripts/pick-popup.ps1:76-103` — `Show-Offer` (foreground chokepoint)
- `scripts/pick-popup.ps1:14-16` — where the P/Invoke `Add-Type` belongs
- `make-medieval-video.bat:26-45` — prompts + YES cost-gate (keep)
- `make-medieval-video.bat:50-70` — the five `start` windows (collapse)
- `package.json:9` — the `concurrently` pattern to mirror
- `scripts/make-medieval-video.ts:22,58` — DK self-default + best-effort startup clear
- commit `8555158` — cover-pick relay proven working (don't touch the relay)
