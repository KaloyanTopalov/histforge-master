# CLAUDE.md

## Project Overview

HistForge — an unattended pipeline that turns a one-line topic into a finished historical YouTube video. Next.js 14 dashboard + background worker process. SQLite (better-sqlite3), TypeScript, Tailwind CSS. Node >=20.

## Development Commands

```
npm install              # Install dependencies
npm run dev              # Start Next.js dev server + worker (concurrently)
npm run build            # Production build (Next.js + worker)
npm run start            # Production run (Next.js + worker)
npm run db:init          # Initialize SQLite database with schema + defaults
npm run test             # Run vitest tests
npm run test:watch       # Run vitest in watch mode
npm run lint             # ESLint
```

## Windows Environment

Windows host. Bash mangles `\` as escapes (`C:\Users\...` → `C:Users...`). Use Glob/Grep/Read/Edit, PowerShell, or forward slashes.

## Architecture

```
src/
  app/                   # Next.js App Router (dashboard UI)
    api/                 # API routes: videos, settings, health, queue, workflows, flow webhooks
    videos/, settings/, workflows/  # Dashboard pages
  worker/                # Background worker process (separate entry point)
    pipeline.ts          # Step orchestrator
    runner.ts            # Queue polling loop
    steps/               # Pipeline steps (01-09, 14-15, plus provider-specific image/video steps)
  lib/                   # Shared libraries (DB, settings, LLM, TTS, image, render, repos)
    workflows.ts         # Workflow registry — maps workflow_id → ordered step list
    workflows-import.ts  # AI-skill workflow drafts importer
    llm/                 # LLM client
    tts/                 # TTS provider registry
    image/               # Image provider registry + ComfyUI / Google Flow clients
    repos/               # Repository layer over SQLite
  types.ts               # Shared types (DB rows, file formats)
extensions/              # Chrome extensions (youforge-flow fork + veo-upstream reference)
prompts/                 # LLM prompt templates (Markdown), ComfyUI workflows (JSON), workflow drafts inbox
python/                  # Python helper (align.py — aeneas wrapper)
data/                    # SQLite database file (histforge.db)
docs/                    # Spec: docs/histforge-spec.md (canonical reference)
```

## Key Conventions

- **Spec is the source of truth:** `docs/histforge-spec.md` defines schema, settings, pipeline steps, and API contracts. Reference it for design decisions.
- **Domain skills carry stable knowledge plus a `## Anchors` block of contract names** — they do not list file paths or symbol locations. Resolve anchors against the current codebase rather than trusting any embedded path.
- **Worker steps are stateless:** Each step reads inputs from disk, writes outputs to disk. The orchestrator (`pipeline.ts`) owns step-row transitions, cleanup, and pause/resume.
- **Workflows, not forks:** A video's `workflow_id` picks its ordered step list at runtime via the registry. Add a workflow rather than forking step code when a pipeline variant is needed.
- **Per-video pacing overrides:** `videos.image_chunk_target_seconds` / `_min_` / `_max_` are nullable columns; NULL falls through to the global setting of the same name. The chunker resolves the triple at step entry via `getImageChunkPacing` in `src/lib/settings.ts` — never read the columns directly.
- **Magnific dispatch runtime:** Magnific dispatch goes through the HistForge-managed Playwright runtime (`src/lib/magnific-runtime/`); the operator-installed Chrome extension path is deprecated.
- **Path aliases:** `@/` maps to `src/` in both web and worker builds. Worker uses `tsc-alias` for post-compile resolution.
- **Types:** Import shared types from `src/types.ts`. DB row types mirror the SQLite schema. File-format types (AlignmentEntry, Chunk, etc.) are the single source of truth.
- **Settings:** All settings stored as strings in SQLite. `lib/settings.ts` handles type coercion. Defaults defined in `lib/db.ts`.
- **Prompts:** LLM prompt templates live in `prompts/` as Markdown files. `lib/prompts.ts` loads and interpolates them.

## Project Skills

| Skill | Description |
|-------|-------------|
| `domain-content-gen` | LLM content generation and prompt templating. Use when modifying steps 01-05/09, prompt templates, or LLM client parameters. |
| `domain-dashboard` | Next.js dashboard UI, API routes, SQLite schema, and settings system. Use when modifying pages, endpoints, schema, or settings Zod schemas. |
| `domain-google-flow-coordinator` | Server-side Google Flow coordinator — dumb-runner contract, account fleet, queue, webhook routes, reaper, per-(video, account) project mapping, and the producer/consumer worker steps. Use when modifying `app/api/flow/`, `lib/flow-*.ts`, the `google-flow` repo, the Settings > Google Flow UI, or the `generate-*-google-flow` steps. Pair with `domain-youforge-flow`. |
| `domain-media` | Media production pipeline — voiceover, alignment, chunking, ComfyUI image/hook-video, FFmpeg render. Use when modifying steps 06-08, provider-specific ComfyUI steps, step 14, step 15, or `lib/tts/` / `lib/image/` / `lib/align.ts` / `lib/render.ts`. (For Google Flow worker steps, see `domain-google-flow-coordinator`.) |
| `domain-pipeline` | Worker orchestration, queue system, step lifecycle. Use when modifying how steps execute, adding new steps, changing queue behavior, error handling, or crash recovery. |
| `domain-workflow-drafts` | AI-skill workflow-drafts pipeline — filesystem inbox under `prompts/workflows/`, drafts API routes, Drafts section on `/workflows`, and the round-trip JSON contract with the schema endpoint. Pair with `domain-workflows` for registry mechanics. |
| `domain-workflows` | Workflow registry — lets different videos run different pipelines without forking step code. Use when adding a workflow, adding provider-specific steps, changing workflow resolution, or modifying the workflow UI surface. |
| `domain-youforge-flow` | YouForge Flow Chrome extension — HistForge's "dumb runner" fork of VEO Flow API. Use when modifying the service-worker background, content scripts, popup, or flow-api wrapper under `extensions/youforge-flow/`. (For the HistForge-side coordinator, see `domain-google-flow-coordinator`.) |
| `tdd` | Test-driven development with red-green-refactor loop. Use when building features or fixing bugs using TDD. |

## Branch Strategy

- `master` — primary branch, all development

## Troubleshooting

- Pipeline step / orchestration issues: See `domain-pipeline` skill. Cross-check `docs/histforge-spec.md` for step contracts.
- Workflow registry / provider-step routing issues: See `domain-workflows` skill.
- Workflow drafts / AI-skill JSON imports / `/api/workflows/drafts` routes: See `domain-workflow-drafts` skill.
- Content generation issues: See `domain-content-gen` skill for prompt system, LLM client, and chapter writing flow.
- Media/render issues: See `domain-media` skill for TTS, alignment, ComfyUI, and FFmpeg rendering.
- Google Flow queue / accounts / webhook routes / reaper / `generate-*-google-flow` worker steps: See `domain-google-flow-coordinator` skill (HistForge side); pair with `domain-youforge-flow` (extension side).
- Dashboard/API issues: See `domain-dashboard` skill for route conventions, settings system, and page patterns.
- Chrome extension / YouForge Flow issues: See `domain-youforge-flow` skill for service-worker, content scripts, popup, and flow-api wrapper details.
- Build errors with `better-sqlite3`: It's a native module — excluded from webpack bundling via `next.config.js` `serverComponentsExternalPackages`.
- Worker not processing: Check `queue_state` setting — defaults to `"paused"`, must be set to `"running"`.
- ComfyUI setup: See `docs/setup-comfyui.md` for installation, checkpoint setup, custom workflows, and troubleshooting.
