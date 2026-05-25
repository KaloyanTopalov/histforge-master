import { notFound } from "next/navigation";
import { join, resolve } from "node:path";
import { getDb } from "@/lib/db";
import { getSetting } from "@/lib/settings";
import { listProjectFiles } from "@/lib/project-files";
import { buildFlowSummary, type FlowSummary } from "@/lib/flow-summary";
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
      // Server-rendered timestamp used as the initial value of the step
      // timer clock. SSR and the first client render both read this
      // prop, so the hydrated HTML matches; `useNowTick` then snaps to
      // the real client clock after mount. See `lib/use-now-tick.ts`.
      serverNow={Date.now()}
    />
  );
}
