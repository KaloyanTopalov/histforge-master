# Google Flow Setup Guide

HistForge's `google-flow` workflow generates main images and hook videos by driving `labs.google/fx/tools/flow` through a forked Chrome extension (**YouForge Flow**). HistForge owns the task queue and per-account cooldown state; each Chrome profile runs one instance of the extension, parked on a different Google account.

See §12b of `docs/histforge-spec.md` for the architectural overview (queue schema, webhook contracts, defer semantics, reaper).

## Prerequisites

- HistForge running locally (`npm run dev` — Next.js + worker).
- Chrome (or Chromium-based browser with extension support).
- One Google account per runner (up to four — each capped around 300 clips/day by Google). Flow access is invite-based; confirm the account can reach `https://labs.google/fx/tools/flow` manually before using it here.

## 1. Create an account in HistForge

1. Open HistForge → **Settings** → **Google Flow** tab.
2. Scroll to the **Accounts** section → **Add account** → enter a name (free-form, e.g. `alice-gmail`) → submit.
3. A modal reveals the account's `token` and four webhook URLs:
   - `pollUrl` (`/api/flow/next-task/<token>`)
   - `resultUrl` (`/api/flow/submit-result/<token>`)
   - `statusUrl` (`/api/flow/status/<token>`)
   - `projectUrl` (`/api/flow/project/<token>`)
4. Click **Copy all** — the token is only visible in this one moment. If you lose it, delete the account and re-add (cheap under the persistent-profile model).

## 2. Load the extension into a fresh Chrome profile

Use **one Chrome profile per Google account**. Mixing accounts in the same profile confuses the extension's session token fetch.

1. In Chrome, click the profile avatar (top-right) → **Add** → create a profile named for this account.
2. In the new profile, open `chrome://extensions` → toggle **Developer mode** on (top-right).
3. Click **Load unpacked** → select the `extensions/youforge-flow/` directory from this repo.
4. Pin the YouForge Flow icon to the toolbar for convenience (puzzle-piece icon → pin).

## 3. Sign into Google Flow

1. In the same Chrome profile, sign into the intended Google account.
2. Navigate to `https://labs.google/fx/tools/flow` and leave a tab open on the Flow site — the extension's API calls piggyback on that session's auth token. You no longer need to manually open or create a Flow project; the extension creates a per-video project on first dispatch (named after the video) and reuses it for that account from then on.

## 4. Configure the extension

1. Click the YouForge Flow toolbar icon to open the popup.
2. Paste the four webhook URLs and the `accountToken` from step 1.
3. Leave **Image concurrency** at `5` and **Video concurrency** at `3` (each min 1, max 10). The two values are extension-local — they govern how many image and video Flow calls the extension runs in parallel. The bucket boundary itself (which queue modes belong to image vs video) is shared with HistForge via the bucket-to-modes map, so the server can hand out work that matches whichever bucket has a free slot.
4. Click **Grant HistForge access** → accept the Chrome permissions prompt for the HistForge origin. This is a required optional-permission grant; the **Start** button stays disabled until all four URLs and the account token are set and the host permission is granted.
5. Click **Start**. The status line should read `Idle` → `Last poll: Ns ago` within a few seconds.

Repeat steps 2–4 for each additional Google account, each in its own Chrome profile.

## 5. Smoke test end-to-end

1. In HistForge, create a new video with a **short** script (a low `chapter_count`, say 3) so you only need a handful of main chunks and one hook.
2. Pick the `google-flow` workflow in the Add/Edit modal.
3. Start the video. The worker walks through the shared steps, then enters the Flow steps.
4. Open the video's detail page — the Flow progress panel shows counts like `3/12 main images`. When a chunk completes, its image appears in the existing main-images gallery.
5. If an account hits a 429, the dashboard shows that account paused with a countdown; other accounts keep working. If every account is paused, the video's step defers (orchestrator moves on) and automatically resumes when any account's cooldown clears or is cleared manually.

## Troubleshooting

**Status line: "Error: session expired — re-login needed"**

The Google account's Flow session died (happens periodically — Google re-auths). The extension has halted itself and posted a `session_expired` event; HistForge's global relogin indicator is set.

- In the affected Chrome profile, navigate to `https://labs.google/fx/tools/flow` and sign in again if prompted.
- The extension detects the restored session on its own and resumes polling silently. No button press needed.
- The global indicator clears automatically on the next successful dispatch.

**Account row shows "offline" in the dashboard**

`last_seen_at` has gone stale — the extension stopped polling. Common causes: Chrome profile was closed, extension was disabled, the host permission was revoked, or the session expired. Reopen the profile and confirm the extension's status line reads `Idle` or `Last poll: Ns ago`.

**429 / `RESOURCE_EXHAUSTED` errors**

Google has rate-limited this account. HistForge auto-pauses it for `google_flow_account_cooldown_hours` (default 4 h) and requeues the task to another account. No manual action needed. If you want to shorten cooldown (for example while testing), lower that setting and resume the account manually — the next poll clears the pause.

**Content-policy failures (`SAFETY`, `CHILD_DANGER`, `PUBLIC_ERROR_INAPPROPRIATE_CONTENT`, etc.)**

Historical content often trips Flow's safety filters. These are **permanent failures** — no retry. The video's detail page shows per-chunk reasons under the Flow progress panel's "failed" expander.

- Edit the affected chunk's prompt in `chunks.json` (or revise the enrichment style) and click **Requeue failed** (or use `?force=1` to bypass the retry cap).
- Consider toning down graphic terms in the visual style this video uses — pick a milder one from Settings > Visual Style, or edit the chosen style's prompt there. The change re-pins on the next video; existing videos keep their original snapshot.

**"HistForge host permission revoked" in the extension popup**

You removed the permission via `chrome://extensions` while polling was running. Re-grant it from the popup's **Grant HistForge access** button and click **Start** again.

**Worker logs show "stuck dispatched" requeues every 30 s**

The reaper is rescuing rows whose extension instance fell silent. Check that the corresponding Chrome profile is still open and the extension is running. If the silence is intentional (account disabled, profile closed for the night), expect one sweep of log noise then silence.

**Result download fails with "invalid result host"**

Google changed a CDN host. The SSRF allowlist lives in `src/lib/flow-media.ts`; add the new host there. The failure is logged with the rejected URL so you can see exactly which host to allow.

## How the pieces fit together

- The extension is a **dumb runner**. All routing, quota, retries, and cooldowns live in HistForge.
- Tokens appear in the URL path **and** request body; any mismatch is rejected. Endpoints are otherwise unauthenticated — don't expose HistForge beyond localhost without VPN or an IP allowlist in front.
- `google_flow_queue` rows use a **dispatch-qualified `external_task_id`** (`"<row_id>_<dispatched_at>"`) so requeues after a reaper sweep sidestep the extension's in-memory dedup set.
- Video status stays `in_progress` while a Flow step is deferred; the orchestrator just picks something else to do and the reaper wakes the deferred video back up when any account becomes available.
