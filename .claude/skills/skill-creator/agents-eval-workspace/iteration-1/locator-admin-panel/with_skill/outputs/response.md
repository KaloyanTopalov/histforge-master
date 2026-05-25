## File Locations for Admin Panel

### Page / Route

- `app/(protected)/admin/page.tsx` — The admin panel page component. Lives inside the `(protected)` route group (requires authentication). Imports `UserManagement` and `SystemPromptEditor` components, fetches from both admin API routes, and guards access by checking `profile.role === 'admin'`.

### API Routes

- `app/api/admin/users/route.ts` — REST handler for user management operations (listing/updating users).
- `app/api/admin/config/route.ts` — REST handler for reading and writing system configuration (e.g., system prompt).

### UI Components

- `components/admin/user-management.tsx` — User management UI component used inside the admin page.
- `components/admin/system-prompt-editor.tsx` — System prompt editor UI component used inside the admin page.

### Navigation Entry Point

- `components/sidebar/user-menu.tsx` — The user menu in the left sidebar. Renders an "Admin Panel" `DropdownMenuItem` that navigates to `/admin` when `profile.role === 'admin'`.

### Database / Auth Layer

- `supabase/migrations/001_profiles.sql` — Defines the `profiles` table with a `role` column constrained to `'user'` or `'admin'`.
- `supabase/migrations/004_rls_policies.sql` — Defines the `is_admin()` helper function and RLS policies: "Admins can view all profiles", "Admins can update profiles", and "Admins can update config".

### Related Directories (Clusters)

- `app/(protected)/admin/` — Contains 1 file (`page.tsx`), the admin page route.
- `app/api/admin/` — Contains 2 subdirectories (`users/`, `config/`), each with a `route.ts` file.
- `components/admin/` — Contains 2 component files (`user-management.tsx`, `system-prompt-editor.tsx`).
