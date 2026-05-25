# Admin Panel -- All Related Files

## 1. Page & UI Components (Source Code)

### Admin Page (entry point)
- **`app/(protected)/admin/page.tsx`** -- Client component. The main admin panel page rendered inside the protected route group. Checks auth + admin role client-side on mount, fetches from `/api/admin/users` and `/api/admin/config` in parallel, renders `UserManagement` and `SystemPromptEditor` inside shadcn Card wrappers. Shows an unauthorized state with a "Go back" button if the user's `profile.role !== "admin"`.

### Admin Components
- **`components/admin/user-management.tsx`** -- Client component. Receives a `users` array as prop, manages local copy in state. Renders a table with avatar, role badge (admin/user), status badge (Active/Deactivated), last-updated date, and a "Deactivate/Reactivate" toggle button. Calls `PATCH /api/admin/users`. Hides the action button for rows where `user.role === "admin"` (prevents admin self-deactivation from UI).
- **`components/admin/system-prompt-editor.tsx`** -- Client component. Renders a resizable monospace `Textarea` for editing the global system prompt. Tracks both `value` (current input) and `savedValue` (last persisted value) to determine save-button enabled state. Calls `PUT /api/admin/config`. Shows a transient "Saved" label for 3 seconds on success via `setTimeout`.

### Navigation Entry Point
- **`components/sidebar/user-menu.tsx`** -- Contains the user dropdown menu in the left sidebar. Conditionally renders an "Admin Panel" menu item (with ShieldIcon) when `profile.role === "admin"`, which navigates to `/admin`.

## 2. API Routes (Backend)

- **`app/api/admin/users/route.ts`** -- Handles `GET` (list all profiles) and `PATCH` (toggle `is_active` on a single profile). Both methods use `verifyAdmin()` which checks the caller's role via the Supabase service role client (bypasses RLS). The PATCH handler includes a self-deactivation guard (`userId === admin.id`).
- **`app/api/admin/config/route.ts`** -- Handles `GET` (read the `system_prompt` config row) and `PUT` (update it). Same `verifyAdmin()` pattern. PUT trims whitespace and rejects empty strings. Writes `updated_by` with the admin's user ID.

## 3. Database Migrations (Schema & Policies)

- **`supabase/migrations/001_profiles.sql`** -- Creates the `profiles` table with `role` (CHECK IN ('user','admin')), `is_active`, and related columns. Also creates the `handle_new_user()` trigger function and `on_auth_user_created` trigger that auto-creates a profile row on signup.
- **`supabase/migrations/003_config.sql`** -- Creates the `config` key-value table (`key TEXT PRIMARY KEY`, `value TEXT NOT NULL`, `updated_at`, `updated_by`). Seeds the default `system_prompt` row.
- **`supabase/migrations/004_rls_policies.sql`** -- Defines Row Level Security policies for admin operations:
  - Creates the `public.is_admin()` helper function (SECURITY DEFINER) to avoid RLS recursion.
  - Profiles: admins can SELECT all rows and UPDATE any row.
  - Config: anyone can SELECT; only admins can UPDATE.

## 4. Middleware (Auth Enforcement for Deactivated Users)

- **`lib/supabase/middleware.ts`** -- The `updateSession()` function refreshes the Supabase session and blocks deactivated users. When `is_active` is false, it signs the user out and redirects to `/login?error=deactivated`. This enforces the admin's deactivation action at the middleware layer.

## 5. Related Files (Indirect References)

- **`app/login/page.tsx`** -- Displays a "Your account has been deactivated. Please contact an administrator." banner when the `error=deactivated` query parameter is present (set by middleware after admin deactivates a user).
- **`app/api/chat/route.ts`** -- Reads the `system_prompt` from the `config` table (the value managed via the admin panel's SystemPromptEditor) before each LLM call.
- **`app/(protected)/layout.tsx`** -- The protected route group layout that wraps the admin page; provides the three-panel shell (sidebars + main content area).

## 6. Skill Documentation

- **`.claude/skills/domain-admin-users/SKILL.md`** -- Claude skill file documenting admin panel architecture, patterns, and pitfalls.
- **`.claude/skills/domain-admin-users/references/current-state.md`** -- Auto-generated reference with current file paths, API route details, schema columns, and component state breakdown.

## Summary

The admin panel consists of **5 primary source files** (1 page, 2 components, 2 API routes), **3 database migrations** (profiles table, config table, RLS policies), **1 middleware helper** (deactivated user enforcement), and **2 indirectly related files** (login page error display, chat route system prompt consumption). The navigation entry point lives in the user menu component in the sidebar.
