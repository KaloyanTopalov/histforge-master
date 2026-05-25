# Authentication and Authorization Logic in jw-assistant

## Overview

The codebase implements a multi-layered auth system using Supabase Auth (Google OAuth) with Row-Level Security (RLS) at the database layer, Next.js middleware for session management and route protection, and per-route authorization checks in API handlers and pages.

---

## 1. Middleware Layer (Request Interception)

### `proxy.ts` (project root)
The Next.js middleware entry point. It delegates to `updateSession` and defines a matcher that covers all routes **except** static assets and `/api/` routes (which handle their own auth).

- **Matcher pattern**: `/((?!_next/static|_next/image|favicon.ico|api/|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)`
- Exports a `proxy` function (Next.js 16 middleware convention).

### `lib/supabase/middleware.ts`
Contains the `updateSession` function, which is the core middleware logic:

1. **Session refresh**: Creates a Supabase server client bound to the request cookies, calls `supabase.auth.getUser()` to refresh tokens (triggering cookie updates via `setAll`).
2. **Unauthenticated redirect**: If no user is found and the path is not `/login` or `/auth`, redirects to `/login`.
3. **Deactivated user blocking**: If a user exists, queries `profiles.is_active`. If `false`, signs the user out, clears session cookies, and redirects to `/login?error=deactivated`.

---

## 2. OAuth Login Flow

### `app/login/page.tsx`
Renders the `LoginCard` component. Displays a "deactivated" error banner when the `?error=deactivated` query param is present.

### `components/auth/login-card.tsx`
Client component that calls `supabase.auth.signInWithOAuth({ provider: "google" })`, redirecting the user to Google and then back to `/auth/callback`.

### `app/auth/callback/route.ts`
OAuth callback handler. Exchanges the authorization `code` for a session via `supabase.auth.exchangeCodeForSession(code)`. On success, redirects to the app root; on failure, redirects to `/login`.

---

## 3. Supabase Client Creation

### `lib/supabase/server.ts`
Creates a **server-side** Supabase client using `@supabase/ssr`'s `createServerClient`, bound to the Next.js `cookies()` store. Used in Server Components and API routes for authenticated (anon-key) queries.

### `lib/supabase/client.ts`
Creates a **browser-side** Supabase client using `createBrowserClient`. Used in client components for auth operations and data fetching.

### Service Role Client (inline in API routes)
Several API routes (`app/api/chat/route.ts`, `app/api/conversations/route.ts`, `app/api/admin/users/route.ts`, `app/api/admin/config/route.ts`) create a **service role** client using `SUPABASE_SERVICE_ROLE_KEY` for privileged operations that bypass RLS (e.g., persisting messages, reading all profiles for admin).

---

## 4. API Route Authorization

### `app/api/chat/route.ts` (POST)
Three-step authorization:
1. Verifies the user is authenticated via `supabase.auth.getUser()` -- returns 401 if not.
2. Checks `profiles.is_active` -- returns 403 ("Account deactivated") if false.
3. Verifies conversation ownership by querying `conversations` with both `id` and `user_id` constraints -- returns 404 if the conversation does not belong to the user.

### `app/api/conversations/route.ts` (GET, POST, DELETE)
Uses a shared `getActiveUser()` helper that:
1. Calls `supabase.auth.getUser()`.
2. Checks `profiles.is_active`.
3. Returns `null` (triggering a 401 response) if either check fails.

The DELETE handler additionally scopes the deletion to `user_id = user.id` ensuring ownership.

### `app/api/admin/users/route.ts` (GET, PATCH)
Uses a `verifyAdmin()` helper that:
1. Gets the authenticated user.
2. Queries the profile's `role` via the **service role client** (bypasses RLS).
3. Returns `null` (triggering a 403 "Forbidden" response) if the role is not `"admin"`.

The PATCH handler has an additional self-protection check: an admin cannot deactivate themselves (`userId === admin.id` returns 400).

### `app/api/admin/config/route.ts` (GET, PUT)
Uses the same `verifyAdmin()` pattern as the users route. Only admins can read or update the system prompt configuration.

---

## 5. Page-Level Authorization

### `app/(protected)/chat/[id]/page.tsx`
Server Component that:
1. Calls `supabase.auth.getUser()` -- redirects to `/login` if unauthenticated.
2. Verifies conversation ownership by querying with `user_id = user.id` -- redirects to `/` if the conversation is not found.

### `app/(protected)/admin/page.tsx`
Client Component that:
1. Checks authentication via `supabase.auth.getUser()` -- redirects to `/login` if unauthenticated.
2. Queries `profiles.role` -- displays an "unauthorized" shield UI if the user is not an admin.

### `components/sidebar/user-menu.tsx`
Conditionally renders the "Admin Panel" menu item only when `profile.role === "admin"`. This is a UI-only check; actual enforcement is in the API routes.

### `components/sidebar/left-sidebar.tsx`
Fetches conversations scoped to the authenticated user (`user_id = user.id`) via the Supabase client, which is subject to RLS.

---

## 6. Database Row-Level Security (RLS)

### `supabase/migrations/004_rls_policies.sql`

**Helper function** -- `public.is_admin()`: A `SECURITY DEFINER` SQL function that checks if the current authenticated user (`auth.uid()`) has `role = 'admin'` in the `profiles` table. Defined as `SECURITY DEFINER` to avoid RLS recursion when used within RLS policies.

**Profiles table**:
- `SELECT`: Users can view their own profile (`auth.uid() = id`).
- `SELECT`: Admins can view all profiles (`is_admin()`).
- `UPDATE`: Only admins can update profiles (`is_admin()`).
- `INSERT`: Open (`WITH CHECK (TRUE)`) to allow the trigger-based auto-creation on signup.

**Conversations table**:
- `ALL` operations: Users can only access their own conversations (`auth.uid() = user_id`).

**Messages table**:
- `ALL` operations: Users can only access messages belonging to their own conversations (via a subquery joining to `conversations.user_id`).

**Config table**:
- `SELECT`: Anyone can read config values (system prompt is needed by the chat route).
- `UPDATE`: Only admins can update config (`is_admin()`).

**Documents table** (in `005_documents.sql`):
- `ALL` operations: Restricted to `service_role` only. Regular users cannot access the RAG knowledge base directly.

---

## 7. Auto-Profile Creation

### `supabase/migrations/001_profiles.sql`

A database trigger (`on_auth_user_created`) fires `AFTER INSERT ON auth.users` and runs `handle_new_user()`, which automatically creates a `profiles` row for every new Supabase Auth user. The function is `SECURITY DEFINER` to bypass RLS. New users default to `role = 'user'` and `is_active = TRUE`.

---

## Summary of Files

| File | Auth/Authz Role |
|------|----------------|
| `proxy.ts` | Next.js middleware entry point; delegates to `updateSession` |
| `lib/supabase/middleware.ts` | Session refresh, unauthenticated redirect, deactivated-user blocking |
| `lib/supabase/server.ts` | Server-side Supabase client factory (cookie-bound, anon key) |
| `lib/supabase/client.ts` | Browser-side Supabase client factory |
| `app/login/page.tsx` | Login page with deactivation error display |
| `components/auth/login-card.tsx` | Google OAuth sign-in trigger |
| `app/auth/callback/route.ts` | OAuth code-to-session exchange |
| `app/api/chat/route.ts` | Auth + active check + conversation ownership verification |
| `app/api/conversations/route.ts` | Auth + active check via `getActiveUser()` helper |
| `app/api/admin/users/route.ts` | Auth + admin role check via `verifyAdmin()` helper |
| `app/api/admin/config/route.ts` | Auth + admin role check via `verifyAdmin()` helper |
| `app/(protected)/chat/[id]/page.tsx` | Server-side auth check + conversation ownership |
| `app/(protected)/admin/page.tsx` | Client-side auth + admin role check |
| `components/sidebar/user-menu.tsx` | UI-only admin menu visibility toggle |
| `components/sidebar/left-sidebar.tsx` | Fetches user-scoped data (RLS enforced) |
| `supabase/migrations/001_profiles.sql` | Profile schema, auto-creation trigger |
| `supabase/migrations/004_rls_policies.sql` | All RLS policies + `is_admin()` helper function |
| `supabase/migrations/005_documents.sql` | Documents RLS (service_role only) |
