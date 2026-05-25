## File Locations for Authentication and Authorization Logic

### Entry Point: Next.js Middleware (Route Protection)

- `lib/supabase/middleware.ts` — The `updateSession` function. This is the core auth middleware helper. It refreshes the Supabase session on every request, redirects unauthenticated users to `/login`, and blocks deactivated users by checking `profiles.is_active`, signing them out and redirecting with `?error=deactivated`.

The root Next.js middleware.ts file (which would call `updateSession` and define the `matcher` config) is compiled into `.next/server/middleware.js` — the source file appears to have been removed after the recent commit `7276b1f chore(middleware): remove unused middleware file`, but `lib/supabase/middleware.ts` remains as the session-refresh helper.

### OAuth Login Flow

- `app/login/page.tsx` — Login page. Renders `LoginCard` and displays a deactivated-account error banner when `?error=deactivated` is in the URL.
- `components/auth/login-card.tsx` — Login UI component. Calls `supabase.auth.signInWithOAuth({ provider: "google" })` to initiate Google OAuth.
- `app/auth/callback/route.ts` — OAuth callback route. Exchanges the OAuth `code` for a session via `supabase.auth.exchangeCodeForSession(code)`, then redirects to the app root (or back to `/login` on failure).

### Supabase Client Helpers

- `lib/supabase/server.ts` — Server-side Supabase client factory (`createClient`). Uses `@supabase/ssr` with cookie handling for Server Components and API routes.
- `lib/supabase/client.ts` — Browser-side Supabase client factory.

### API Route Authorization Checks

All four API routes verify the session and `is_active` status before processing requests:

- `app/api/chat/route.ts` — Calls `supabase.auth.getUser()`, then queries `profiles.is_active`; returns 401 if not active.
- `app/api/conversations/route.ts` — Same pattern: `getUser()` + `profiles.is_active` check.
- `app/api/admin/users/route.ts` — Calls `getUser()`, then checks `profile.role !== "admin"` to gate admin-only operations (list all users, toggle `is_active`).
- `app/api/admin/config/route.ts` — Same admin role check (`profile.role !== "admin"`).

### Database Schema: Profiles and Roles

- `supabase/migrations/001_profiles.sql` — Defines the `profiles` table with `role TEXT CHECK (role IN ('user', 'admin'))` and `is_active BOOLEAN DEFAULT TRUE`. Also defines the `handle_new_user()` trigger that auto-creates a profile row when a new `auth.users` record is inserted.

### Database Authorization: Row-Level Security

- `supabase/migrations/004_rls_policies.sql` — Defines all RLS policies:
  - `is_admin()` SQL function (SECURITY DEFINER) — checks `role = 'admin'` for the current `auth.uid()`, used by policies to avoid recursion.
  - `profiles`: users can select their own row; admins can select and update all rows.
  - `conversations`: users can only access rows where `user_id = auth.uid()`.
  - `messages`: users can only access messages in their own conversations.
  - `config`: anyone can read; only admins can update.

### Protected Route Group

- `app/(protected)/layout.tsx` — Layout wrapping all auth-required pages (chat, admin). Does not contain explicit auth checks itself; relies on the middleware layer for session enforcement.
- `app/(protected)/admin/page.tsx` — Admin panel page (authorization enforced at the API route level).

### Related Directories Summary

- `components/auth/` — 1 file (`login-card.tsx`), OAuth sign-in UI
- `app/auth/` — 1 file (`callback/route.ts`), OAuth code exchange
- `lib/supabase/` — 3 files, Supabase client factories and session middleware helper
- `supabase/migrations/` — `001_profiles.sql` (schema + trigger), `004_rls_policies.sql` (all RLS + `is_admin()`)
- `app/api/` — 4 route files all containing inline session + role/active checks
