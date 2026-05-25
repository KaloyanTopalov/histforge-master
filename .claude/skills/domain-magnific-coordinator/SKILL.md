---
name: domain-magnific-coordinator
description: Guide for HistForge's server-side Magnific HITL coordinator — the single-account magnific_queue, the five extension-facing webhook routes, the reaper extension that honors the HITL `no_timeout` exemption, the SSRF allowlist, the token-minted Settings tab, the artifact passthrough that lets the extension fetch the loop image back for image-to-video, and the magnific-ext Chrome extension contract. Use when modifying any of the `/api/magnific/*` routes, the magnific queue repo, the magnific auth/wait/media libraries, the reaper's Magnific pass, the Settings > Magnific tab, or the magnific-ext extension (service worker, content scripts, popup). Pair with `domain-music-video` (the worker steps that consume this coordinator).
---

# Magnific Coordinator (Server Side)

## Anchors

Contract names for this domain. Resolve against the current codebase.

- **Auth + wait + media**: `resolveMagnificToken`, `waitForMagnificQueue`, `isAllowedMagnificHost`
- **Mode discriminator**: `MagnificQueueMode` (values `image-hitl`, `image-to-video`)
- **Repo (atomic claim + lifecycle)**: `enqueueTask`, `takeNextTask`, `submitResult`, `failTask`, `requeueTask`, `findOpenTaskForVideo`, `findDispatchedHitlForVideo`, `listStaleDispatched`, `resetAllDispatchedOnStartup`
- **Reaper**: `runReaperTick`
- **Extension-facing webhook routes**: `/api/magnific/next-task/[token]`, `/api/magnific/submit-result/[token]`, `/api/magnific/status/[token]`, `/api/magnific/queue-summary/[videoId]`, `/api/magnific/artifact/[token]`
- **DB table**: `magnific_queue`
- **Behavior-driving columns**: `magnific_queue.status`, `magnific_queue.no_timeout`, `magnific_queue.external_task_id`
- **Settings keys**: `magnific_token`, `magnific_image_model`, `magnific_video_model`, `magnific_dispatch_timeout_minutes`
- **Provider registry stubs**: `magnificImageProviderStub`, `magnificVideoProviderStub`

## Architecture

The Magnific coordinator is the HistForge-side half of a dumb-runner contract. The structural template is `domain-google-flow-coordinator` — same dispatch loop, same reaper invariants, same return-`{success: true}`-on-every-outcome rule — simplified along three axes that mirror the music-video product:

1. **Single account.** No `magnific_accounts` table. The one Magnific session is the operator's signed-in Chrome profile; auth is the URL `[token]` segment compared against a single `magnific_token` setting. If multi-account becomes a need later, the `google_flow_accounts` shape is the well-templated migration path.
2. **No moderation.** Magnific doesn't refuse prompts the way Google Flow does. The Flow coordinator's content-policy classifier, moderator loop, `moderation_round` column, and `moderation_events` audit trail are all absent here. Failed rows surface as failures; the operator's recourse is retrying the step from the dashboard.
3. **HITL `no_timeout` gate.** The image-hitl mode is operator-blocking — selection can legitimately take days. The queue row carries a `no_timeout` flag (set to 1 on image-hitl enqueue) and the reaper's dispatch-age requeue pass filters those rows out at the SQL level. Image-to-video keeps `no_timeout=0` so the reaper's normal requeue applies.

Two adjacent skills carry context: **`domain-music-video`** owns the six worker steps that produce and consume queue rows; **`domain-google-flow-coordinator`** is the structural sibling where invariants shared between the two coordinators were first established. Per-route behavior, idempotence shape, repo lifecycle, and the SSRF flow are documented in each route file and in the repo functions' JSDoc — this skill captures only the design rationale that doesn't fit at the call site.

## The Dumb-Runner Contract

The extension polls `next-task`, executes one Magnific UI flow (image-hitl: fill prompt + operator picks variation; image-to-video: upload reference frames + click Generate), and POSTs `submit-result`. HistForge does not call out to Magnific itself — the only outbound `*.cdnpk.net` / `*.freepikcdn.com` request HistForge issues is the streamed download in `submit-result` (SSRF-gated).

**All extension-facing routes return 200 `{success: true}` on every outcome.** The extension's webhook poster treats `success: false` and non-200 statuses as retry triggers; surfacing a server-side bug through HTTP status would send the extension into a retry storm. Errors are surfaced through DB writes (failed rows, banner state) — never through HTTP status codes on these routes. The exception is auth: an unknown URL token returns 404 before any body parsing happens. The operator-facing `regenerate-token` route is the only one that uses real status codes, because the dashboard handles them.

## Cross-Mode Queue Keying

The queue is keyed on `(video, mode)`: each music-video row enqueues at most one row per mode (`image-hitl` for the loop image, `image-to-video` for the loop clip). The step-side skip-on-reentry check passes the mode explicitly. **Don't search for any open row across modes** — the two steps coexist on the same video, and mode-keying is what lets `generate_loop_clip` re-enter after `generate_loop_image` has already enqueued its own row.

## SSRF Defense in Depth

`isAllowedMagnificHost` runs the HTTPS + CDN-suffix allowlist; the helper's own file-level JSDoc covers the rules. The allowlist runs **twice** on the success path: once in `submit-result` before the downloader call, and once inside the shared `downloadToProjectPath` helper (which now takes an allowlist function as a parameter). The double-check is intentional — the helper is also called by the Flow coordinator with a different allowlist, and a refactor that weakens one site shouldn't leave a hole. If a new Magnific CDN host is needed, extend the suffix list so both checks still pass.

## Provider Registry Stubs

`magnificImageProviderStub` and `magnificVideoProviderStub` exist as belt-and-braces guards. The `music-video-magnific-suno` workflow snapshot pins `image_provider='magnific'` and `video_provider='magnific'`, but the six music-video steps dispatch through the magnific_queue directly, not through `ImageProvider.generateBatch` / `VideoProvider.generateBatch`. The orchestrator's `resolveDeps` already short-circuits provider resolution for music-video snapshots, so these stubs only matter if a future code path looks them up regardless of kind. Both throw "should not be reached" from `generateBatch` so the failure mode is loud rather than silent.

For the image/video registry pattern (factories vs singletons, the `Object.keys` schema-endpoint contract), see **`domain-media`**.

## The Magnific Extension (Brief)

The magnific-ext Chrome extension is a small fork of the youforge-flow extension. The MV3 service-worker lifecycle, alarm-driven poll cadence, popup-side host-permission grant, and the `chrome.storage.local`-backed settings module are all inherited verbatim from youforge-flow — see **`domain-youforge-flow`** for those mechanics. The Magnific-specific deltas that aren't obvious from reading the extension code:

- **No MAIN-world bridge.** Magnific is DOM-driven, not API-driven like Google Flow, so the recaptcha/session-token harvesting that motivated the MAIN-world script in youforge-flow has no equivalent here. SW↔CS communication is `chrome.runtime.sendMessage` only.
- **Operator-driven variation pick (overlays, not native-click watching).** The image-hitl content script injects "Use this image for HistForge" overlay buttons on each variation in Magnific's grid; the operator clicks one and the content script harvests the image URL. Auto-watching for "native click" events on Magnific's own variation buttons was rejected in design — overlays are more reliable because they don't compete with Magnific's own click handlers.
- **No reference-image upload helper on the HistForge side.** For image-to-video, the extension executor `fetch()`-es the loop image from the artifact route and pipes it into Magnific's upload widget via the content script. There is no `flow/uploadImage`-equivalent server route — image-to-video reads back from HistForge, it doesn't push into it.

## Common Pitfalls

- **Never return `{success: false}` or a non-200 from an extension-facing route.** The extension's webhook poster treats those as retry triggers and the storm is hard to recover from. **Why:** the extension is dumb and cannot distinguish "real failure" from "server bug" — same invariant as the Flow coordinator's. **How to apply:** surface errors via DB writes (failed rows, settings flags). The operator-facing regenerate-token route is exempt because the dashboard handles its status codes.
- **`no_timeout=1` is the load-bearing HITL gate; keep the filter in SQL.** The reaper's dispatch-age pass filters `no_timeout=1` rows out at the SQL level. **Why:** operators leaving image-hitl rows dispatched for days is the entire point of the HITL design (ADR-0012 §4); a reaper that requeues those rows would yank the operator out of the Magnific tab they're working in. **How to apply:** don't move the filter into a JS post-fetch skip — push it down to SQL so the work is proportional to the requeue set, not the HITL backlog.
- **Field-casing on the wire is mixed by design, not by accident.** Snake_case for column-mirror names, camelCase for body-only carry-overs like `resultUrl`. **Why:** the magnific-ext popup + SW crib their wire shape from youforge-flow's, and a one-sided rename breaks the deserialization on the extension side. **How to apply:** if a casing change is genuinely needed, flip both sides in one PR.
- **The `MAGNIFIC_IMAGE_GEN_URL` coupling between the HITL banner and the extension constants is silent.** The dashboard banner's "Open Magnific tab" CTA opens a hard-coded URL; the extension's content script injects on a `host_permissions` pattern that must match that URL. **Why:** divergence lands operators on a tab the content script isn't injected on, and the banner appears stuck because no overlay buttons render. There is no runtime check that catches this; tests don't catch it either. **How to apply:** when changing either constant, grep for the other and update them in the same PR.
- **Don't add an auto-requeue for failed Magnific rows.** The submit-result handler records the error and stops; the operator's retry-from-dashboard flow is the recovery path. **Why:** without moderation (no content-policy loop to amplify retries against) there's no productive retry budget to spend. Magnific failures in v1 are either operator-actionable (transient extension error) or terminal (Magnific itself refused). **How to apply:** if a transient-vs-terminal classifier ever ships, retries belong in the worker step layer, not in the route handler.
