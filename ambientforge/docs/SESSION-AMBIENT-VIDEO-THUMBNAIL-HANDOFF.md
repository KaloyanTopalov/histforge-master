# Session handoff — ambient-video thumbnail (Magnific) feature

## State in one line

**Plan 100% COMPLETE — Tasks 1–14 done + a post-validation pipeline-ordering
bug found & FIXED (`5f6992f`).** Task 14 proved the step works standalone
(real OpenRouter vision → Magnific reference flow → 4× 3840×2160, ~92s, zero
Suno). But the first FULL pipeline run (album `01KRY64G459GG6GBK2RJ8R3W9Q`)
exposed that Task 11 ran the thumbnail PRE-FORK — step 08 (Seedance) then
animated a title-text thumbnail (start) → clean cover (end): text in the
video bed + no loop. Fixed: ambient-video `step05b` slot → `step05bNoop`;
thumbnail moved to the END of branch B (`07→08→09→thumbnail`, best-effort).
That bad album's video still needs regeneration (recovery plan pending).

## ⚠️ Read before any future "requeue a cached album" work

`scripts/amv-requeue.ts` is **4-track SMOKE tooling** — it hardcodes
`setSetting('tracks_per_album_override', 4)` (line ~24). Running it on a
**full 30-track cached album** makes step 02 see `30 rows ≠ 4 expected`,
**delete the 30 cached track rows**, and re-scaffold 4 → step 03 then attempts
real Suno. This happened to `01KRX5VXE4XM8HZ6X3VMWS2PR8` this session (no Suno
billed only because the Suno bridge was down). To validate **step 05b** do NOT
requeue the pipeline at all — invoke the step directly (recipe below). To
requeue a real 30-track album for other reasons, first
`setSetting('tracks_per_album_override', 0)` AFTER amv-requeue.ts and before the
worker ticks, or don't use that script.

## Where we are

Plan doc (`docs/plans/2026-05-18-ambient-video-thumbnail-magnific.md`) = source
of truth, all of Tasks 1–14 checked off.

- **Phases 1–5** (prior sessions): OpenRouter vision+text, `scaleToMaxEdgeJpeg`,
  `thumbnail-spec` template+loader, freepik `submitThumbnail`/`pollThumbnail`/
  `downloadThumbnail` client+bridge, `gradeImage`, the Magnific reference flow
  (Task 7 RESOLVED — CDP trusted-click recipe, works e2e).
- **Phase 6 (this session):**
  - Task 10 — `step05b?` optional slot on `WorkflowDefinition` + runner
    `workflow.step05b ?? step05bThumbnail` fallback. Commit `c92f945`.
  - Task 11 — `step05bAmbientVideoThumbnail` (`src/worker/steps/05b-ambient-video-thumbnail.ts`):
    resolve channel + source.jpg (album>channel folder, required) → load/render
    `thumbnail-spec` w/ `album.sceneTitle` → downscale → vision
    `chatCompletionText` → `submitThumbnail`(ref=source.jpg, count 4) → poll →
    download all → `resizeWithMode('crop')` 3840×2160 → `gradeImage` →
    `projects/<ch>/<alb>/thumbs/thumb-1..N.png`. Idempotent; never sets
    `album.thumbnailPath` (selection deferred). Registered as ambient-video
    `step05b`. Commit `2bcac67`.
  - Task 12 — read-only dashboard tile grid for the 4 thumbs (derived from disk;
    section hides until ≥1 exists). Verified in-browser. Commit `d68834f`.
- **Phase 7 (this session):**
  - Task 13 — areas 1–3 were already covered by Phase 1/3 + Task 11 TDD (NOT
    duplicated). Added the one real gap: step 05b poll→error-code translation
    (`THUMBNAIL_GEN_FAILED`/`_TIMEOUT`/`_RESULTS_INCOMPLETE`). Commit `1108696`.
    Verification: `npm run lint` clean; `tsc` clean for all changed files (only
    the 3 documented `dk-probe-*`/`manual-rap-no-flow` script errors remain);
    `npm run test` = 460 passed, only the 2 documented known reds.
  - Task 14 — **VALIDATED 2026-05-18** (recipe below).

## Task 14 — VALIDATED (the proven recipe = direct step invoke, NOT a requeue)

**Result:** `step05bAmbientVideoThumbnailInternal` invoked directly against album
`01KRX5VXE4XM8HZ6X3VMWS2PR8` produced, in ~92s with zero Suno:
`source=…source.jpg` → `template=workflow-default` → real OpenRouter vision
`llm prompt chars=496` → `submitted taskId=… count=4` → live Magnific
reference-upload + generate 4 → `done 4 thumbs @ 3840x2160 vibrance=+30 sat=+10`.
All 4 `thumbs/thumb-1..4.png` independently ffprobe 3840×2160. Viewable on the
channel dashboard "Thumbnail candidates" section.

**The proven recipe (reuse this — do NOT requeue the pipeline):**
1. `npm run freepik:bridge` (port 7344) + `npm run freepik:login` (logged-in
   Magnific Chrome at `/app/ai-image-generator`; the launcher does the
   `chrome.runtime.reload()` so the current `background.js` runs — relaunch after
   ANY extension edit; the `content.js build` marker is NOT proof the SW is
   current — see [[project-ambient-video-magnific]]).
2. Ensure `projects/<ch>/<alb>/thumbs/` is absent (else 05b idempotency-noops)
   and `source.jpg` + `album.sceneTitle` are present (both survive a clobbered
   pipeline — only track rows get destroyed).
3. `openrouter_api_key` = a real vision model key (`claude-haiku-4.5` works).
4. Direct invoke (zero pipeline, zero Suno, no branch A/Flow, no track rows):
   ```
   npx tsx -e "import('./src/lib/repos/albums').then(async a=>{ \
     const {step05bAmbientVideoThumbnailInternal}=await import('./src/worker/steps/05b-ambient-video-thumbnail'); \
     const al=a.get('<ALBUM_ID>'); const log=(s,m)=>console.log(s,m); \
     await step05bAmbientVideoThumbnailInternal(al,log).then(()=>console.log('OK')).catch(e=>console.error('FAIL',e.code,e.message)); });"
   ```
   Watch the Magnific tab: reference counter ticks (`0/8→1/8`), 4 images
   generate. Distinct failure codes (`THUMBNAIL_SOURCE_JPG_MISSING`,
   `_SCENE_TITLE_MISSING`, `THUMBNAIL_LLM_EMPTY`, `THUMBNAIL_GEN_FAILED`,
   `_TIMEOUT`, `_RESULTS_INCOMPLETE`, `THUMBNAIL_POSTPROCESS_FAILED`) pinpoint
   the stage; iterate via `scripts/probe-thumb-flow.ts`, not blind content.js.
   The step neither reads track rows nor sets `album.thumbnailPath`, so it's
   safe to re-run any time `thumbs/` is cleared.

**Residual state from the requeue mishap (accepted by operator, 2026-05-18):**
album `01KRX5VXE4XM8HZ6X3VMWS2PR8` restored to `status=done` (lastError cleared,
videoStatus=rendered, finalVideoPath set) but has **4 track rows instead of 30**
(the 30 cached rows were clobbered by the `amv-requeue.ts` smoke-tooling trap;
operator chose status-only repair, skipped the 30-row rebuild). All disk
artifacts (30 wavs, source.jpg, cover/yt, concat.wav, clip.mp4, final.mp4,
scene.json) are intact — the album's deliverable is complete; only the DB
track-list for that one album is short. If a full rebuild is ever wanted: the
tracks repo (`deleteByAlbum` + `insertMany` + `patch`) can reconstruct 30 done
rows from `songs/NN - Title.wav` (ffprobe each for duration); suno* input fields
are unrecoverable for that one album.

## Pending non-code follow-ups (operator / next session)

- **Remove the obsolete Task-6 probe button** (`injectEditRefProbeButton` /
  the always-on smoke button in `extensions/freepik-runner/content.js`).
  Selectors are now live-confirmed (Task 14 passed), so this cleanup is
  unblocked — a tiny content.js edit + commit, then relaunch `freepik:login`.
- **step-05a/08 test mock fixup (decision pending).** Phase 3 widened
  `FreepikClient` (`submitThumbnail`/`pollThumbnail`/`downloadThumbnail`) but
  `step-05a-ambient-video.test.ts` + `step-08-seedance.test.ts` fake clients
  were never updated → 5 tsc errors. **The 3 missing stub methods are already
  applied to the working tree (tsc is green there now), but those two files
  ALSO carry the operator's own pre-existing uncommitted refactor** (a
  `SeedanceClient→FreepikClient` mock migration + a removed obsolete test).
  They were left UNCOMMITTED on purpose — committing them would sweep that
  unreviewed refactor into a feature commit, and partial staging is
  non-interactive-only here. Operator: commit those two files with your own
  changes when ready (you'll see your refactor + 3 small throw-stub blocks per
  file in `git diff`).
- **Live infra still running** from the Task-14 validation: `npm run
  freepik:bridge` (pid noted in shell) + `npm run freepik:login` Magnific
  Chrome. Close them when done (or leave for further runs). `queue_state` is
  `paused` and `tracks_per_album_override=0` (safe).

## Durable gotchas (still true)

- Test runner = vitest; tests **colocated** in `src/**/__tests__/` (NOT a root
  `__tests__/`). Project + `vitest.config.ts` win over the implement-plan skill's
  root-`__tests__` instruction.
- Known unrelated reds, NOT regressions: `src/lib/seedance/__tests__/client.test.ts`
  (mock-only legacy dead-code, flat-body vs `body.input`); `step-04` "SunoError
  class assignment" flakes only under full-suite CPU saturation (passes in
  isolation — verified again this session at 10/10). Don't "fix" these.
- Magnific gates on `event.isTrusted` (like DistroKid). Synthetic clicks AND
  full synthetic pointer sequences are ignored — `background.js`
  `freepik:trusted-click` (CDP `Input.dispatchMouseEvent`) is the only JS path
  for any Radix/reference control.
- `extensions/` is excluded from vitest. Phase 4/Task 7 + Task 14 are
  skip-TDD, verified via the committed `scripts/probe-*.ts` harness + the
  direct-invoke recipe above.
- Cost gate is **Suno only**. Magnific = Freepik Premium unlimited → free to
  e2e. The direct-invoke recipe keeps Suno spend at exactly zero.
- Git shows cosmetic `LF→CRLF` warnings on commit — ignore.

## Branch / commits (this session, `main`)

`c92f945` Task 10 · `2bcac67` Task 11 · `d68834f` Task 12 · `1108696` Task 13 ·
`121ddcd` docs. Each commit is scoped (only its own files); the broad
pre-existing repo churn from prior sessions was left untouched. Task 14 is
validation-only (no code); the album status-only repair was a one-off DB write.
