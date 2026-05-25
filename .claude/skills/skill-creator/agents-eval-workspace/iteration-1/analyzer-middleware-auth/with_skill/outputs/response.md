## Analysis: Middleware Authentication and Deactivated User Blocking

### Overview

Authentication and deactivated-user blocking are implemented across two files: `proxy.ts` at the project root is the actual Next.js middleware entry point, and `lib/supabase/middleware.ts` contains all logic inside the `updateSession` function. Every incoming request that is not a static asset or API route passes through this pipeline. The function constructs a Supabase SSR client, refreshes the session, then applies two sequential gate checks: unauthenticated users are redirected to `/login`, and authenticated users with `is_active = false` in the `profiles` table are signed out and redirected to `/login?error=deactivated`.

### Entry Points

- `proxy.ts:4` — `proxy(request)` function exported as the Next.js middleware handler
- `proxy.ts:8-19` — `config.matcher` array, defines which URL patterns Next.js intercepts
- `lib/supabase/middleware.ts:4` — `updateSession(request)` function, contains all auth and blocking logic

### Core Implementation

#### 1. Route Matching (`proxy.ts:8-19`)

The `config` export at `proxy.ts:8` defines a single `matcher` regex pattern using a negative lookahead. Routes excluded from middleware processing are:

- `_next/static` — static file assets
- `_next/image` — image optimization
- `favicon.ico`
- `api/` — the entire API route tree (API routes handle their own auth independently)
- Files ending in `.svg`, `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`

All other paths, including the `(protected)/` route group, are included.

#### 2. Supabase SSR Client Construction (`lib/supabase/middleware.ts:5-30`)

`updateSession` first creates an initial `supabaseResponse` via `NextResponse.next()` at line 5. A Supabase client is instantiated at line 9 using `createServerClient` from `@supabase/ssr`, with `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`. A cookie adapter is passed with two methods:

- `getAll()` at line 14 reads all cookies from `request.cookies`
- `setAll()` at line 17 writes cookies both into `request.cookies` and into a new `NextResponse` that replaces `supabaseResponse` (lines 21-26)

This replacement pattern ensures any token updates are reflected in the response that ultimately goes back to the browser.

#### 3. Session Refresh (`lib/supabase/middleware.ts:33-35`)

`supabase.auth.getUser()` is called at line 35. The comment at line 32 notes this triggers `setAll` if tokens are updated. When the access token has expired, the Supabase client uses the refresh token to obtain new tokens, firing the `setAll` cookie adapter, which replaces `supabaseResponse` with a new response carrying updated `Set-Cookie` headers.

#### 4. Unauthenticated User Redirect (`lib/supabase/middleware.ts:38-46`)

When `user` is falsy and the request path does not start with `/login` or `/auth`, the function clones the current URL at line 43, sets its pathname to `/login`, and returns `NextResponse.redirect(url)` at line 45.

The `/auth` exclusion allows the OAuth callback handler at `app/auth/callback/route.ts` to complete without interception.

#### 5. Deactivated User Blocking (`lib/supabase/middleware.ts:49-72`)

When `user` is truthy and the path is not `/login` or `/auth`, a database query runs at lines 54-58:

```ts
const { data: profile } = await supabase
  .from("profiles")
  .select("is_active")
  .eq("id", user.id)
  .single();
```

If `profile` exists and `profile.is_active` is `false`, the blocking sequence at lines 61-70 executes:

1. `supabase.auth.signOut()` is called at line 61
2. The current URL is cloned and its pathname set to `/login` at line 63
3. `url.searchParams.set("error", "deactivated")` appends the error parameter at line 64
4. A new redirect response is created via `NextResponse.redirect(url)` at line 65
5. All cookies currently on `supabaseResponse` (now containing sign-out cookies) are iterated at lines 67-69 and copied to `redirectResponse`
6. `redirectResponse` is returned at line 70

#### 6. Normal Request Flow (`lib/supabase/middleware.ts:74`)

If neither gate check triggers, `supabaseResponse` is returned with any refreshed tokens.

### Deactivated Error Banner (`app/login/page.tsx:10-19`)

The login page receives `searchParams` as a Promise. At line 10, `error` is destructured from the resolved params. When `error === "deactivated"`, lines 15-18 render a red bordered banner with the message "Your account has been deactivated. Please contact an administrator."

### Data Flow

1. Request arrives matching the pattern in `proxy.ts:18`
2. Next.js calls `proxy(request)` at `proxy.ts:4`
3. `updateSession(request)` called at `proxy.ts:5`
4. Initial `supabaseResponse` created at `lib/supabase/middleware.ts:5`
5. Supabase SSR client constructed with cookie adapter at `lib/supabase/middleware.ts:9-30`
6. `getUser()` called at `lib/supabase/middleware.ts:35`; if tokens rotate, `supabaseResponse` is replaced with updated cookies
7. If no user and path not `/login` or `/auth`: redirect to `/login` returned at `lib/supabase/middleware.ts:45`
8. If user present and path not `/login` or `/auth`: `profiles` queried for `is_active` at `lib/supabase/middleware.ts:54-58`
9. If `is_active` is false: sign out at line 61, redirect to `/login?error=deactivated` returned at line 70 with session-clearing cookies
10. Otherwise: `supabaseResponse` returned at `lib/supabase/middleware.ts:74`

### Route Protection Summary

| Path | Auth check | Deactivated check |
|---|---|---|
| `/_next/static/**`, `/_next/image/**` | Skipped — matcher excluded | Skipped — matcher excluded |
| `/api/**` | Skipped — matcher excluded | Skipped — matcher excluded |
| `/favicon.ico`, image files | Skipped — matcher excluded | Skipped — matcher excluded |
| `/login` | Skipped — path condition | Skipped — path condition |
| `/auth/**` | Skipped — path condition | Skipped — path condition |
| All other routes | Applied — redirects to `/login` | Applied — signs out, redirects to `/login?error=deactivated` |

### Key Files

- `proxy.ts` — Next.js middleware entry point and route matcher configuration
- `lib/supabase/middleware.ts` — All auth and deactivation logic inside `updateSession`
- `app/login/page.tsx` — Renders the deactivated account error banner
