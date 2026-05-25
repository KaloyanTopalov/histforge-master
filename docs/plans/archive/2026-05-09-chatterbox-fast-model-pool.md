# Chatterbox fast sidecar — model pool for safe parallelism

## Overview

The chatterbox-fast sidecar currently shares a single `ChatterboxTTS` instance across worker threads via `ThreadPoolExecutor`. The rsxdalv@fast fork caches state on `self` (KV cache, position-embedding cache, speech-embedding cache) — that state is not thread-safe, so concurrent `model.generate()` calls crash on cache-init races and silently corrupt the KV cache. Fix by swapping the shared model for a **pool of models, one per concurrent worker**: lazy-load on demand up to the request's `workers` value, lease per chunk via a `queue.Queue` (models are reused across chunks but never held by two threads at once), never let two concurrent inferences touch the same model. Preserves the fast fork's per-call speedup and adds real parallel throughput. No HistForge-side changes; the existing `chatterbox_fast_workers` setting (default `2`, range `1..4`) is unchanged.

## Current State

- **Single shared model**: `chatterbox-fast-server/server.py:83-97` — module-global `_model`, `get_model()`, eager `_warm` hook.
- **Hard cap**: `server.py:46-50` (`MAX_WORKERS = 4`) and `server.py:75-79` (`BatchRequest.workers: int = Field(2, ge=1, le=MAX_WORKERS)`).
- **Parallel dispatch on shared model**: `server.py:188-202` — `gen_one` calls `_generate_chunk_pcm(...)` which calls `get_model()` internally; `ex.map(gen_one, chunks)` fans across `clamped` worker threads on the same model.
- **Thread-unsafe library code (root cause, not modified by this plan)**:
  - `chatterbox/models/t3/t3.py:260-270` — `get_speech_pos_embedding_cache` assigns `self._speech_pos_embedding_cache = []` then later replaces it with a stacked tensor; concurrent readers see the intermediate list and crash with `AttributeError: 'list' object has no attribute 'size'`. Reproduced during Task 2.5 smoke run, 2026-05-09.
  - `chatterbox/models/t3/t3.py:232-258` — `get_cache` returns `self.backend_cache` to every caller after `.reset()`. Concurrent KV-cache writes corrupt outputs silently. The assertion at `t3.py:406-407` (`assert not kv_cache.get_seq_length() > 0`) would also trip on overlap.
- **HistForge provider** sends `{chunks, voice_*, ..., silence_ms, workers}` to `/tts/batch`: `src/lib/tts/chatterbox-fast.ts:86-95`. **No change** in this plan.
- **Settings** (`chatterbox_fast_workers` default `"2"`, range `1..4`) at `src/lib/db.ts`, `src/lib/settings.ts`, `src/lib/settings-tabs.ts`, `src/app/settings/tts-settings.tsx`. **No change** per user instruction.
- **Operator docs claim shared model + MAX_WORKERS=4**: `chatterbox-fast-server/README.md:13`, `docs/setup-guides/setup-chatterbox-fast.md:229` and `:243-249`. Need update.
- **VRAM budget on RTX 4070 (12 GB reference target)**: each fast-fork model ~2 GB static + ~2-3 GB peak activations during `generate()`. With the pool, *both* costs scale with worker count: a pool of N has N × ~2 GB static + N concurrent generations × ~2-3 GB activations. Rough estimates — workers=2 ≈ 8-10 GB peak (tight on 12 GB), workers=3 ≈ likely OOM on 4070, workers=4 ≈ OOM on 4070. Existing operator-doc claim "workers=2 typically saturates a 12 GB 4070" was for the shared-model path; the pool's static cost is strictly higher, so headroom shrinks. **Real numbers come from the operator-side smoke (Task 2.5 in the parent plan)** — these are estimates, not commitments. The HistForge-side Zod schema caps the setting at 4, so operators can never *request* a pool larger than 4 today.
- **Sidecar has no test scaffold** (no `chatterbox-fast-server/tests/` directory; project convention is operator smoke).

## Scope

**Doing**:

- Add a `ModelPool` class to `server.py`: lazy-grow on demand, never-shrink, FIFO `queue.Queue` lease/release.
- Refactor `_run_batch` and `_generate_chunk_pcm` so the pool leases one model per chunk; one model = one in-flight `generate()` call at a time.
- Remove the `MAX_WORKERS = 4` hard cap; `BatchRequest.workers` becomes `Field(2, ge=1)`. Sidecar accepts any positive int — operator owns VRAM sizing.
- Replace the `_warm` startup hook so the sidecar still pre-loads one model at boot (so model-load failures surface immediately, not on first request).
- Update `chatterbox-fast-server/README.md` and `docs/setup-guides/setup-chatterbox-fast.md` to describe the pool, drop the MAX_WORKERS claim, and revise VRAM guidance to per-worker-model cost.
- Append a status note to the parent plan (`docs/plans/2026-05-08-chatterbox-parallelism.md`) marking Task 2.5 unblocked once this lands.

**Not doing**:

- **HistForge-side TS changes** — body shape on the wire is unchanged; provider, settings, schema, UI, and tests stay as-is.
- **New settings or env vars** — pool size is implicitly the largest `workers` value seen so far; no separate knob.
- **Sidecar unit tests** — no test scaffold exists; consistent with the project's existing convention of operator smoke for the sidecar.
- **Cancellation rework** — same semantics carry over; aborting the upstream fetch still doesn't stop in-flight generations (same as today, same as devnen).
- **Library changes** — no monkey-patching, no vendoring of upstream chatterbox or petermg's fork.
- **The Task 2.5 smoke run itself** — operator-deferred (same status as today); only the code defect that was blocking it is being fixed here.

## Tasks

### Phase 1: Sidecar model pool

- [x] **Task 1.1: Add `ModelPool` and replace `_model` / `get_model`**
  **Files**: `chatterbox-fast-server/server.py`
  **What**: Introduce a `ModelPool` class encapsulating (a) a `factory: Callable[[], ChatterboxTTS]`, (b) a `queue.Queue` of free model instances, (c) a `_size` counter and `threading.Lock` for thread-safe lazy growth, (d) `ensure_size(n)` that loads models inside the lock until the pool has at least `n`, (e) `acquire()` that blocks on the queue, (f) `release(model)` that returns it. Replace the module-global `_model` / `get_model()` pair with a single `_pool` instance whose factory closes over `device = "cuda" if torch.cuda.is_available() else "cpu"` and calls `ChatterboxTTS.from_pretrained(device=device)`. Pool grows monotonically — never shrinks, never swaps.
  **Context**: Replace the structural pattern at `server.py:83-91`. Use `queue.Queue` (FIFO, blocking) so `acquire()` cleanly waits when all models are leased. The growth lock is short-lived — held only during size-check + load loop, NOT during inference (otherwise the lock serializes generations and defeats the purpose). Each `from_pretrained` is ~2 GB VRAM and tens of seconds (longer the first time, when weights download from HuggingFace; faster on cached weights — see operator-guide §2.3); print a clear log line per load (e.g. `"ModelPool: loading model #2 (current size 1, target 2)"`) so operators can see why a request that bumps the pool size is unusually slow.

- [x] **Task 1.2: Wire the pool through `_run_batch` and `_generate_chunk_pcm`**
  **Files**: `chatterbox-fast-server/server.py`
  **What**: `_generate_chunk_pcm` takes a `model: ChatterboxTTS` argument instead of calling `get_model()` internally. `_run_batch` now: (1) computes `clamped = max(1, workers)` (no upper bound, see Task 1.3); (2) calls `_pool.ensure_size(clamped)` BEFORE dispatching anything; (3) obtains the sample rate via the pool (briefly acquire/read/release a model, or cache it on the pool after first load); (4) inside `gen_one`, acquires a model from the pool, runs inference, releases in a `finally` block to guarantee return even when inference raises. Keep the existing `if clamped == 1 or len(chunks) == 1` fast path — serial in-thread avoids the executor's overhead.
  **Context**: Replace the structural pattern at `server.py:171-204` and the `model = get_model()` call at `server.py:133`. Critical correctness rules to preserve: (a) `acquire()` and `release()` are always paired — every `gen_one` body is `model = pool.acquire(); try: ... finally: pool.release(model)`; (b) the safety invariant is "no model is in two concurrent inferences at once" — `queue.Queue` enforces this because `get()` removes the item until `put()` returns it. Models ARE reused across many chunks within a single batch (a pool of 2 serves 10 chunks by being acquired ten times by alternating threads); reuse is fine, simultaneous use is not. (c) Skipping the `finally` strands a model on any inference exception — the queue eventually empties and future `acquire()` calls block forever. Output ordering still comes from `executor.map` preserving input order; the pool does not change that.

- [x] **Task 1.3: Remove the `MAX_WORKERS = 4` hard cap**
  **Files**: `chatterbox-fast-server/server.py`
  **What**: Delete the `MAX_WORKERS = 4` constant and update `BatchRequest.workers` to `Field(2, ge=1)` (no upper bound). The clamp inside `_run_batch` becomes `max(1, workers)` only. Rewrite the now-stale comments at `server.py:46-50` and `server.py:75-79` to describe the new contract: pool grows on demand to match `workers`, operator owns VRAM headroom, the sidecar will not refuse a request based on worker count alone.
  **Context**: Per user direction. The HistForge-side Zod schema (`src/lib/settings.ts`) still constrains `chatterbox_fast_workers` to `1..4`, so client-side requests stay bounded today; this change just removes the duplicate ceiling on the sidecar so future Zod widening doesn't require sidecar redeploy. Note this in the rewritten comment so the next reader understands the intent (effective ceiling is the HistForge setting, not the sidecar).

- [x] **Task 1.4: Replace the `_warm` startup hook with a pool warm**
  **Files**: `chatterbox-fast-server/server.py`
  **What**: `_warm` now calls `_pool.ensure_size(1)`. Same operational intent as today — fail-fast on bad torch/cuda/checkpoint setup at boot rather than on first request. Comment should clarify that additional models are loaded lazily inside `_run_batch` when a higher `workers` value arrives.
  **Context**: Replace `server.py:94-97`. Behavior matches today's "first request is fast because the model is already loaded" property for `workers=1` requests; the *first* `workers=N>1` request still pays the lazy-load tax for models 2..N (one-time per process).

### Phase 2: Operator docs

- [x] **Task 2.1: Update `chatterbox-fast-server/README.md`**
  **Files**: `chatterbox-fast-server/README.md`
  **What**: Drop the "shared `ChatterboxTTS` model … hard-clamped to `MAX_WORKERS=4`" wording from the `/tts/batch` description. Replace with: a pool of `ChatterboxTTS` models, lazy-loaded on demand up to the request's `workers` value, persisting for the sidecar's process lifetime; concurrent inferences each lease their own model from the pool, never sharing one. Add one sentence noting the operator pays a one-time ~2 GB VRAM + tens-of-seconds load the *first* time a request bumps the pool size (e.g. moving from `workers=2` to `workers=3` loads a third model on first use; subsequent requests at the same level are fast).
  **Context**: Target line `chatterbox-fast-server/README.md:13`. Keep tone consistent with the existing cancellation and speed-handling sections.

- [x] **Task 2.2: Update `docs/setup-guides/setup-chatterbox-fast.md` parallel-batch sections**
  **Files**: `docs/setup-guides/setup-chatterbox-fast.md`
  **What**: Four edits, all framing the pool as the new mental model:
    1. **Long-script handling section** (line ~229, the `/tts/batch` body description): replace "shared `ChatterboxTTS` model" with "pool of `ChatterboxTTS` models (one per concurrent worker, lazy-loaded)".
    2. **Tuning table** (lines ~243-247, `chatterbox_fast_workers` row): drop the "Sidecar hard-clamps to MAX_WORKERS=4" sentence and the "shared model + GIL releases on CUDA dispatch" sentence. Replace with a description of the lazy-loaded model pool — one model per concurrent worker, lazy-loaded on first use of a higher worker count, persistent for the sidecar process lifetime.
    3. **Speed/quality tradeoff paragraph** (lines ~249-251, starts with `**Speed/quality tradeoff.**`): update VRAM guidance to reflect the pool's higher static cost — workers=2 ≈ 8-10 GB peak (tight on 12 GB), workers=3+ likely OOMs on 4070; advise the operator to validate via `nvidia-smi` during their first run at each new worker count. Frame the numbers as estimates pending the Task 2.5 smoke.
    4. **Side-by-side with devnen** (section 2.6, lines ~219-222): update the math — devnen's ~2 GB + the fast sidecar's pool of N × ~2 GB = ~2(N+1) GB just for static models, before any active generation.
  **Context**: Existing tuning table structure stays — only revise the rightmost column for the `workers` row. The HistForge setting range stays `1..4` (the Zod schema is unchanged), so don't promise wider ranges in the docs. Line numbers are approximate — file was last edited 2026-05-08 so they may have drifted by a line or two; locate by the section headings, not raw numbers.

### Phase 3: Plan tracking

- [x] **Task 3.1: Note Task 2.5 unblocked in the parent plan**
  **Files**: `docs/plans/2026-05-08-chatterbox-parallelism.md`
  **What**: Append a status line under Task 2.5 (parent plan, Phase 2) referencing this plan as the prerequisite that landed for thread-safety. Note that the original Task 2.5 smoke (`workers` = 1, 2, 3, VRAM peaks, wall-clock vs devnen) is unchanged in scope — same operator-deferred test, no longer blocked on a code defect. Do not modify Task 2.5's "What" / "Context" — only add the status note.
  **Context**: Parent plan Task 2.5 at lines ~115-119. The deferral framing is correct; the only thing this changes is *why* it's deferred (was: blocked on shared-model crash; is: operator GPU + real video).

## References

- `chatterbox-fast-server/server.py:83-91` — single-model module state to replace
- `chatterbox-fast-server/server.py:46-50` — `MAX_WORKERS = 4` constant to remove
- `chatterbox-fast-server/server.py:65-79` — `BatchRequest` schema with `le=MAX_WORKERS` clamp
- `chatterbox-fast-server/server.py:94-97` — `_warm` startup hook
- `chatterbox-fast-server/server.py:119-146` — `_generate_chunk_pcm` (takes `model` arg after Task 1.2)
- `chatterbox-fast-server/server.py:171-204` — `_run_batch` (calls `ensure_size`, leases per chunk after Task 1.2)
- `chatterbox-fast-server/venv/Lib/site-packages/chatterbox/models/t3/t3.py:232-270` — root-cause non-thread-safe state (informational; not modified)
- `chatterbox-fast-server/README.md:13` — `/tts/batch` description to update
- `docs/setup-guides/setup-chatterbox-fast.md:219-222,229,243-249` — operator-facing claims to update
- `docs/plans/2026-05-08-chatterbox-parallelism.md` Task 2.5 — parent plan's smoke gate, unblocks once this plan lands
- `src/lib/tts/chatterbox-fast.ts:86-95` — request body shape (unchanged)
- `src/lib/settings.ts`, `src/lib/db.ts`, `src/lib/settings-tabs.ts`, `src/app/settings/tts-settings.tsx` — `chatterbox_fast_workers` setting (unchanged)
- petermg/Chatterbox-TTS-Extended — researched 2026-05-09; their parallelism works because they vendor a non-fast-fork chatterbox with no shared mutable state. Not portable to this sidecar, but motivated the pool design (one model per concurrent generation).
