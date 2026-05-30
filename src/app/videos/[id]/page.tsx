import { notFound } from "next/navigation";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getDb } from "@/lib/db";
import { getImageChunkPacing, getSetting } from "@/lib/settings";
import { listProjectFiles } from "@/lib/project-files";
import { buildFlowSummary, type FlowSummary } from "@/lib/flow-summary";
import { INTERMEDIATE_DIRS } from "@/lib/lifecycle/video";
import * as gfRepo from "@/lib/repos/google-flow";
import * as videosRepo from "@/lib/repos/videos";
import * as stepsRepo from "@/lib/repos/steps";
import { getWorkflowFromDb } from "@/lib/workflows";
import { VideoDetailClient } from "./video-detail-client";

interface VideoDetailProps {
  params: { id: string };
}

export default function VideoDetailPage({
  params,
}: VideoDetailProps): JSX.Element {
  const db = getDb();
  const video = videosRepo.findById(db, params.id);
  if (!video) {
    notFound();
  }
  const orderedSteps = stepsRepo.findByVideo(db, params.id);

  const projectsDir = process.env.PROJECTS_DIR ?? "./projects";
  const projectDir = join(projectsDir, params.id);
  const artifacts = listProjectFiles(projectDir);

  const workflow = getWorkflowFromDb(db, video.workflow_id);
  const workflowLabel = workflow?.label ?? video.workflow_id;
  const initialQueueState = getSetting("queue_state", db);

  // Gate Flow surfaces on provider columns, not the workflow id literal —
  // user-authored workflows (e.g. "google-flow-chatterbox") use Google Flow
  // as image/video provider but carry a different id.
  const usesGoogleFlow =
    workflow?.image_provider === "google_flow" ||
    workflow?.video_provider === "google_flow";

  const initialFlowSummary: FlowSummary | null = usesGoogleFlow
    ? buildFlowSummary(db, params.id)
    : null;

  const initialFlowRecoveryAccounts = usesGoogleFlow
    ? gfRepo.listRecoveryAccounts(db)
    : [];

  // Fleet-level Veo-congestion banner — surfaced on every video-detail
  // page (not just Flow ones) because the underlying signal is global,
  // and an operator viewing any video benefits from knowing the fleet is
  // throttled.
  const initialFlowServiceOverloadUntil = getSetting(
    "flow_service_overload_until",
    db
  );

  // Resolved global pacing for the per-video pacing panel. Passing
  // explicit NULLs forces the resolver to read every component from the
  // global settings — those are the values the panel uses as placeholder
  // text so the operator sees what NULL falls through to.
  const globalPacing = getImageChunkPacing(
    {
      image_chunk_target_seconds: null,
      image_chunk_min_seconds: null,
      image_chunk_max_seconds: null,
    },
    db
  );

  // Source preference for the panel's word-count hint: ready-script
  // `provided_script` first, then the on-disk assembled script (written
  // by step 05). Both are split on whitespace runs and counted; neither
  // is exact, but the hint already disclaims "≈" so a sentence-tokenizer
  // here would be premature.
  const scriptWordCount = computeScriptWordCount(
    video.provided_script,
    join(projectsDir, params.id, "script", "full_script.md")
  );

  // True when any of the four intermediate dirs is present in the
  // listed artifacts. Drives the Cleanup intermediates button's
  // disabled state. Uses the same INTERMEDIATE_DIRS list that
  // lifecycle/video.ts:cleanupIntermediates consults, so the UI and
  // route can never disagree about what counts as an intermediate.
  const intermediatesPresent = artifacts.some((p) =>
    INTERMEDIATE_DIRS.some((dir) => p.startsWith(`${dir}/`))
  );

  return (
    <VideoDetailClient
      videoId={params.id}
      initialVideo={video}
      initialSteps={orderedSteps}
      initialArtifacts={artifacts}
      projectsDir={resolve(projectsDir)}
      initialWorkflowLabel={workflowLabel}
      initialQueueState={initialQueueState}
      usesGoogleFlow={usesGoogleFlow}
      initialFlowSummary={initialFlowSummary}
      initialFlowRecoveryAccounts={initialFlowRecoveryAccounts}
      initialFlowServiceOverloadUntil={initialFlowServiceOverloadUntil}
      globalPacing={globalPacing}
      scriptWordCount={scriptWordCount}
      intermediatesPresent={intermediatesPresent}
      // Server-rendered timestamp used as the initial value of the step
      // timer clock. SSR and the first client render both read this
      // prop, so the hydrated HTML matches; `useNowTick` then snaps to
      // the real client clock after mount. See `lib/use-now-tick.ts`.
      serverNow={Date.now()}
    />
  );
}

function computeScriptWordCount(
  providedScript: string | null,
  assembledPath: string
): number | null {
  if (providedScript && providedScript.trim().length > 0) {
    return countWords(providedScript);
  }
  if (existsSync(assembledPath)) {
    return countWords(readFileSync(assembledPath, "utf-8"));
  }
  return null;
}

function countWords(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}
