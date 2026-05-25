# CLAUDE.md

## Project Overview

AmbientForge — multi-channel YouTube music empire automation. Each channel = one niche AND one **workflow type**:

- **`ambient`** — 30 Suno songs → DistroKid release → 2-hour YouTube compilation video (static cover image looped) + thumbnail + metadata.
- **`rap-compilation`** — N Suno songs (default 10) → DistroKid release → variable-length YouTube video from per-track B-roll clips.
- **`ambient-video`** — 15 instrumental Suno prompts × 2 variants = 30 tracks → DistroKid release → YouTube video where the bed is a Magnific Seedance 2.0 Fast motion clip (looped). Final video = exactly **factor× the natural concat duration**, factor ∈ {1, 2, 3} (default 2; 1 = every song once / no repeat, 2 = twice, 3 = three times; the `make-medieval-video.bat` launcher prompts the operator and exports `AMBIENT_VIDEO_LOOP_FACTOR`, read by ambient-video branchB — `channel.targetVideoSeconds` stays ignored for this workflow). Image (Magnific Seedream 5 Lite Fast) + video (Magnific Seedance, mode=image-to-video) both route through the freepik-runner. See `domain-workflows` for step-level details.

Operator manually uploads to YouTube. Daily YouTube Data API stats per channel.

Single Windows machine (RTX 4070), Node 20, TypeScript, Next.js 14, SQLite (better-sqlite3, schema version tracked by `DB_VERSION` in `src/lib/db.ts`), Tailwind. Python 3.10+ for the Suno sidecar. **Strict serial across albums; parallel within one album** (DistroKid step + video render fork).

## Account Model

One Suno + one DistroKid + one Google Flow + one Freepik Premium account, shared across all channels. Each channel maps to a distinct DistroKid **artist profile** (Musician+ plan required). Freepik Premium gives unlimited Seedream/Seedance generations. Suno Premier required (~600 songs/week at scale).

## Development Commands

```
npm install
npm run dev              # Next.js (3003) + worker + scheduler via concurrently
npm run build
npm run start
npm run db:init
npm run db:seed
npm run test
npm run lint
npm run suno:login
npm run distrokid:login
npm run flow:login
npm run freepik:login    # ambient-video image gen
npm run freepik:bridge   # standalone bridge for the freepik-runner extension
```

## Architecture

```
src/
  app/                            # Next.js dashboard (channels, albums, settings, health, stats)
  worker/
    pipeline.ts                   # Workflow-driven orchestrator (parallel fork at step 06 / branchB)
    runner.ts                     # Strict-serial queue (1 album at a time globally)
    scheduler.ts                  # Cron-style scheduler subprocess
    stats-fetcher.ts              # Daily YT stats fetcher subprocess
    workflows/                    # Registry: ambient.ts, rap-compilation.ts, ambient-video.ts, checks.ts
    steps/                        # 01..11 + workflow-specific variants (07-rap, 09-rap, 01b, 05a-amv, 05b-amv, 08-seedance, 09-amv-mux)
  lib/
    llm/                          # OpenRouter client (chat-completions; supports system/temperature/maxTokens/responseFormat)
    suno/                         # suno-runner bridge
    distrokid/                    # distrokid-runner bridge
    flow/                         # flow-runner bridge (ambient + rap only)
    freepik/                      # freepik-runner client (Magnific via local bridge — ambient-video only)
    seedance/                     # Legacy REST client (mock-only); ambient-video routes Seedance through freepik-runner
    yt-stats/, audio/, broll/, render/, repos/
    prompts.ts                    # resolveChannelPrompt + mock directive helpers
    tracks-per-album.ts           # resolveTracksPerAlbum(channel, workflow)
extensions/
  suno-runner/                    # Node bridge :7341 + Python sidecar spawner
  distrokid-runner/               # Chrome extension :7342
  flow-runner/                    # Chrome extension :7343
  freepik-runner/                 # Chrome extension :7344 (Magnific image-gen + image-to-video)
sidecars/suno/                    # Python sidecar — Suno API + Chrome-CDP captcha
prompts/
  channel-templates/<id>/         # Per-channel overrides (filename = PromptKind)
  defaults/                       # Workflow-aware default templates
data/                             # SQLite, chrome profiles, oauth tokens
projects/<channel_id>/source.jpg  # ambient-video — channel-level operator override
projects/<channel_id>/<album_id>/ # cover.png, thumb.png, thumbs/ (ambient-video: 4 candidates), songs/, final.mp4, scene.json (ambient-video), build/
```

## Conventions

- **Spec is source of truth:** `docs/ambientforge-spec.md`. Update on every contract change.
- **Channel = config row, not code.** Adding a channel = INSERT. No code changes.
- **Workflow registry, not code forks.** Adding a workflow = a definition file in `src/worker/workflows/` + registry entry in `index.ts`. Never fork `pipeline.ts` / `runner.ts`.
- **Per-channel prompt resolution:** use `resolveChannelPrompt(channel, kind)`. Order: `channel.prompt_<kind>` (DB) → `prompts/channel-templates/<channelId>/<kind>.md` → `prompts/defaults/<workflow-basename>.md`. Channel-templates filenames use `PromptKind` (e.g. `cover-image.md`), NOT the workflow-default basename.
- **Strict serial across albums; parallel within one album.** Worker processes one album globally. WITHIN an album, branch A (DistroKid step 06) runs concurrently with the workflow-specific branch B (video render). Orchestrator joins them before step 10. Only allowed parallelism.
- **Workflow-aware branch B.** Ambient = `07 → 08 → 09`. Rap = `07-rap → 09-rap` (step 08 skipped). Ambient-video = `07 → 08-seedance → 09-amv-mux → 05b-thumbnail` (thumbnail runs LAST, best-effort; its pre-fork `step05b` slot is a noop). The thumbnail MUST stay after step 08 — step 08 reads its Seedance start frame from the just-generated image in the shared Magnific tab, so generating thumbnails before it bakes title text into the looped video bed. Branch A (step 06 DistroKid) is identical for all three.
- **`albums.workflow` is denormalized at create time.** Set only by `albumsRepo.create()` — never by a step. Historical accuracy depends on this being immutable per album.
- **YouTube Content ID hold:** `safe_to_upload_after = distrokid_submitted_at + content_id_hold_days * 86400000` (default 14 days). Dashboard "Mark as uploaded" enforces this.
- **Steps are stateless:** read from disk, write to disk. Orchestrator owns transitions.
- **Path aliases:** `@/` → `src/`. Worker uses `tsc-alias`.
- **Settings:** global in `settings` table (string-typed, Zod-coerced). Per-channel in `channels`. Pattern: `channel.fooBar ?? settings.foo_bar` — don't hardcode global values in steps.
- **DistroKid is irreversible.** Default `distrokid_dry_run=true`. Live mode requires double-confirm in dashboard.
- **Suno style prompts are per-channel collection, rotated per track.** Step 03 uses `selectSunoPromptRotation(channelId, albumId)`. Persisted on `tracks.suno_prompt_id` + `suno_prompt_resolved_text`. Album row stores track-1's pick as audit "primary" — never use `albums.suno_prompt_id` to drive Suno submissions; use the rotation helper. See `domain-suno` for legacy fallback + per-track FK semantics.
- **`sunoStylePrompt` ≠ `artistName`.** Two separate channel fields.
- **Audio is bit-identical** between DistroKid release and YouTube video. Stream-copy concat only. No xfade. No re-encode (except the single final-mux video re-encode in branch B).
- **Dev port is 3003.** Configured via `-p 3003` in dev/start scripts. Don't change.

## Project Skills

Skills under `.claude/skills/` (model-invocable):

| Skill | Description |
|-------|-------------|
| `tdd` | Test-driven development with red-green-refactor loop. Use when user wants to build features or fix bugs using TDD, mentions "red-green-refactor", wants integration tests, or asks for test-first development. |

Domain rules under `.claude/rules/` (load when modifying the matching area):

| Rule | Use when |
|------|----------|
| `domain-channels` | Channel CRUD, per-channel templates, scheduler config. |
| `domain-suno` | suno-runner extension, Suno bridge, steps 03-04, per-track style rotation, bridge-disruption recovery. |
| `domain-distrokid` | distrokid-runner extension, DistroKid bridge, step 06, live-mode gates. |
| `domain-flow` | flow-runner extension, Flow bridge, steps 05a-05b (ambient + rap). |
| `domain-audio` | FFmpeg concat, 2h loop, mux, thumbnail compositing. |
| `domain-workflows` | Workflow registry, adding new workflow types, branch B composition, ambient-video freepik flow, B-roll preflight, rap-branch 1920×1080 mux. |
| `domain-yt-stats` | YouTube Data API v3 client, stats fetcher, analytics dashboard. |

## Forbidden

- LLM calls outside OpenRouter.
- Parallel album execution. Two albums in `in_progress` simultaneously = banned.
- Parallel branches anywhere except the documented branch-A-vs-branch-B fork.
- Marking a video as uploaded before `safe_to_upload_after` (dashboard button enforces; do not bypass).
- Parallel Suno sessions from the shared account.
- Live DistroKid submission without the double-confirm gates (see `domain-distrokid`).
- Re-encoding concat audio. Stream-copy only.
- Crossfade / xfade between songs.
- HistForge-era deps: aeneas, ComfyUI, AI33, sbd. None used here.
- Hardcoding channel-specific values in step code. Always read from channel row + templates.
- Forking pipeline.ts/runner.ts to add a workflow type. Use the registry.
- Branching on `channel.workflow` / `album.workflow` inside step code. Steps should be workflow-agnostic; if behavior diverges, make a new step variant and override the slot in the workflow definition. **Single permitted exception:** step 10 overrides `ytTitle` with `album.scene_title` when `workflow === 'ambient-video'`.
- Bypassing the freepik-runner for ambient-video `source.jpg` or `clip.mp4`. Image gen + Seedance image-to-video both route through the freepik-runner — see `domain-workflows`.
- YouTube upload automation in v1. Metadata generation only.

## Troubleshooting

- `better-sqlite3` ELF/Win32 errors: `ensure-native-modules.js` pre-hook handles platform swap.
- Suno / DistroKid / Flow / Freepik session expired: run the matching `npm run <name>:login`.
- Freepik runner `FREEPIK_BRIDGE_UNREACHABLE`: `npm run freepik:bridge`. See `domain-workflows` if selectors broke.
- Worker not picking up: `queue_state` setting → `running`.
- Scheduler not enqueuing: `scheduler_enabled` setting → `true`.
- TDD / red-green-refactor work: use the `tdd` skill.
