# Implement shadcn/ui with Dark Mode

## Overview
Replace HistForge's hand-rolled Tailwind UI with shadcn/ui — a Radix-primitives-based component library generated into `src/components/ui/`. Migrate every existing UI surface (NavBar, modals, dialogs, tables, forms, status badges, buttons) to shadcn equivalents. Add full light + dark theme support via `next-themes` with a slate base color, and replace unicode step icons with `lucide-react`.

## Current State

- **Tailwind** (`tailwind.config.js:1-8`): minimal config — empty `theme.extend`, no `darkMode`, no plugins, content glob only covers `src/app/**/*.{ts,tsx}`.
- **globals.css** (`src/app/globals.css:1-3`): only the three `@tailwind` directives; no CSS variables, no `:root` theme tokens.
- **Dependencies** (`package.json:22-51`): React 18.3 / Next 14.2 / Tailwind 3.4 / Zod 3.23. None of shadcn's peers present: no `clsx`, no `tailwind-merge`, no `class-variance-authority`, no `@radix-ui/*`, no `lucide-react`, no `next-themes`.
- **Shell** (`src/app/layout.tsx:20`): `<NavBar>` + `<main className="mx-auto max-w-5xl px-4 py-6">`. `<body>` has no classes. No sidebar.
- **NavBar** (`src/app/nav-bar.tsx:14-35`): active-link detection via `usePathname().startsWith(href)` at `line 25`; inline ternary Tailwind strings at `lines 24-28`; bar is `border-b border-gray-200 bg-white` at `line 15`; logo is `text-indigo-600` at `line 17`; active link is `bg-indigo-50 font-medium text-indigo-700`, inactive is `text-gray-500 hover:text-gray-700`.
- **Modals/dialogs**: hand-rolled, no focus trap, manual backdrop, manual body-scroll lock.
  - `src/app/videos/add-video-modal.tsx:90-173` — `role="dialog" aria-modal="true"` + `fixed inset-0 z-40 bg-black/40` at `line 94`; Title input / Topic Info textarea / Workflow `<select>`; submit disabled until all three fields filled (`canSubmit` at `lines 52-56`, disabled state at `line 164`); error row uses `role="alert"` with `text-red-600` at `line 149`; parent (`videos-client.tsx:194`) conditionally mounts the modal.
  - `src/app/videos/confirm-dialog.tsx:1-66` — body scroll lock in `useEffect` at `lines 24-30`, `autoFocus` on Cancel at `line 48`, `destructive` prop swaps button bg between `bg-red-600` and `bg-blue-600` at `lines 32-34`.
  - `src/app/videos/delete-confirm-dialog.tsx` — status-dependent warning text (`in_progress` → deferred cleanup); optional `onSuccess(deferred)` callback wired at `video-actions.tsx:74-78`.
- **Tables** (`src/app/videos/video-queue-table.tsx`, `src/app/videos/finished-videos-table.tsx`): semantic `<table>/<thead>/<tbody>`; `data-testid` attrs at `video-queue-table.tsx:67` and `finished-videos-table.tsx:55` (preserve during migration); status badges driven by `STATUS_BADGE: Record<VideoStatus, string>` at `video-queue-table.tsx:15-21` and applied at `line 85`.
- **Forms** (`src/app/settings/settings-form.tsx`):
  - Manual tab bar at `lines 153-181` with `role="tablist"` / `role="tab"` / `aria-selected` already wired; active tab styled with `border-b-2 border-indigo-600 font-medium text-indigo-700` at `line 167`.
  - Dirty-indicator dot at `lines 172-177`: `bg-orange-500` with `aria-hidden="true"`.
  - Save button at `lines 360-366`: `bg-blue-600 text-white`, `disabled={busy}`, no visual disabled state.
  - `Saved.` message at `lines 353-357`: `bg-green-50 text-green-900`.
  - Inline field primitives at `lines 374-515`: `ReadOnlyField` (`bg-gray-50 text-gray-600`), `TextField`, `TextArea`, `NumberField`, `SelectField`, `BoolField`. Private to the file, not exported.
- **Client islands**:
  - `src/app/videos/videos-client.tsx` — owns 5 s polling at `line 104`, toast state array at `line 97`, toast render at `lines 181-192`, `dismissToast` helper at `lines 136-138`. Header buttons at `lines 142-160`: Add Topic (`bg-blue-600`), Start All (`bg-green-600` + disabled state).
  - `src/app/videos/[id]/video-detail-client.tsx` — owns 5 s polling + 1 s duration ticker; step-status icons as unicode chars in `STEP_ICONS` map at `lines 18-22` (`○ ▶ ✓ ✗`), rendered at `line 208`; `STEP_ICON_COLORS` applied at `line 205`.
  - `src/app/videos/[id]/video-actions.tsx` — per-status action toolbar: Start (`bg-green-600` at `line 85`), Retry (`bg-blue-600` at `line 97`), Restart (`bg-red-600` solid at `line 105`), Copy Path (`border-gray-300` outline at `line 117`), Delete (`border-red-300 text-red-700` outline at `line 135`). Confirm dialogs mounted at `lines 152-173`.
- **Shared primitives**: `src/app/videos/spinner.tsx` (`Spinner` — a 12×12 `animate-spin` circle, imported by `video-queue-table.tsx:5` and `video-actions.tsx:8`), `src/app/videos/confirm-dialog.tsx` (generic `ConfirmDialog`).
- **Icons**: none installed. Only unicode `○ ▶ ✓ ✗` in `STEP_ICONS`.
- **`src/lib/`** currently contains: `align.ts`, `db.ts`, `image/`, `llm/`, `logger.ts`, `project-files.ts`, `prompts.ts`, `render.ts`, `repos/`, `sentences.ts`, `settings.ts`, `tts/`. No `utils.ts` — safe to create.
- **Tests** *(corrected during Phase 2 — original plan was stale)*: `__tests__/components/videos/*.test.tsx` already has jsdom tests for `add-video-modal`, `delete-confirm-dialog`, `finished-videos-table`, `video-detail-client`, `video-queue-table`, plus `__tests__/components/settings/settings-form.test.tsx`. Phases 5-8 migrations MUST keep these green or stop and report per the TDD skill. Many of them already use `data-testid` / `getByRole` queries that will survive the migration if accessible names and test-ids are preserved.
- **Path alias**: `@/` → `src/` in `tsconfig.json`; worker uses `tsc-alias` post-compile. `tsconfig.worker.json` excludes `src/app/**` but includes `src/lib/**` — worker will compile the new `src/lib/utils.ts` (harmless, pure helper).

## Scope

**Doing**
- Install shadcn peers + Radix primitives + `lucide-react` + `next-themes` + `tailwindcss-animate`.
- Run `shadcn init` with slate base color, generate `components.json`, `src/lib/utils.ts` (`cn()` helper), and all needed primitives into `src/components/ui/`.
- Replace `tailwind.config.js` with `tailwind.config.ts` (shadcn CLI v2 does this automatically), add `darkMode: ["class"]`, shadcn color tokens mapped to CSS variables, expanded content glob.
- Add light + dark CSS variable layers to `src/app/globals.css`.
- Add a `ThemeProvider` wrapper and a theme-toggle button in the NavBar.
- Migrate **every** existing UI file to shadcn components + theme-aware color tokens (`bg-background`, `text-foreground`, `bg-muted`, `text-muted-foreground`, etc.).
- Replace hand-rolled Spinner with `<Loader2 className="animate-spin" />` from `lucide-react`; replace unicode step icons with lucide equivalents.
- Replace toast state in `videos-client.tsx` with Sonner.
- Extend the generated `Button` component with a `success` variant (the codebase uses a green "go" button family that shadcn's defaults don't cover).

**Not doing**
- No API, DB, worker, or spec changes.
- No new routes, no redesign — same pages, same information architecture, same spacing/layout (only replace the visual vocabulary).
- No new features beyond the theme toggle itself.
- No migration to Tailwind 4 (stay on 3.4.x).
- No `next/font` integration — stay on the system font stack; font selection is a follow-up.

## Design Decisions

Declare these up front so Phases 4-8 don't each re-decide the same questions.

**Brand color**: Fully commit to slate-neutral. Drop the current indigo/blue brand accent everywhere: `text-indigo-600` (logo) → `text-foreground`; `bg-blue-600` (Save / Retry / Add Topic) → `variant="default"` (slate primary); `bg-indigo-50 text-indigo-700` (active nav link) → shadcn's default active state via `bg-accent text-accent-foreground`; `border-indigo-600 text-indigo-700` (active tab underline) → shadcn Tabs' built-in pill-style active state (a deliberate visual change from underline to pill). If indigo ever needs to come back, customize `--primary` HSL in `globals.css` as a follow-up — out of scope here.

**Button variant map** — applied consistently across every migrated component:

| Current button | Where | shadcn variant |
|---|---|---|
| Add Topic / Save / Retry / Edit / Create | `videos-client.tsx:145`, `settings-form.tsx:360`, `video-actions.tsx:97`, `video-queue-table.tsx:102`, `add-video-modal.tsx:162` | `default` (slate primary) |
| Start / Start All | `video-queue-table.tsx:94`, `video-actions.tsx:85`, `videos-client.tsx:152` | `success` (new variant — added in Task 2.3) |
| Restart from beginning | `video-actions.tsx:105` | `destructive` (solid red — this is the true wipe-and-redo action) |
| Delete | `video-queue-table.tsx:111`, `video-actions.tsx:135` | `outline` + className override `text-destructive border-destructive/50 hover:bg-destructive/10 hover:text-destructive` |
| Copy Path / Cancel | `finished-videos-table.tsx:64`, `video-actions.tsx:117`, dialog Cancels | `outline` |

**Icon map** (lucide-react):

| Action / state | Icon |
|---|---|
| Start / Start All / running step | `Play` |
| Retry failed step | `RefreshCw` |
| Restart from beginning | `RotateCcw` |
| Delete | `Trash2` |
| Edit | `Pencil` |
| Copy Path (idle / copied) | `Copy` / `Check` |
| Add Topic | `Plus` |
| pending step | `Circle` |
| done step | `Check` |
| failed step | `X` |
| in-flight spinner | `Loader2` (with `animate-spin`) |
| Theme toggle | `Sun` / `Moon` |

**Semantic status colors** (status badges, Saved messages, step-icon colors): keep the hue family (green=success, red=failure, blue=in-progress, yellow=new, gray=queued) but add `dark:` variants so they read correctly in both themes. Pattern: `bg-green-100 text-green-900 dark:bg-green-900/40 dark:text-green-200`.

**Body font**: no `next/font`. Add `className="antialiased"` to `<body>` for cleaner glyph rendering; everything else uses the system font stack.

**shadcn style**: `"style": "new-york"` in `components.json`. Locked in Phase 1. All generated primitives assume this style (tighter rounding, different icon-button sizing). Picking `"default"` instead would change component visuals and is out of scope here.

**`destructive` token shape**: paired — `--destructive` + `--destructive-foreground`, exposed in `tailwind.config.ts` as `destructive: { DEFAULT, foreground }`. Locked in Phase 1 because downstream shadcn primitives (AlertDialog action button, toast destructive variant, Button `destructive` variant) reference `text-destructive-foreground` and break without it.

## Implementation Notes (discovered during execution)

These are facts that emerged while implementing Phases 1-2 and weren't known when the plan was written. They apply to every remaining phase.

- **Use `shadcn@2.3.0`, not `shadcn@latest`**. `shadcn@latest` (currently 4.3.0) targets Tailwind v4 exclusively — it emits `oklch()` colors, `@import "tw-animate-css"`, v4 utility classes, and rewrites `layout.tsx` to import Geist from `next/font/google` (which doesn't exist in Next 14). We stay on Tailwind 3.4.x, so all `shadcn init` / `shadcn add` invocations must pin to `shadcn@2.3.0`. Task 1.2's CLI output still needed hand-patching (HSL vs oklch, .ts vs .js config, revert Geist insertion) — subsequent `shadcn add` calls from 2.3.0 have been clean.
- **Preexisting broken build state** (NOT introduced by this plan). Phase 9.2 will trip on these unless they're fixed out-of-band:
  - `src/worker/steps/_stub.ts:13` — `Property 'outputs' is missing in type ... but required in type 'Step'`. Dead code, no file imports `makeStubStep`.
  - `__tests__/unit/lib/image/comfyui.test.ts` — 9 sites pass `pollIntervalMs` that isn't in the option type.
  - `__tests__/unit/lib/tts/ai33.test.ts` — 18 sites pass `retryDelayMs` that isn't in the option type.
  - `__tests__/unit/lib/align.test.ts:108` — expects `/mnt/...` path but WSL cwd is `/workspace/...`. Environment drift.
- **Registry quirk for `lucide-react`**. The active npm registry resolves `lucide-react@latest` to `1.8.0` (upstream npmjs.org is at ~0.4xx). The installed 1.8.0 bundle has all 12 icons the plan needs (`Play`, `RefreshCw`, `RotateCcw`, `Trash2`, `Pencil`, `Copy`, `Check`, `Plus`, `Circle`, `X`, `Loader2`, `Sun`, `Moon`) — verified by inspecting `dist/esm/icons/`. Flagged only so no one is surprised by the unusual version number.
- **Dark-mode CSS vars only survive Tailwind's tree-shake once a `dark:*` utility appears somewhere in the content glob.** Phase 1's `globals.css` defines `.dark { --background: ...; ... }`, but Tailwind v3 strips the rule from compiled CSS until at least one `dark:`-prefixed utility exists in `./src/**/*.{ts,tsx}`. The generated Button / Dialog / etc. in Phase 2 include `dark:` variants, so the rule now survives — but be aware that future standalone files using theme tokens without any `dark:` utility will **not** trigger emission on their own.
- **`<Toaster />` mounted inside `<ThemeProvider>` (resolved in Phase 3.2)**. Before Phase 3.2 the Toaster briefly ran with `theme="system"` fallback because `useTheme()` returns `undefined` outside a provider. After Task 3.2 wrapped the layout in `<ThemeProvider>`, the Toaster follows the user's explicit theme choice. Noted only so the commit archaeology in `layout.tsx` reads cleanly.
- **Testing Radix primitives in jsdom (discovered in Phase 5)**. jsdom doesn't implement `hasPointerCapture` / `releasePointerCapture` / `scrollIntoView`, which Radix Select/Dialog/Popover call. Shared polyfill helper at `__tests__/helpers/radix-jsdom.ts` — call `installRadixJsdomPolyfills()` in a `beforeEach` from any test that opens a Radix surface. To drive Radix Select: focus the trigger, `fireEvent.keyDown(trigger, { key: "Enter" })` to open the portal, then `findByRole("option", { name: ... })` + `fireEvent.click` to pick. `pointerDown` alone is unreliable.
- **Radix AlertDialog uses `role="alertdialog"`, not `"dialog"`** (ARIA-correct). Tests migrating components that embed AlertDialog must query `getByRole("alertdialog")` — caught in `video-actions.test.tsx` during Phase 5. Regular shadcn Dialog (AddVideoModal) keeps `role="dialog"`.
- **`AlertDialogCancel` / `AlertDialogAction` auto-close** the dialog on click via their built-in behavior. Don't add an additional `onClick={onCancel}` on Cancel (fires `onCancel` twice — once from click handler, once from the resulting `onOpenChange(false)`). For Action click handlers that do async work and may fail, call `e.preventDefault()` inside the handler so the dialog stays open until the operation finishes or errors clear.
- **More Radix-in-jsdom gotchas (Phase 6 additions)**:
  - **Radix Tabs activates on `mouseDown` (button=0), not `click`** — `fireEvent.click(tab)` alone won't flip the tab. Use `fireEvent.mouseDown(tab, { button: 0 })`.
  - **Radix Checkbox needs `ResizeObserver`** — `@radix-ui/react-use-size` crashes in jsdom without it. Polyfill now included in `installRadixJsdomPolyfills()`.
  - **Radix Select renders a hidden native `<select>`** for form submission under the hood. `getByDisplayValue("option_value")` still resolves against shadcn Select fields — so existing value-assertion tests survive the migration unchanged. `fireEvent.change` on the hidden select does NOT drive Radix state, though; for write interactions, use the keyboard-open helper pattern from Phase 5.
  - **Radix Checkbox is `<button role="checkbox">` with `aria-checked`**, not a native `<input>`. Query via `getByRole("checkbox", { name })` + `getAttribute("aria-checked")`; don't rely on `.checked`.

## Tasks

### Phase 1: Foundation — install, configure, theme tokens

- [x] **Task 1.1: Install shadcn dependencies**
  **Files**: `package.json`, `package-lock.json`
  **What**: Add runtime deps `clsx`, `tailwind-merge`, `class-variance-authority`, `lucide-react`, `next-themes`, plus whatever Radix primitives the shadcn CLI later pulls in per-component. Add `tailwindcss-animate` (shadcn's transition plugin) as a dev dep.
  **Context**: All five are currently absent per `package.json:22-51`. Use `npm install`. Keep existing deps untouched. If the shadcn CLI pins different versions later, accept the CLI's choices.

- [x] **Task 1.2: Run `shadcn init` with slate base**
  **Files**: `components.json` (new), `src/lib/utils.ts` (new), `tailwind.config.ts` (replaces `.js`), `src/app/globals.css`
  **What**: Scaffold shadcn config: `components.json` pointing `@/components`, `@/components/ui`, `@/lib/utils`; `src/lib/utils.ts` exporting the standard `cn()` helper; new `tailwind.config.ts` with `darkMode: ["class"]`, content glob `./src/**/*.{ts,tsx}` (covers both `src/app/` and the new `src/components/`), `theme.extend.colors` mapping to HSL CSS variables (`background`, `foreground`, `card`, `popover`, `primary`, `secondary`, `muted`, `accent`, `destructive`, `border`, `input`, `ring`, plus chart palette), `theme.extend.borderRadius` using `--radius`, and `tailwindcss-animate` plugin.
  **Context**: Run `npx shadcn@latest init` non-interactively if possible; choose `Slate` base color, `CSS Variables: yes`, `TypeScript: yes`, RSC: yes. The CLI will convert `tailwind.config.js` → `tailwind.config.ts` automatically; delete the old `.js` after init completes and verify PostCSS resolves the new `.ts`. Existing `src/app/globals.css:1-3` has only the three directives; append the `@layer base { :root { … } .dark { … } * { @apply border-border; } body { @apply bg-background text-foreground; } }` block the CLI writes. `src/lib/utils.ts` does not exist today (confirmed against `src/lib/` directory listing). Heads-up: the CLI's `@layer base` remaps the bare `border` class to `--border` — any existing `border` without an explicit color now follows the theme; `border-gray-200` etc. stay fixed until Phase 9 sweeps them.

- [x] **Task 1.3: Verify `cn()` + CSS vars end-to-end**
  **Files**: none (verification only)
  **What**: Confirm `next build` CSS compilation passes (`Compiled successfully`) and the worker tsc pass isn't newly broken by `src/lib/utils.ts`. Import `cn` from `@/lib/utils` in a throwaway TSX file anywhere under `src/` and confirm the path alias resolves through `tsc --noEmit`. The `.dark` visual-flip check is **deferred to Phase 2** — Tailwind v3 tree-shakes the `.dark { … }` rule from compiled CSS until at least one `dark:*` utility appears in the content glob. The first shadcn primitive generated in Task 2.1 (Button in particular has `dark:` variants baked into its cva) will make the rule survive, and the DevTools flip can be verified at that point.
  **Context**: Path alias `@/ → src/` is already configured in `tsconfig.json`; shadcn components will depend on it from `src/components/ui/`. The worker build (`tsc -p tsconfig.worker.json`) excludes `src/app/**` but INcludes `src/lib/**`, so the new `src/lib/utils.ts` will be compiled by the worker — harmless (it's a pure helper) but be aware if it ever grows dependencies beyond `clsx` + `tailwind-merge`. `src/components/` is not in the worker's `include` list, so UI primitives won't leak into the worker bundle.

### Phase 2: Generate UI primitives

- [x] **Task 2.1: Add shadcn primitives for every UI surface we'll migrate**
  **Files**: `src/components/ui/*.tsx` (all new)
  **What**: Generate the following components via `npx shadcn@latest add …`: `button`, `input`, `textarea`, `select`, `checkbox`, `label`, `dialog`, `alert-dialog`, `tabs`, `table`, `badge`, `card`, `sonner`, `dropdown-menu`, `skeleton`, `separator`.
  **Context**: Mapping to current UI — Button: all action buttons; Input/Textarea: settings + AddVideoModal; Select: workflow picker + settings; Checkbox/Label: settings BoolField; Dialog: AddVideoModal; AlertDialog: ConfirmDialog + DeleteConfirmDialog; Tabs: `settings-form.tsx:153-181`; Table: two video tables; Badge: `STATUS_BADGE` at `video-queue-table.tsx:15-21`; Sonner: replaces `videos-client.tsx:181` toast divs; Card: used in Task 8.2 to group the detail-page step list and artifact list; Separator/Skeleton/DropdownMenu: available for Theme toggle (Task 3.3) and any visual polish. Do not delete any existing app code yet — primitives are added alongside. Button gets extended in Task 2.3.

- [x] **Task 2.2: Mount Sonner `<Toaster />` in root layout**
  **Files**: `src/app/layout.tsx`
  **What**: Import `<Toaster />` from `@/components/ui/sonner` (the shadcn-generated wrapper that reads `next-themes`; not the raw `sonner` npm package directly). Mount it inside `<body>` as a sibling of `<main>`, after `<main>`, so it renders above page content. Pass `richColors` if desired.
  **Context**: Current layout at `src/app/layout.tsx:20` has a single `<main>` inside `<body>`. Note that `layout.tsx` is also edited in Tasks 3.2 and 4.2 — feel free to merge all layout changes into a single pass.

- [x] **Task 2.3: Extend Button with a `success` variant**
  **Files**: `src/components/ui/button.tsx`
  **What**: Add a `success` entry to the `buttonVariants` cva config in the shadcn-generated `Button` component. Use theme-aware green classes (e.g., `bg-green-600 text-white hover:bg-green-700 dark:bg-green-500 dark:hover:bg-green-400`) so Start / Start All keep their distinctive "go" color in both themes.
  **Context**: shadcn's default variants are `default`, `destructive`, `outline`, `secondary`, `ghost`, `link` — no success. Editing the generated `button.tsx` is expected (shadcn's model: you own the files once they're copied in). Keep the variant name short (`success`) to match the existing one-word pattern.

### Phase 3: Theme provider + toggle

- [x] **Task 3.1: Create ThemeProvider wrapper**
  **Files**: `src/components/theme-provider.tsx` (new)
  **What**: Thin `"use client"` wrapper around `next-themes`'s `ThemeProvider`, exporting it as `ThemeProvider` with defaults `attribute="class"`, `defaultTheme="system"`, `enableSystem`.
  **Context**: Canonical shadcn pattern — nothing existing to reference in the repo; new file under a new directory.

- [x] **Task 3.2: Wrap root layout in ThemeProvider**
  **Files**: `src/app/layout.tsx`
  **What**: Wrap `{children}` (and the Toaster) in `<ThemeProvider>`. Add `suppressHydrationWarning` to `<html>` (required by `next-themes` to avoid hydration mismatch on the class attr). Add `className="antialiased"` to `<body>` (currently classless).
  **Context**: `src/app/layout.tsx` is a Server Component — the ThemeProvider itself is a client component but can be rendered from a server parent. Layout file currently sets `<main className="mx-auto max-w-5xl px-4 py-6">` (`line 20`); wrapping shouldn't disturb that.

- [x] **Task 3.3: Build theme toggle button**
  **Files**: `src/components/theme-toggle.tsx` (new)
  **What**: A small `"use client"` component — a shadcn `Button` with `variant="ghost"` + `size="icon"` that switches between `light` / `dark` / `system` using `useTheme()` from `next-themes`. Use lucide `Sun` / `Moon` icons with CSS crossfade (the standard shadcn snippet).
  **Context**: No pre-existing icon buttons in the app — this is the first. Simplest path: single click cycles `light → dark → system → light`. Alternative: shadcn `DropdownMenu` for the three-way choice. Either pattern acceptable; pick based on visual fit in the NavBar.

### Phase 4: Shell — NavBar + layout migration

- [x] **Task 4.1: Migrate NavBar to shadcn + theme-aware tokens**
  **Files**: `src/app/nav-bar.tsx`
  **What**: Replace the inline Tailwind ternary string at `lines 24-28` with shadcn `Button variant="ghost"` (use `asChild` over `Link` children) and `cn()` for the active-vs-inactive class merge. Swap hardcoded `bg-white` / `bg-indigo-50` / `text-gray-500` for theme tokens (`bg-background`, `bg-accent text-accent-foreground`, `text-muted-foreground`). Convert logo `text-indigo-600` at `line 17` to `text-foreground` (per Design Decisions — full slate commitment, no indigo accent). Mount `<ThemeToggle />` on the right side of the bar.
  **Context**: Active-link detection at `line 25` via `usePathname().startsWith(href)` must be preserved. The bar at `line 15` is `border-b border-gray-200 bg-white` — convert to `border-b bg-background`. Existing nav items: "HistForge" logo + two links (Videos, Settings). Don't change the IA.

- [x] **Task 4.2: Sweep any remaining hardcoded colors in the shell**
  **Files**: `src/app/layout.tsx`, `src/app/page.tsx`
  **What**: Ensure `<main>` container and any stray inline colors are theme-aware (`bg-background`, `text-foreground`). Root page is a `redirect("/videos")` with no UI — skip.
  **Context**: `layout.tsx:20` has only structural classes (`mx-auto max-w-5xl px-4 py-6`) — no color to migrate. Just verify the body receives the right default colors from the `@layer base` block added in Task 1.2.

### Phase 5: Migrate dialogs & modals

- [x] **Task 5.1: Migrate AddVideoModal to shadcn Dialog**
  **Files**: `src/app/videos/add-video-modal.tsx`
  **What**: Replace the hand-rolled backdrop + `role="dialog"` shell with `Dialog` / `DialogContent` / `DialogHeader` / `DialogTitle` / `DialogFooter`. Title input → `Input` + `Label`; Topic Info → `Textarea` + `Label`; Workflow dropdown → shadcn `Select`; Cancel → `Button variant="outline"`; Save/Create → `Button variant="default"`. Preserve "submit disabled until all three fields filled" (`canSubmit` at `lines 52-56`) and the `role="alert"` error row at `line 149` — swap `text-red-600` for `text-destructive`. Preserve the mode-based heading ("Edit Topic" vs "Add Topic") and Save/Create submit-label switch.
  **Context**: Existing backdrop at `line 94` (`fixed inset-0 z-40 bg-black/40`), dialog box at `line 98` (`w-full max-w-lg rounded bg-white p-6 shadow-lg`). Dialog handles focus trap, ESC dismiss, backdrop click, and body scroll lock — all of those can be removed from the old code. Keep POST `/api/videos` and PATCH `/api/videos/:id` call sites unchanged, keep `router.refresh()` + `onClose()` on success. Parent (`videos-client.tsx:194`) conditionally mounts the modal — pass `open={true}` to `Dialog` and wire `onOpenChange={(o) => !o && onClose()}` so ESC/backdrop clicks call the existing `onClose` prop; don't add `open` to the modal's public props.

- [x] **Task 5.2: Migrate ConfirmDialog to shadcn AlertDialog**
  **Files**: `src/app/videos/confirm-dialog.tsx`
  **What**: Replace hand-rolled dialog with `AlertDialog` / `AlertDialogContent` / `AlertDialogHeader` / `AlertDialogTitle` / `AlertDialogDescription` / `AlertDialogFooter` + `AlertDialogCancel` / `AlertDialogAction`. Preserve all props: `title`, `message`, `confirmLabel`, `destructive`, `busy`. The `destructive` prop should switch the action button to shadcn's `destructive` variant (not inline red ternary).
  **Context**: Current ternary at `lines 32-34` swaps `bg-red-600`↔`bg-blue-600`. Manual body scroll lock at `lines 24-30` can be deleted — Radix handles it. `autoFocus` on Cancel at `line 48` can be deleted — AlertDialog's default focus lands on Cancel. The `busy` prop should disable the action button and optionally show a spinner (use `Loader2` from lucide).

- [x] **Task 5.3: Migrate DeleteConfirmDialog to shadcn AlertDialog**
  **Files**: `src/app/videos/delete-confirm-dialog.tsx`
  **What**: Same pattern as Task 5.2. Preserve status-dependent message logic (different warning when video is `in_progress` — flags deferred cleanup). Preserve `onSuccess(deferred)` callback shape and the `DELETE /api/videos/:id` call site.
  **Context**: Keep this as its own component — do not collapse into `ConfirmDialog`. The status-dependent copy and the DELETE/onSuccess coupling are specific enough to warrant a dedicated wrapper.

### Phase 6: Migrate settings form

- [x] **Task 6.1: Replace manual tab bar with shadcn Tabs**
  **Files**: `src/app/settings/settings-form.tsx`
  **What**: Swap the `role="tablist"` block at `lines 153-181` for `Tabs` / `TabsList` / `TabsTrigger` / `TabsContent` with the existing five tab labels (ComfyUI, Google Flow, OpenRouter, AI33, Render). Keep the dirty-indicator dot at `lines 172-177` (rendered per-tab when that tab has unsaved changes) — Radix `TabsTrigger` accepts children, render the dot inside. Drop the active-tab `border-b-2 border-indigo-600 font-medium text-indigo-700` at `line 167` (shadcn Tabs uses a pill-style active state — deliberate visual change from underline to pill per Design Decisions). Convert dirty-dot `bg-orange-500` at `line 175` to `bg-orange-500 dark:bg-orange-400`.
  **Context**: Tab IDs and ordering must match current state; the dirty-indicator uses `aria-hidden="true"` at `line 174` — preserve the accessibility posture. Save button at `lines 360-366` → shadcn `Button variant="default"` (drop `bg-blue-600`) with proper `disabled` state. `Saved.` message at `lines 353-357` uses `bg-green-50 text-green-900` — convert to `bg-green-50 text-green-900 dark:bg-green-950 dark:text-green-100` per the "semantic status colors" rule.

- [x] **Task 6.2: Replace inline field primitives with shadcn form components**
  **Files**: `src/app/settings/settings-form.tsx`
  **What**: Delete the six private field primitives at `lines 374-515` (`ReadOnlyField`, `TextField`, `TextArea`, `NumberField`, `SelectField`, `BoolField`). In their place, use `Input` (`type="text"` / `type="number"` / `readOnly`), `Textarea`, `Select`, `Checkbox` — each paired with `Label`. Preserve the hint-line affordance (a small `text-muted-foreground` paragraph below the field).
  **Context**: Existing primitives are controlled components receiving `value` + `onChange` + optional `hint`. shadcn versions are also controlled — the call sites (many, one per setting) should keep the same prop shape but call shadcn components directly. Consider a thin `SettingField` wrapper in this file if repetition gets painful; don't over-abstract — match count of call sites to decide.

- [x] **Task 6.3: Card wrapper for settings page**
  **Files**: `src/app/settings/page.tsx`
  **What**: Wrap the page content in shadcn `Card` / `CardHeader` / `CardContent` for visual grouping. Move `<h1>` content into `CardTitle`.
  **Context**: Currently `settings/page.tsx` renders only `<h1 className="mb-4 text-2xl font-semibold">Settings</h1>` + `<SettingsForm>`.

### Phase 7: Migrate tables, badges, spinner

- [x] **Task 7.1: Migrate VideoQueueTable**
  **Files**: `src/app/videos/video-queue-table.tsx`
  **What**: Replace the raw `<table>` at `line 43` with shadcn `Table` / `TableHeader` / `TableBody` / `TableRow` / `TableHead` / `TableCell`. Rewrite `STATUS_BADGE: Record<VideoStatus, string>` at `lines 15-21` to pair shadcn `Badge` with semantic color overrides per the "semantic status colors" rule (keep yellow/gray/blue/green/red hues, add `dark:` variants). Action buttons per Design Decisions: Start at `line 94` → `variant="success"` + `Play` icon; Edit at `line 102` → `variant="default"` + `Pencil` icon (preserve `disabled={!canEdit(v.status)}` at `line 105`); Delete at `line 111` → `variant="outline"` + destructive className override + `Trash2` icon. Replace `<Spinner>` at `line 80` with `<Loader2 className="h-4 w-4 animate-spin" />` inline. Empty-state `text-gray-500` at `line 55` → `text-muted-foreground`.
  **Context**: Preserve `data-testid={`queue-row-${v.id}`}` at `line 67`. Preserve the `deleting` short-circuit at `lines 78-82` / `lines 110-118`. Don't change props passed from `videos-client.tsx`.

- [x] **Task 7.2: Migrate FinishedVideosTable**
  **Files**: `src/app/videos/finished-videos-table.tsx`
  **What**: Same table → shadcn Table migration as Task 7.1. Copy Path button at `lines 64-72` → shadcn `Button variant="outline"`. Current button is text-only ("Copy Path" / "Copied!"); the migration **adds** a lucide icon next to the text — `Copy` by default, swap to `Check` during the 2-second post-copy window (keep the existing `copiedId === v.id` state check at `line 71`). Empty-state `text-gray-500` at `line 46` → `text-muted-foreground`.
  **Context**: Preserve `data-testid={`finished-row-${v.id}`}` at `line 55`.

- [x] **Task 7.3: Delete the hand-rolled Spinner**
  **Files**: `src/app/videos/spinner.tsx` (delete), and its import sites
  **What**: Remove `src/app/videos/spinner.tsx` and all imports — replaced in Tasks 7.1 and 8.3 by inline `<Loader2 />`.
  **Context**: Only import sites today are `video-queue-table.tsx:5` and `video-actions.tsx:8`. Confirm no other references before deleting.

### Phase 8: Migrate client islands & remaining surfaces

- [x] **Task 8.1: Migrate VideosClient (toasts + headers)**
  **Files**: `src/app/videos/videos-client.tsx`
  **What**: Replace the `fixed bottom-4 right-4` toast stack at `lines 181-192` with `sonner`'s `toast.success()` / `toast.error()` API (import `toast` from `sonner`) — delete the `toasts` state array and the `dismissToast` helper at `lines 136-138`. Header buttons at `lines 142-160`: Add Topic at `line 145` → `Button variant="default"` + lucide `Plus`; Start All at `line 152` → `Button variant="success"` + lucide `Play` (preserve `disabled={!hasNew || startingAll}`).
  **Context**: The 5 s polling loop at `line 104` is load-bearing — do not touch. Modal open/close state stays in the client. Toast trigger points are the status-transition detections inside the polling effect near `line 97` — call `toast.success(...)` / `toast.error(...)` at those points instead of pushing into the local array.

- [x] **Task 8.2: Migrate VideoDetailClient**
  **Files**: `src/app/videos/[id]/video-detail-client.tsx`
  **What**: Replace unicode step icons (`STEP_ICONS` at `lines 18-22`) with a lucide icon map: `pending → Circle`, `running → Play`, `done → Check`, `failed → X`. Update `STEP_ICON_COLORS` (applied at `line 205`) to theme-aware classes: `text-muted-foreground` (pending), `text-primary` (running), `text-green-600 dark:text-green-400` (done), `text-destructive` (failed). Wrap the step list and artifact list in shadcn `Card` for visual grouping. Log/artifact links → `<a>` with `text-primary hover:underline` (or shadcn `Button asChild variant="link"` wrapping an anchor — implementer's call).
  **Context**: Preserve both polling intervals (5 s fetch, 1 s duration ticker).

- [x] **Task 8.3: Migrate VideoActions**
  **Files**: `src/app/videos/[id]/video-actions.tsx`
  **What**: Per Design Decisions button + icon map — Start at `line 85` → `variant="success"` + `Play`; Retry failed step at `line 97` → `variant="default"` + `RefreshCw`; Restart from beginning at `line 105` → `variant="destructive"` + `RotateCcw` (this is the true wipe-and-redo action); Copy Path at `line 117` → `variant="outline"` + `Copy`/`Check` swap on the 2-second copied state (`line 124`); Delete at `line 135` → `variant="outline"` + destructive className override + `Trash2`. Replace `<Spinner>` at `line 131` with `<Loader2 className="h-4 w-4 animate-spin" />`. Error row at `lines 145-149` keeps `role="alert"`; convert `text-red-600` to `text-destructive`. Deleting label at `lines 130-133`: keep the inline-flex layout, swap `text-gray-600` → `text-muted-foreground`.
  **Context**: This component owns its dialog open/close state per status (`confirmDelete`, `confirmRestart` at `lines 32-33`) — don't change that. Preserve the `ConfirmDialog` (Restart) and `DeleteConfirmDialog` wiring at `lines 152-173` — interfaces unchanged.

### Phase 9: Cleanup & verification

- [x] **Task 9.1: Sweep for stray hardcoded colors**
  **Files**: anywhere under `src/app/`
  **What**: Grep two classes of prefixes across `src/app/**/*.tsx`:

  **(a) Neutral / brand colors — convert to theme tokens.** Prefixes: `bg-white`, `bg-gray-`, `text-gray-`, `border-gray-`, `bg-indigo-`, `text-indigo-`, `border-indigo-`, `bg-blue-`, `text-blue-`. Replace with `bg-background`, `bg-muted`, `text-muted-foreground`, `border`, `bg-primary`, `text-primary`, `bg-accent`, `text-accent-foreground` as appropriate.

  **(b) Semantic status colors — preserve hue, ensure `dark:` variants exist.** Prefixes: `bg-red-`, `text-red-`, `border-red-`, `bg-green-`, `text-green-`, `bg-yellow-`, `text-yellow-`, `bg-orange-`, `text-orange-`. For each hit, decide: (i) if it's a destructive button or error affordance, convert to `text-destructive` / `bg-destructive` / `border-destructive` theme tokens (a theme token suffices, no `dark:` needed); (ii) if it's a semantic status color (status badges, `Saved.` message, step-icon colors, dirty dot), keep the hue family but add a `dark:` counterpart per Design Decisions "semantic status colors" pattern (e.g., `bg-green-100 text-green-900 dark:bg-green-900/40 dark:text-green-200`).

  **Context**: After Phases 4-8 most of these should be gone or already themed; this is a safety net. Don't change semantic meaning — a red destructive button should still look red in light mode, not gray. Also check bare `border` classes (no color): shadcn's `@layer base` remaps `border` to `--border`, so legacy `border` usages may now theme-switch in ways the original author didn't expect — scan for borders that should stay the same color regardless of theme.

- [x] **Task 9.2: Build + lint + test**
  **Files**: none
  **What**: Run `npm run lint`, `npm run build`, `npm run test`. Fix any type errors or lint warnings introduced by the migration. Confirm the worker build (`tsc -p tsconfig.worker.json`) still passes — `src/components/` is excluded from its include list, but `src/lib/utils.ts` is now in its scope and should compile cleanly.
  **Context**: Vitest has no UI tests today so it should stay green.

- [ ] **Task 9.3: Manual verification in both themes**
  **Files**: none (runtime check)
  **What**: Boot `npm run dev`, click through `/videos`, `/videos/[id]` (pick any existing video), `/settings`. In each route: toggle theme with the NavBar button, open every dialog (Add Video, Edit, Delete, Restart confirm), exercise every form tab, click a row's Start/Edit/Delete, trigger a toast (e.g., start a video to see the status-transition toast). Verify no flash of unstyled content on initial load (the `suppressHydrationWarning` added in Task 3.2 is required for this).
  **Context**: No automated UI tests exist, so this is the final gate. If a component renders broken in dark mode, trace it back to a hardcoded color missed in Phase 9.1.

## References

- shadcn/ui docs — ui.shadcn.com (install guide, components.json schema, component generators)
- `next-themes` README — ThemeProvider + `useTheme()` hook usage
- `lucide-react` icon index — lucide.dev/icons for picking replacements
- `CLAUDE.md` — `domain-dashboard` skill for dashboard conventions
