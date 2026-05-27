import { resolve } from "node:path";
import type { Database as DatabaseType } from "better-sqlite3";
import { getDb } from "@/lib/db";
import { getVideosPageState } from "@/lib/videos-page-state";
import { listWorkflows } from "@/lib/workflows";
import * as visualStylesRepo from "@/lib/repos/visual-styles";
import {
  VideosClient,
  type VideosClientVisualStyle,
  type VideosClientWorkflow,
} from "./videos-client";

/**
 * Project the workflows table down to the dropdown shape the Add Video
 * modal consumes. Disabled rows are excluded so retired workflows can be
 * hidden from the picker without breaking historical references in
 * existing video rows.
 */
export function listEnabledWorkflowsForClient(
  db: DatabaseType
): VideosClientWorkflow[] {
  return listWorkflows(db)
    .filter((w) => w.enabled === 1)
    .map((w) => ({
      id: w.id,
      shortLabel: w.short_label,
      label: w.label,
      kind: w.kind,
    }));
}

/**
 * Project the visual_styles table down to the dropdown shape the topic-
 * creation modals consume. Mirrors `listEnabledWorkflowsForClient` —
 * single server-side fetch passed to both modals via the client island.
 */
export function listVisualStylesForClient(
  db: DatabaseType
): VideosClientVisualStyle[] {
  return visualStylesRepo.list(db).map((s) => ({
    id: s.id,
    title: s.title,
    prompt: s.prompt,
  }));
}

// VideosClient calls `useSearchParams()` to read the active tab from the URL.
// Next.js requires either a Suspense boundary around such consumers or the
// page itself to opt out of static prerendering. The page reads live DB
// state (workflows, visual styles, queue snapshot) on every request anyway,
// so static prerender provides no value — force dynamic rendering.
export const dynamic = "force-dynamic";

/**
 * Videos list page. Fetches every video server-side and hands it to the
 * client island, which owns the queue/finished split, polling, and toasts.
 */
export default function VideosPage(): JSX.Element {
  const db = getDb();
  const state = getVideosPageState(db);
  const workflows = listEnabledWorkflowsForClient(db);
  const visualStyles = listVisualStylesForClient(db);
  const projectsDir = resolve(process.env.PROJECTS_DIR ?? "./projects");

  return (
    <VideosClient
      initialVideos={state.videos}
      initialQueueState={state.queueState}
      initialBannerFlags={state.bannerFlags}
      workflows={workflows}
      visualStyles={visualStyles}
      projectsDir={projectsDir}
      // Server-rendered timestamp used as the initial value of the
      // per-row timer clock. SSR and the first client render both read
      // this prop, so the hydrated HTML matches; `useNowTick` then snaps
      // to the real client clock after mount. See `lib/use-now-tick.ts`.
      serverNow={Date.now()}
    />
  );
}
