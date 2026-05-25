# Chatterbox parallelism — fast inference fork + parallel chunks

## Overview

Make Chatterbox TTS narration meaningfully faster without sacrificing audio quality by (a) swapping the upstream `chatterbox-tts` engine for `rsxdalv/chatterbox@fast` (KV-cache rework, static-embedding caching, hot-loop branch elimination), and (b) running multiple sentence-grouped chunks concurrently inside a new minimal FastAPI sidecar. HistForge sends a chunk array to the sidecar; the sidecar generates each chunk on a shared model via `ThreadPoolExecutor` and returns a single concatenated WAV with brief silence padding at chunk joins.

## Current State

- **Provider**: `src/lib/tts/chatterbox.ts` — single synchronous `POST /tts` to `devnen/Chatterbox-TTS-Server` at `http://127.0.0.1:8004`. Sends full script in one request, gets one WAV back, transcodes WAV→MP3 via `chatterbox-transcode.ts`. Cancellation already threaded via `opts.signal`.
- **Step**: `src/worker/steps/06-voiceover.ts` — thin glue (read `script/full_script.md` → call `provider.synthesize(text, outPath, …)` → write `audio/narration.mp3`). Provider-agnostic.
- **Settings (7 Chatterbox keys)**: `src/lib/db.ts` (defaults), `src/lib/settings.ts` (Zod schema, ranges), `src/lib/settings-enums.ts` (`chatterbox_voice_mode` enum), `src/lib/settings-tabs.ts` (TTS tab grouping), `src/app/settings/tts-settings.tsx` (UI).
- **Provider registry**: `src/lib/tts/index.ts` — keyed by string; `getTtsProvider("chatterbox")` returns `chatterboxProvider`. Resolved per-video at `src/worker/pipeline.ts:~302-306` from `snapshot.tts_provider`.
- **Existing devnen sidecar**: install guide at `docs/setup-guides/setup-chatterbox.md`. Async route but synchronous inference, no internal parallelism, fan-out from the client would race the model — adding parallelism on top of devnen is not viable.
- **Hardware**: RTX 4070 (12 GB VRAM, Ada/sm_89), 32 GB RAM, Python 3.14 on PATH (use `py -3.11` or `py -3.12` for the sidecar venv since `chatterbox-tts` wheels and torch wheels target 3.10–3.12).

## Scope

**Doing**:
- New standalone Python sidecar `chatterbox-fast-server/` (FastAPI) using `rsxdalv/chatterbox@fast` internally, exposing `/tts` (single chunk) and `/tts/batch` (array of chunks → concatenated WAV).
- Internal parallelism via `ThreadPoolExecutor` over a single shared `ChatterboxTTS` model instance (CUDA dispatches release the GIL — confirmed pattern from petermg).
- HistForge-side sentence-aware chunker in `src/lib/tts/chunker.ts` (English-focused, abbreviation-aware sentence split + group-to-budget + long-sentence fallback).
- New "fast" provider `src/lib/tts/chatterbox-fast.ts` registered alongside the existing `chatterbox` provider — selectable per-workflow via `tts_provider` enum (so existing Chatterbox users keep their flow until they opt in).
- Settings: new keys for fast-sidecar URL, worker count, max chunk chars, silence padding ms; mirrored UI under Settings → TTS.
- Operator install guide at `docs/setup-guides/setup-chatterbox-fast.md` mirroring the structure of `docs/setup-guides/setup-chatterbox.md`.
- Smoke and unit tests for the new chunker, fast provider, and the chunk concatenation contract; an end-to-end manual smoke on a short real video.

**Not doing**:
- Whisper validation (parked; can be added later as opt-in setting).
- pyrnnoise denoise / auto-editor silence trimming (parked).
- Voice-conversion (VC) endpoint; the sidecar is TTS-only.
- Replacing the existing devnen-based `chatterbox` provider — both coexist; users switch by editing the workflow.
- Streaming / chunk-by-chunk response — the sidecar concatenates server-side and returns one WAV per request to keep `chatterbox.ts`'s "one MP3 out" contract.
- Cross-chunk prosody continuity (each `model.generate()` call decides its own intonation; sentence-boundary chunking with brief silence padding masks this acceptably for narration).

## Tasks

### Phase 0: Spike — confirm fast fork works standalone

Verify the engine before we wrap it. Throwaway venv, no repo changes.

- [x] **Task 0.1: Install `rsxdalv/chatterbox@fast` in a fresh venv and run a single `model.generate()` call**
  **Files**: none committed; scratch venv on operator machine
  **What**: Prove the fast fork loads on RTX 4070 and produces a WAV from a 2-3 sentence test string. Note time-to-first-token, time-to-completion, peak VRAM (`nvidia-smi` while generating), and audible quality vs current devnen output for the same text. Run through `docs/setup-guides/setup-chatterbox-fast.md` Section 1 — that draft is the install spec. Update Section 1 if anything diverges on your hardware (different torch wheel, different missing dep, etc.).
  **Context**: Install pattern derives from `docs/setup-guides/setup-chatterbox.md:62-105` (Python 3.10/3.11/3.12 venv, `setuptools<81` pin for `resemble-perth`, `--no-deps` install of the chatterbox repo to keep your chosen torch version, `--force-reinstall "protobuf>=4.25.0"` after). The fast fork's `pyproject.toml` ships looser torch pins than upstream so a stock CUDA 12.1 torch wheel works.

- [x] **Task 0.2: Verify `speed_factor` handling in the fast fork** — **resolved during Phase 0 spike**
  **Outcome**: The fast fork's `generate()` signature is `generate(self, text, audio_prompt_path=None, exaggeration=0.5, cfg_weight=0.5, temperature=0.8, tokens_per_slice=None, remove_milliseconds=None, remove_milliseconds_start=None, chunk_overlap_method=None, max_new_tokens=1000, max_cache_len=1500)`. **No `speed_factor` parameter.** Picking path (c): apply speed via ffmpeg `atempo` in the existing `wavBytesToMp3` transcode. Reasons: pitch-preserving (unlike `torchaudio.functional.resample`), free perf-wise (we already spawn ffmpeg for WAV→MP3), and keeps the sidecar dumb. Task 1.2 owns the `chatterbox-transcode.ts` change (optional `speed` opt threaded through, defaults to 1.0).
  **Files affected downstream**: `src/lib/tts/chatterbox-transcode.ts`, `__tests__/unit/lib/tts/chatterbox-transcode.test.ts` (now confirmed in Task 1.2's file list, no longer conditional).
  **Side finding**: `generate()` returns a Python generator that yields tensor chunks of shape `(1, samples)`, not a single tensor. The fork's own `example_tts.py` is stale. Task 1.1's sidecar must `list()` the generator and `torch.cat([c.cpu() for c in chunks], dim=-1)` before writing WAV bytes.

### Phase 1: Single-chunk fast path end-to-end

Deliver a working fast Chatterbox path with no parallelism yet — one chunk in, one WAV out. This decouples "engine swap" from "parallelism" so we know which one moves the needle.

- [x] **Task 1.1: Scaffold `chatterbox-fast-server/` sidecar with `/tts` (single chunk)**
  **Files**: `chatterbox-fast-server/server.py`, `chatterbox-fast-server/requirements.txt`, `chatterbox-fast-server/voices/.gitkeep`, `chatterbox-fast-server/reference_audio/.gitkeep`, `chatterbox-fast-server/.gitignore`, `chatterbox-fast-server/README.md` (short pointer), root `.gitignore`
  **What**: FastAPI app that loads `ChatterboxTTS.from_pretrained(device="cuda")` once at startup, exposes `POST /tts` accepting `{ text, voice_mode, voice_filename, temperature, exaggeration, cfg_weight, workers? }` and returns a WAV body. (No `speed_factor` field — Task 0.2 resolved this by moving speed handling to the HistForge transcode stage; the sidecar emits unmodified-tempo WAV.) Resolution rule the sidecar must implement: `voice_mode == "predefined"` → pass `voices/{voice_filename}` as `audio_prompt_path`; `voice_mode == "clone"` → pass `reference_audio/{voice_filename}`. (Chatterbox's `model.generate()` only knows `audio_prompt_path`; the predefined/clone split is purely a directory convention inherited from devnen.) Mirrors devnen's voice-folder layout so operators can symlink from their existing devnen install. Default port `8005` (different from devnen's `8004` so both can run side-by-side). `workers` parameter accepted for forward-compatibility with Phase 2 but ignored in `/tts` (single chunk). **Generator API**: `model.generate()` yields tensor chunks of shape `(1, samples)`, not a single tensor (per Task 0.2 side finding). Sidecar must `list()` the generator and `torch.cat([c.cpu() for c in chunks], dim=-1)` before serializing to WAV bytes (16-bit PCM, mono, `model.sr` Hz).
  **Context**: Devnen's request shape is documented in `docs/setup-guides/setup-chatterbox.md:130-147`. Match the field names (minus `speed_factor`) so `chatterbox-fast.ts` can reuse `chatterbox.ts`'s body-builder (lines 81-94) with one field stripped. Single global model — no per-request model load. `requirements.txt` over `pyproject.toml` because the sidecar is operator-installed not pip-published, and `requirements.txt` matches devnen's convention. Pin `transformers==4.46.3`, `diffusers==0.29.0`, `s3tokenizer==0.3.0` (same as `setup-chatterbox-fast.md` Section 1) — the fast fork's loose pins break model load on transformers 5.x.

- [x] **Task 1.2: Add `chatterboxFastProvider` and register it**
  **Files**: `src/lib/tts/chatterbox-fast.ts`, `src/lib/tts/index.ts`, `src/lib/tts/meta.ts`, `src/lib/tts/chatterbox-transcode.ts`, `__tests__/unit/lib/tts/chatterbox-fast.test.ts`, `__tests__/unit/lib/tts/meta.test.ts`, `__tests__/unit/lib/tts/index.test.ts`, `__tests__/unit/lib/tts/chatterbox-transcode.test.ts` (transcode files now confirmed — Task 0.2 picked the ffmpeg `atempo` path)
  **What**: New provider that mirrors `chatterbox.ts` but reads new fast-only settings (`chatterbox_fast_base_url`) and posts to the fast sidecar. Reuse `wavBytesToMp3` from `chatterbox-transcode.ts` for the WAV→MP3 transcode. Register under key `"chatterbox-fast"` in `index.ts`. Add a `chatterbox-fast` entry to `TTS_PROVIDER_META` (label `"Chatterbox (fast)"`, empty `envKey`, endpoint `127.0.0.1:8005`). Update existing meta and index tests to assert the new entry.

  **Phase 1 safety guard**: at the top of `synthesizeChatterboxFast`, after reading settings, throw a clear error if `text.length > 12000` (rough ~6-8 min narration ceiling for a 4070's VRAM with the fast fork's no-internal-chunking behavior). Error message: *"Chatterbox (fast) doesn't support scripts longer than ~6 min in Phase 1 — use the `chatterbox` provider (devnen) for longer scripts until parallel chunking lands in Phase 2."* Task 2.3 removes this guard once the chunker handles arbitrary lengths.

  **Speed handling (from Task 0.2)**: `chatterbox-transcode.ts` gains an optional `speed?: number` opt (defaults to 1.0 = no-op). When set, the ffmpeg invocation adds `-filter:a "atempo={speed}"` (clamping to 0.5–2.0 since `atempo` requires 0.5 ≤ x ≤ 2.0; chain two atempo filters for 0.25× or 4×, e.g. `atempo=2.0,atempo=2.0` for 4×). Provider reads `chatterbox_speed_factor` from settings and passes it as the `speed` opt. Sidecar request body does NOT include `speed_factor` — speed is applied post-WAV in Node.

  **Context**: Follow the structure of `src/lib/tts/chatterbox.ts:55-130` exactly — same dispatcher pattern (long-running undici timeouts), same signal handling, same body shape (minus `speed_factor`; the optional `workers` field that Task 1.1's sidecar accepts is unused in Phase 1; Task 2.3 starts sending it). Provider tests follow `__tests__/unit/lib/tts/chatterbox.test.ts` (real DB, fake fetch, fake transcode injection) — add a test case for the Phase 1 length guard, and add transcode tests covering the `speed` opt (no-op at 1.0, `atempo` filter args at 0.5/1.5/2.0, chained `atempo,atempo` at 4.0).

- [x] **Task 1.3: Settings — new fast-sidecar keys (single-chunk subset)**
  **Files**: `src/lib/db.ts`, `src/lib/settings.ts`, `src/lib/settings-tabs.ts`, `src/app/settings/tts-settings.tsx`, `__tests__/unit/lib/settings.test.ts`, `__tests__/unit/lib/db.test.ts`
  **What**: Add `chatterbox_fast_base_url` (default `"http://127.0.0.1:8005"`) to db.ts defaults, settings.ts Zod schema, and `TAB_FIELDS.tts` in settings-tabs.ts (without the last edit, the schema accepts the key but the UI tab shows nothing). The voice settings (`chatterbox_voice_mode`, `chatterbox_voice_filename`, tuning sliders) are reused as-is — the fast sidecar mirrors devnen's voice-folder layout, so the same filename works in both providers. UI: render the new fast base URL field always (the Settings page is global, not workflow-scoped, and `tts-settings.tsx` has no notion of "active provider"). Place it directly below the existing `chatterbox_base_url` input inside `ChatterboxView`. If Task 0.2 dropped `speed_factor` support for the fast path, add helper text under the existing `chatterbox_speed_factor` slider noting it only applies to the devnen-backed `chatterbox` provider.
  **Context**: Existing Chatterbox settings registration in `src/lib/db.ts` and the Zod schema in `src/lib/settings.ts` — copy that shape. `settings-tabs.ts:48-63` lists every Chatterbox key under `TAB_FIELDS.tts`; append the new key here. UI section pattern in `src/app/settings/tts-settings.tsx` (existing `ChatterboxView`). Settings test patterns in `__tests__/unit/lib/settings.test.ts` ("chatterbox settings" describe block).

- [x] **Task 1.4: Workflow registry — add `chatterbox-fast` to the `tts_provider` enum**
  **Files**: `src/lib/workflows-schema.ts`, `src/app/workflows/[id]/edit/edit-form.tsx`, `__tests__/api/workflows/schema/__snapshots__/schema.json`, `__tests__/components/workflows/edit-form.test.tsx`
  **What**: Add `"chatterbox-fast"` to the `tts_provider` enum (`workflows-schema.ts:27`) and a `{ value: "chatterbox-fast", label: "Chatterbox (fast)" }` option in the workflow editor dropdown (`edit-form.tsx:~396`). Update the schema snapshot.
  **Context**: Existing `chatterbox` registration in those files is the precedent — paste-and-rename. Drift hazard: `meta.ts:48` derives `TtsProviderId` from `TTS_PROVIDER_META`, but the workflow row's `tts_provider` enum here is hand-maintained (per the explicit comment at `meta.ts:11`). Adding to one but not the other type-checks but mismatches at runtime — Task 1.2 (meta.ts) and this task (workflows-schema.ts) must both ship. Verify by running `npm run lint` and `npm run test` after both — any test that round-trips a workflow with `tts_provider: "chatterbox-fast"` will fail loudly if the schema enum is missing it.

- [~] **Task 1.5: Manual end-to-end smoke (no parallelism yet) — DEFERRED into Task 2.5**
  **Status**: Deferred 2026-05-08. Scope folded into Task 2.5 (Phase 2 smoke). Engine + transport were validated via a direct `/tts` `Invoke-RestMethod` smoke against the running sidecar (returned a playable WAV at the same `voice_filename` used on devnen) — the wiring is healthy. The full HistForge → sidecar end-to-end path was not validated because HistForge's LLM step routinely produces scripts >1500 chars even for nominally-tiny chapters, so we cannot construct a Phase-1-safe real video without inventing a synthetic short input. That validation lands inside Task 2.5 once the chunker removes the per-call limit.
  **Files**: none
  **Original intent (preserved for reference)**: Run a short real video (`chapter_count: 2-3`, target ~3-5 min narration) on a workflow whose `tts_provider` is `chatterbox-fast`. Confirm step 06 produces `audio/narration.mp3` that plays correctly, alignment (step 07) succeeds, voice matches devnen. Compare wall-clock against the same video on `chatterbox` — fast fork should be 1.3–2× faster on short scripts even without parallelism.
  **What we learned during the deferred smoke** (corrected 2026-05-08): the hard limit during Phase 1 is **~1500 chars (~1.5 min narration)** — not the 12000 chars / "10–15 min OOM" the original plan estimated. Scripts longer than that trigger a CUDA device-side assert from t3 text-encoder position-embedding overflow during inference. The crash also poisons the GPU context for the rest of the sidecar process, so the operator must restart `server.py` to recover. The in-code length guard in `chatterbox-fast.ts` was retuned from 12000 → 1500 to fail fast on the HistForge side before the sidecar ever sees the request. Phase 2's chunker is now load-bearing for *any* real-world script, not just a parallelism feature — Phase 1 alone delivers a degraded smoke-only path.
  **Context**: Smoke pattern from `docs/setup-guides/setup-chatterbox.md:204-209`. Limitations + recovery procedure documented in `docs/setup-guides/setup-chatterbox-fast.md` "Phase 1 limitations" section.

### Phase 2: Parallel batch end-to-end

Now add the parallel chunk path. This is the bigger speedup.

- [x] **Task 2.1: Add `/tts/batch` to the sidecar with internal `ThreadPoolExecutor`**
  **Files**: `chatterbox-fast-server/server.py`
  **What**: New endpoint accepting `{ chunks: [str], voice_mode, voice_filename, …tuning…, silence_ms, workers }` and returning a single concatenated WAV (with `silence_ms` of digital silence inserted between chunks). `workers` is read from the request body (per-request, not env var) and clamped to `[1, MAX_WORKERS]` where `MAX_WORKERS` is a sidecar config constant (start at 4 for the 4070; tune after Task 2.5 measurement). Internally: `ThreadPoolExecutor(max_workers=workers)` over a single shared `ChatterboxTTS` model loaded at startup; each worker calls `model.generate(chunk_text, audio_prompt_path=…)`. Preserve input order on output (use `executor.map` or index-tracked `submit`/`as_completed`). Refactor existing `/tts` to delegate to `/tts/batch` with a one-element list — single source of truth.
  **Context**: Petermg's parallelism design (concept only — `concurrent.futures.ThreadPoolExecutor` over a shared `ChatterboxTTS` model; we don't run their code). Per-request `workers` (vs env var) means HistForge tunes parallelism without restarting the sidecar — simpler operator workflow. VRAM on RTX 4070: a single Chatterbox model is ~2 GB fp16; with KV-cache + activations during 2 concurrent generations expect 6–8 GB used. **Validate VRAM during smoke** — bump to 3 workers if headroom, drop to 1 if OOM. Concatenation: 16-bit PCM, 24 kHz mono (Chatterbox's native rate, confirmed via `model.sr` after Phase 0); raw NumPy `np.concatenate([wav, silence, wav, …])` then `scipy.io.wavfile.write` or `torchaudio.save`.

- [x] **Task 2.2: HistForge-side chunker `lib/tts/chunker.ts`**
  **Files**: `src/lib/tts/chunker.ts`, `__tests__/unit/lib/tts/chunker.test.ts`
  **What**: Pure function `chunkScript(text: string, opts: { maxChars: number }): string[]`. Logic: (1) sentence-split on `[.!?]` + whitespace + capital-or-quote, with abbreviation guard (Mr./Dr./Mrs./St./vs./etc./e.g./i.e./No./U.S./U.K./Jr./Sr.); (2) greedy-pack sentences into chunks ≤ `maxChars`; (3) any single sentence > `maxChars` falls back to splitting on `; : — - ,` (in that priority); (4) any remaining segment > `maxChars` splits on word boundaries (`/\s+/`), never mid-word. No external dependencies — small enough to own. Strip leading/trailing whitespace from chunks but never collapse internal whitespace (preserves prosody-affecting punctuation).
  **Context**: Petermg's reference design — sentence-tokenize, then greedy-group up to ~300 chars, with a fallback split. Default `maxChars` = 300 (configurable via `chatterbox_fast_max_chunk_chars` setting in Task 2.4). Test cases must include: short text (1 chunk), abbreviations (don't break "Mr. Smith said."), em-dashes, the long-sentence fallback ladder, and the never-mid-word invariant.

- [x] **Task 2.3: Switch `chatterbox-fast.ts` to call `/tts/batch` (and remove the Phase 1 length guard)**
  **Files**: `src/lib/tts/chatterbox-fast.ts`, `__tests__/unit/lib/tts/chatterbox-fast.test.ts`
  **What**: Provider runs `chunkScript(text, { maxChars })`, posts the chunk array + voice settings + `silence_ms` + `workers` to `/tts/batch`, receives concatenated WAV, transcodes to MP3 the same way as Phase 1. Log `chunks.length` and elapsed wall-clock through `opts.log?.(message)` (which routes to `appendLog` via `06-voiceover.ts:41`). Single-chunk inputs still work — chunker emits a one-element array, sidecar handles it via the `/tts` delegation in Task 2.1. Update existing tests to assert the new request body shape (chunks array, workers, silence_ms). **Remove the Phase 1 length guard** added in Task 1.2 — the chunker handles arbitrary lengths now. Update or delete the corresponding test case.
  **Context**: `chatterbox.ts:55-126` is the structural model. Cancellation: pass `signal` to fetch and to `wavBytesToMp3` exactly as `chatterbox.ts` does.

- [x] **Task 2.4: Settings — parallelism/chunking keys**
  **Files**: `src/lib/db.ts`, `src/lib/settings.ts`, `src/lib/settings-tabs.ts`, `src/app/settings/tts-settings.tsx`, `__tests__/unit/lib/settings.test.ts`, `__tests__/unit/lib/db.test.ts`
  **What**: Add three keys with sensible defaults, all with the `chatterbox_fast_` prefix to mark them as fast-path-only:
    - `chatterbox_fast_max_chunk_chars` (default `"300"`, range 100–2000)
    - `chatterbox_fast_silence_ms` (default `"150"`, range 0–1000)
    - `chatterbox_fast_workers` (default `"2"`, range 1–4)
  All three are passed on each request to `/tts/batch` (Task 2.3 reads them, Task 2.1 honors them). Append all three keys to `TAB_FIELDS.tts` in `settings-tabs.ts` (same blocker as Task 1.3 — schema accepts but UI shows nothing without this). UI: place under the Chatterbox-fast section in `tts-settings.tsx` with helper text explaining (a) workers is per-request — no sidecar restart needed; (b) silence_ms is the gap inserted between chunks at concatenation; (c) max_chunk_chars is the sentence-grouping budget.
  **Context**: Range/coercion tests follow the existing `speed_factor` clamping cases in `__tests__/unit/lib/settings.test.ts`. Settings UI component pattern: existing `ChatterboxView` in `tts-settings.tsx`.

- [~] **Task 2.5: End-to-end smoke + speedup measurement** — **deferred to operator**
  **Status**: Code-complete blocker. Requires the operator to (a) start the sidecar (`python chatterbox-fast-server/server.py`), (b) run a real 8–12 chapter video on a workflow whose `tts_provider` is `chatterbox-fast`, and (c) record nvidia-smi VRAM peaks and step-06 wall-clock at `chatterbox_fast_workers` = 1, 2, 3. Cannot be executed from a Claude session — needs real GPU + a real video pipeline run.
  **Files**: none committed; results recorded in a comment on the PR
  **What**: Run a longer video (8–12 chapters, 15-25 min narration) on `chatterbox-fast`. Measure step 06 wall-clock at `chatterbox_fast_workers` = 1 (chunked but serial — isolates chunking overhead), 2, and 3. Record VRAM peaks via `nvidia-smi -l 1` in another terminal. Listen end-to-end for: (a) audible chunk seams (should be masked by 150 ms padding at sentence ends), (b) voice consistency across chunks, (c) any garbled words. Compare against the same video rendered on the existing `chatterbox` (devnen) provider for both speed and quality. If quality regresses or seams are audible at sentence ends, increase `chatterbox_fast_silence_ms` or revisit chunker boundary rules.
  **Context**: This is the gating test for whether the parallel design is shippable. If voice-consistency fails (e.g. emotion drift between chunks at high `exaggeration`), the fix is either (i) clamp `exaggeration` to ≤0.5, (ii) add a fixed seed parameter so all chunks share a sampling seed, or (iii) increase `chatterbox_fast_max_chunk_chars` so chunks are larger (fewer joins, fewer drift opportunities).
  **Update (2026-05-09)**: Thread-safety prerequisite landed via `docs/plans/2026-05-09-chatterbox-fast-model-pool.md` — the sidecar now leases a per-worker `ChatterboxTTS` instance from a `ModelPool` instead of sharing one model across threads, fixing the rsxdalv@fast cache-init races and KV-cache corruption that would have crashed concurrent generations. Smoke scope (`chatterbox_fast_workers` = 1, 2, 3; VRAM peaks; wall-clock vs devnen) is unchanged; deferral is now purely on operator GPU + real video, no longer blocked on a code defect.

### Phase 3: Operator polish

- [ ] **Task 3.1: Finalize `docs/setup-guides/setup-chatterbox-fast.md`**
  **Files**: `docs/setup-guides/setup-chatterbox-fast.md`
  **What**: Promote the Phase 0 install draft into a full operator guide mirroring `docs/setup-guides/setup-chatterbox.md`'s structure: Hardware, Prerequisites, Install (with the `setuptools<81` and protobuf gotchas), Verify, Day-to-day startup, Voice library, Point HistForge at it (Settings → TTS), Smoke test end-to-end, License/watermark, Troubleshooting. Include a clear note that this sidecar is *additive* — the devnen sidecar can keep running on port 8004 if the operator wants both.
  **Context**: Existing setup guide `docs/setup-guides/setup-chatterbox.md` is the template — copy structure, replace install commands and port number, document the new settings, add a "Tuning workers / chunk size" subsection that explains the speed↔quality tradeoff.

- [ ] **Task 3.2: Update `domain-media` skill anchors**
  **Files**: `.claude/skills/domain-media/SKILL.md`
  **What**: Add the `chatterbox-fast` provider to the "Chatterbox vs cloud providers" section and the Common Pitfalls list. Add anchor entries for the new contract names — e.g. `chunker` (sentence-aware splitter the fast provider runs before posting; English-focused, abbreviation-guarded), `chatterbox-fast` (fast-fork sidecar on port 8005 exposing `/tts` and `/tts/batch`), `wavBytesToMp3` (already exists; note that the fast provider reuses it). Per CLAUDE.md, anchors are contract names, not file paths or symbol locations — resolve against the current codebase at read time.
  **Context**: Existing Chatterbox section at `.claude/skills/domain-media/SKILL.md:~61-69` is the precedent.

- [ ] **Task 3.3: Update `CLAUDE.md` skill tables**
  **Files**: `CLAUDE.md`
  **What**: No new skill needed — this work belongs in `domain-media`. Add a one-line troubleshooting bullet under "Troubleshooting" pointing to `docs/setup-guides/setup-chatterbox-fast.md` for the parallel-sidecar install path.
  **Context**: Existing Troubleshooting section at the bottom of `CLAUDE.md`.

## Open quality risks (track during Phase 2 smoke)

1. **Audible chunk seams** at concatenation boundaries. Mitigation: 150 ms silence padding at sentence ends. Escalation: try cross-fade in the sidecar (3-5 ms hann window) if padding alone isn't enough.
2. **Voice / emotion drift across chunks**. Mitigation: same `audio_prompt_path` + same temperature on every chunk. Escalation: introduce a `seed` parameter passed identically to all chunks in a batch (would require a small change to the rsxdalv fork's `generate()` if it doesn't already accept a seed).
3. **VRAM OOM at workers=3+** on a 4070. Mitigation: default workers=2, document workers=3 as "try it, fall back if OOM". Escalation: use CUDA streams instead of separate threads (more complex; only if needed).
4. **Cancellation mid-batch**: signal aborts the fetch; the sidecar's threadpool keeps running until the workers finish their current chunks. Acceptable — same as devnen today (mid-generation cancellation just discards the in-flight WAV). Document this in the sidecar README.
5. **Whisper validation parked**: if quality holds, it stays parked. If we see word-level errors (skipped phrases, garbled words), revisit as a Phase 4 add-on with an opt-in `chatterbox_fast_validate_whisper` setting (fast-path-only; the devnen-backed `chatterbox` provider doesn't chunk and doesn't need it).
6. **`speed_factor` parity with the devnen path** depends on Task 0.2's verification. If the fast fork doesn't natively support it, we either replicate via ffmpeg `atempo` (clean, ±10% pitch-preserving up to 2×) or document the limitation. If we end up with non-parity, document the caveat in `docs/setup-guides/setup-chatterbox-fast.md` (Task 3.1's Settings section) so operators see it where they actually configure the provider. A workflow-editor warning when switching providers with `speed_factor != 1.0` would be nice-to-have but is not in this plan's scope — add it as a follow-up if operators report surprise.
7. **Phase 1 long-script overflow** (corrected during 1.5 smoke 2026-05-08, was estimated as "OOM" but is actually a different failure mode): the *first* failure mode isn't VRAM OOM — it's **t3 text-encoder position-embedding overflow** at ~1500 chars (~1.5 min of narration), much earlier than VRAM ever becomes the bottleneck. Surfaces as a CUDA device-side assert during inference and **poisons the GPU context for the rest of the sidecar process** (operator must restart `server.py` to recover). The in-code length guard in Task 1.2 was retuned from 12000 → 1500 chars; removed in Task 2.3 once the chunker handles arbitrary lengths. Phase 2 is now load-bearing for *any* real-world script, not just a speed/parallelism feature — Phase 1 alone delivers a degraded smoke-only path.
8. **Both sidecars on the same GPU**: if devnen (8004) and the fast sidecar (8005) are both running, each holds a separate model copy in VRAM (~4 GB just for the two models) plus per-generation overhead. The 4070 can comfortably serve either one actively, but concurrent generations across both will OOM. Document in `docs/setup-guides/setup-chatterbox-fast.md` that operators should stop one sidecar when actively narrating from the other (or accept that running both is fine for A/B comparison as long as only one is processing at a time).

## References

- `src/lib/tts/chatterbox.ts:55-130` — provider pattern (dispatcher, signal threading, body shape, transcode injection)
- `src/lib/tts/chatterbox-transcode.ts:39-106` — WAV→MP3 helper, reused unchanged
- `src/worker/steps/06-voiceover.ts:27-59` — caller; provider-agnostic, no changes needed
- `src/worker/pipeline.ts:~302-306` — provider resolution from `snapshot.tts_provider`
- `src/lib/db.ts` — Chatterbox setting defaults block (template for new keys)
- `src/lib/settings.ts` — Zod schema for Chatterbox keys (template for new keys with ranges)
- `src/lib/workflows-schema.ts:27` — `tts_provider` enum (add `"chatterbox-fast"`)
- `src/app/workflows/[id]/edit/edit-form.tsx:~396` — provider dropdown
- `src/app/settings/tts-settings.tsx` — `ChatterboxView` component pattern
- `__tests__/unit/lib/tts/chatterbox.test.ts` — provider test pattern (real DB, fake fetch, fake transcode)
- `__tests__/unit/lib/tts/chatterbox-transcode.test.ts` — spawn injection test pattern
- `docs/setup-guides/setup-chatterbox.md` — operator guide template; mirror this in `docs/setup-guides/setup-chatterbox-fast.md`
- `https://github.com/rsxdalv/chatterbox/tree/fast` — fast inference fork (engine)
- `https://github.com/petermg/Chatterbox-TTS-Extended` — parallelism reference design (don't ship, just borrow ideas)
