import { redirect } from "next/navigation";

// Spec docs/histforge-spec.md:82 — root redirects to /videos (the home
// dashboard). Real pages land in Phase 2.
export default function Page(): never {
  redirect("/videos");
}
