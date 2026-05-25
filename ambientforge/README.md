# AmbientForge — Final Build Package

This is the complete, **patch-free** package. v3 architecture (parallel pipeline + Content ID hold) baked in. Nothing to merge or apply manually.

## Files

```
ambientforge/
├── CLAUDE.md
├── docs/
│   └── ambientforge-spec.md
├── .claude/rules/
│   ├── domain-channels.md
│   ├── domain-suno.md
│   ├── domain-distrokid.md
│   ├── domain-flow.md
│   ├── domain-audio.md
│   └── domain-yt-stats.md
└── sessions/
    ├── SESSION-00-PLAN.md
    ├── SESSIONS-1-TO-7.md
    └── SESSIONS-8-TO-13.md
```

## How to use

### Step 1 — Place files in your repo

Drop the contents of this package into your project folder (any folder name — `Music Automation`, `ambientforge`, doesn't matter). After extraction the structure should look exactly like above with `CLAUDE.md` at the root.

```
git init
git add .
git commit -m "scaffold: docs, rules, session prompts"
```

### Step 2 — Run plan mode

Open Claude Code in the folder. Press **Shift+Tab twice** for Plan Mode. Paste:

> Read `sessions/SESSION-00-PLAN.md` and execute the instructions in it. Read every file referenced before producing the plan. Save the plan to `docs/PLAN.md`. Do not write code in this session — plan only.

Claude reads everything, asks blocking questions, produces `docs/PLAN.md`.

If HistForge isn't accessible, Claude proceeds without it. The patterns are described well enough in CLAUDE.md and the rules.

Review the plan. When happy:
```
git add docs/PLAN.md
git commit -m "plan: v1 implementation plan approved"
```

### Step 3 — Run sessions 1-13 one at a time

For each session, **open a new Claude Code session** (do NOT continue the previous chat). Plan mode (Shift+Tab x2). Paste:

> Read `sessions/SESSIONS-1-TO-7.md` (or `SESSIONS-8-TO-13.md` for sessions 8+) and find "Session N — [name]". Execute that section. Read referenced files first. Produce a sub-plan, wait for my approval, then implement. Test before completing.

Replace **N** with 1, 2, 3, ... 13.

Workflow per session:
1. Claude shows sub-plan. Review.
2. Approve in chat ("looks good, proceed").
3. Switch to normal mode (Shift+Tab once).
4. Claude implements. Watch.
5. Tests pass: `git add . && git commit -m "session N: <feature>"`
6. Close that session. Open new one for N+1.

## Critical guardrails baked in

- `distrokid_dry_run=true` is default. Live mode disabled until 2 dry-runs + double-confirm.
- `safe_to_upload_after` enforced at UI level — operator can't upload until 14 days (default) after DistroKid submission.
- Strict serial across albums. Parallel only within one album (DistroKid + render).
- Suno pre-flight credit check before step 03.
- Audio validation (ffprobe) after every Suno download.
- Channels are config rows, not code.
- YouTube uploads stay manual. Read-only stats OAuth only.

## Account requirements

- Suno **Premier** ($30/mo) for 600 songs/week capacity.
- DistroKid **Musician+** ($40/year) for unlimited artists.
- Google Flow paid tier for image volume.
- Google account with YouTube Data API v3 enabled (read-only OAuth, free).
- OpenRouter account with credits.
- Each channel's DistroKid artist profile must already exist in DistroKid before that channel goes live.

## Recommended first run

Don't seed 20 channels day one. Run sessions 1-13 → seed 1-2 channels → run dry-run pipeline → upload one video manually → wait 14 days → check Content ID didn't flag → flip DistroKid live for that one channel → wait another week → if clean, scale up.

The 14-day hold + 2 dry-run requirement means your first live release is ~3 weeks after starting. Worth it.
