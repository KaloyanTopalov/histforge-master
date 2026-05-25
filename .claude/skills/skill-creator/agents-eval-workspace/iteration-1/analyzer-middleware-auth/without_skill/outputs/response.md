# Middleware Authentication and Deactivated User Blocking Analysis

## Current State: Middleware Is Disabled

The most critical finding is that **there is no active Next.js middleware running in this project**. Commit `7276b1f` ("chore(middleware): remove unused middleware file") renamed `middleware.ts` to `proxy.ts` and changed the exported function name from `middleware` to `proxy`. Next.js requires a root-level `middleware.ts` (or `.js`) exporting a function named `middleware` for it to be recognized. The `.next/server/middleware-manifest.json` confirms an empty middleware configuration:

```json
{
  "version": 3,
  "middleware": {},
  "sortedMiddleware": [],
  "functions": {}
}
```

The `proxy.ts` file at the project root is effectively dead code.

## The Middleware Logic (in `lib/supabase/middleware.ts`)

Despite the middleware not being active, the core logic still exists in `lib/supabase/middleware.ts` and is exported as `updateSession()`. If re-enabled, it would run on every matched request (everything except static assets, image optimization, favicons, API routes, and public assets).

### Session Refresh

The `updateSession` function (lines 4-75 of `lib/supabase/middleware.ts`) creates a Supabase server client wired into the request/response cookie flow. It calls `supabase.auth.getUser()`, which:

1. Reads the user's JWT from cookies.
2. If the access token is expired but a refresh token exists, Supabase SDK automatically refreshes it.
3. The `setAll` callback propagates any new tokens back into both the request cookies (for downstream server components) and the response cookies (so the browser receives updated tokens).

### Unauthenticated User Redirect (lines 38-46)

If `getUser()` returns no user and the request path is not `/login` or `/auth`, the middleware redirects to `/login`.

### Deactivated User Blocking (lines 48-72)

For authenticated users not on `/login` or `/auth`, the middleware:

1. Queries the `profiles` table for the user's `is_active` flag.
2. If `is_active` is `false`:
   - Calls `supabase.auth.signOut()` to clear the session server-side.
   - Copies the session-clearing cookies from the sign-out response to a redirect response.
   - Redirects to `/login?error=deactivated`.
3. The login page (`app/login/page.tsx`) reads this `error` query parameter and shows a red banner: "Your account has been deactivated. Please contact an administrator."

### Route Matcher Configuration (from the original `middleware.ts`, now in `proxy.ts`)

```
"/((?!_next/static|_next/image|favicon.ico|api/|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"
```

This excludes:
- `_next/static` and `_next/image` (framework assets)
- `favicon.ico`
- API routes (`/api/...`) -- these handle their own auth
- Public image files (svg, png, jpg, etc.)

## Defense-in-Depth: API Route Guards

Since the middleware is currently disabled, authentication and deactivation checks are handled **entirely at the API route level**:

### `/api/chat/route.ts`
- Calls `supabase.auth.getUser()` and returns 401 if no user.
- Queries `profiles.is_active` and returns 403 ("Account deactivated") if inactive.
- Also verifies conversation ownership before proceeding.

### `/api/conversations/route.ts`
- Uses a shared `getActiveUser()` helper that combines both the auth check and the `is_active` check.
- Returns 401 for unauthenticated or deactivated users on all three handlers (GET, POST, DELETE).

### `/api/admin/users/route.ts`
- Uses a `verifyAdmin()` helper that checks authentication and verifies the user's `role` is `"admin"` (using the service role client to bypass RLS).
- Returns 403 for non-admin users.
- Prevents admins from deactivating themselves.

## Database Schema

The `profiles` table (migration `001_profiles.sql`) defines:
- `is_active BOOLEAN NOT NULL DEFAULT TRUE` -- new users are active by default.
- A trigger `on_auth_user_created` auto-creates a profile row when a user signs up via Supabase Auth.
- RLS policies are in place on all tables (as noted in the project conventions).

## Key Files

| File | Role |
|------|------|
| `C:\Users\alexa\Desktop\jw-assistant\lib\supabase\middleware.ts` | Core middleware logic: session refresh, auth redirect, deactivation blocking |
| `C:\Users\alexa\Desktop\jw-assistant\proxy.ts` | Dead code -- renamed from `middleware.ts`, not recognized by Next.js |
| `C:\Users\alexa\Desktop\jw-assistant\app\login\page.tsx` | Displays deactivation error message |
| `C:\Users\alexa\Desktop\jw-assistant\app\api\chat\route.ts` | API-level auth + deactivation guard |
| `C:\Users\alexa\Desktop\jw-assistant\app\api\conversations\route.ts` | API-level auth + deactivation guard via `getActiveUser()` |
| `C:\Users\alexa\Desktop\jw-assistant\app\api\admin\users\route.ts` | Admin-only auth guard via `verifyAdmin()` |
| `C:\Users\alexa\Desktop\jw-assistant\app\auth\callback\route.ts` | OAuth callback -- exchanges code for session |
| `C:\Users\alexa\Desktop\jw-assistant\lib\supabase\server.ts` | Server-side Supabase client factory (used by API routes) |
| `C:\Users\alexa\Desktop\jw-assistant\lib\supabase\client.ts` | Browser-side Supabase client factory |
| `C:\Users\alexa\Desktop\jw-assistant\supabase\migrations\001_profiles.sql` | Profiles table schema with `is_active` column |

## Summary

The project was designed with a two-layer auth strategy: Next.js middleware for page-level protection plus API route guards for endpoint-level protection. However, the middleware layer was disabled in commit `7276b1f` when `middleware.ts` was renamed to `proxy.ts`. Currently, **only the API route guards are enforcing authentication and deactivation checks**. This means unauthenticated users can still reach protected page components (though they will fail when those components try to call the guarded API routes). The `updateSession` logic in `lib/supabase/middleware.ts` is intact and ready to be re-enabled by restoring the root `middleware.ts` file with the proper `middleware` export name.
