import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ModerationEvent, Video, VideoStep } from "@/types";
import type { FlowModerationSummary } from "@/lib/flow-summary";
import { installRadixJsdomPolyfills } from "../../helpers/radix-jsdom";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

function video(overrides: Partial<Video> = {}): Video {
  return {
    id: "v1",
    title: "Test video",
    topic_info: "info",
    workflow_id: "comfyui",
    status: "in_progress",
    current_step: "research_outline",
    failed_step: null,
    failed_reason: null,
    started_at: 1000,
    finished_at: null,
    output_path: null,
    delete_requested: 0,
    paused: 0,
    deferred_until: null,
    provided_script: null,
    visual_style_id: null,
    visual_style_snapshot: null,
    kind: "narrative",
    magnific_image_prompt: null,
    suno_style_prompt: null,
    song_count: null,
    repeat_factor: null,
    created_at: 1000,
    ...overrides,
  };
}

function step(name: string, status: "pending" | "running" | "done" | "failed" = "pending"): VideoStep {
  return {
    video_id: "v1",
    step_name: name,
    status,
    started_at: status !== "pending" ? 1000 : null,
    finished_at: status === "done" ? 2000 : null,
  };
}

function mockFetchOnce(payload: unknown): void {
  (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
    new Response(JSON.stringify(payload), { status: 200 })
  );
}

const POLL_MS = 5000;

const NO_MODERATION: FlowModerationSummary = {
  max_rounds: 2,
  last_event_at: null,
  image: { round: 0, pending: 0 },
  clip: { round: 0, pending: 0 },
  events: [] as ModerationEvent[],
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function advancePoll(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(POLL_MS);
  });
}

describe("VideoDetailClient", () => {
  it("renders initial steps with status icons", async () => {
    vi.useRealTimers();

    const { VideoDetailClient } = await import(
      "@/app/videos/[id]/video-detail-client"
    );
    render(
      <VideoDetailClient
        videoId="v1"
        serverNow={Date.now()}
        initialVideo={video()}
        initialSteps={[
          step("research_outline", "done"),
          step("write_hook", "running"),
          step("write_chapters", "pending"),
        ]}
        initialArtifacts={[]}
        projectsDir="/tmp/projects"
        initialWorkflowLabel="ComfyUI label"
      />
    );

    // Done step shows checkmark
    expect(screen.getByTitle("done")).not.toBeNull();
    // Running step shows play icon
    expect(screen.getByTitle("running")).not.toBeNull();
    // Pending step shows empty circle
    expect(screen.getByTitle("pending")).not.toBeNull();

    // Step names are rendered with underscores replaced by spaces
    expect(screen.getByText("research outline")).not.toBeNull();
    expect(screen.getByText("write hook")).not.toBeNull();
    expect(screen.getByText("write chapters")).not.toBeNull();
  });

  it("polls the API and updates step statuses", async () => {
    const { VideoDetailClient } = await import(
      "@/app/videos/[id]/video-detail-client"
    );
    render(
      <VideoDetailClient
        videoId="v1"
        serverNow={Date.now()}
        initialVideo={video()}
        initialSteps={[
          step("research_outline", "done"),
          step("write_hook", "running"),
          step("write_chapters", "pending"),
        ]}
        initialArtifacts={[]}
        projectsDir="/tmp/projects"
        initialWorkflowLabel="ComfyUI label"
      />
    );

    // Initially: write_hook is running
    expect(screen.getAllByTitle("running")).toHaveLength(1);

    // Poll returns: write_hook done, write_chapters now running
    mockFetchOnce({
      video: video({ current_step: "write_chapters" }),
      steps: [
        step("research_outline", "done"),
        step("write_hook", "done"),
        step("write_chapters", "running"),
      ],
    });

    await advancePoll();

    // Now write_chapters is the running step
    expect(screen.getAllByTitle("running")).toHaveLength(1);
    expect(screen.getByTitle("running").parentElement?.textContent).toContain(
      "write chapters"
    );
    // write_hook should now be done
    expect(screen.getAllByTitle("done")).toHaveLength(2);
  });

  it("updates video status when pipeline completes", async () => {
    const { VideoDetailClient } = await import(
      "@/app/videos/[id]/video-detail-client"
    );
    render(
      <VideoDetailClient
        videoId="v1"
        serverNow={Date.now()}
        initialVideo={video({ status: "in_progress" })}
        initialSteps={[step("research_outline", "running")]}
        initialArtifacts={[]}
        projectsDir="/tmp/projects"
        initialWorkflowLabel="ComfyUI label"
      />
    );

    expect(screen.getByText(/in progress/)).not.toBeNull();

    mockFetchOnce({
      video: video({ status: "done", finished_at: 5000, output_path: "projects/v1/final.mp4" }),
      steps: [step("research_outline", "done")],
    });

    await advancePoll();

    expect(screen.getByText("done")).not.toBeNull();
    // Done videos surface the Copy Path action (VideoActions), which is
    // how the user now reaches the output folder.
    expect(screen.getByRole("button", { name: /copy path/i })).not.toBeNull();
  });

  it("updates artifacts list on poll", async () => {
    const { VideoDetailClient } = await import(
      "@/app/videos/[id]/video-detail-client"
    );
    render(
      <VideoDetailClient
        videoId="v1"
        serverNow={Date.now()}
        initialVideo={video()}
        initialSteps={[step("research_outline", "running")]}
        initialArtifacts={[]}
        projectsDir="/tmp/projects"
        initialWorkflowLabel="ComfyUI label"
      />
    );

    // Initially no artifacts
    expect(screen.getByText("No files yet.")).not.toBeNull();

    // Poll returns artifacts
    mockFetchOnce({
      video: video(),
      steps: [step("research_outline", "done")],
      artifacts: ["script/01_outline.md", "script/03_hook.md"],
      logExists: true,
    });

    await advancePoll();

    expect(screen.getByText("script/01_outline.md")).not.toBeNull();
    expect(screen.getByText("script/03_hook.md")).not.toBeNull();
    // "No files yet." should be gone
    expect(screen.queryByText("No files yet.")).toBeNull();
  });

  it("paused=1 with no running step: shows Paused badge in header", async () => {
    vi.useRealTimers();
    const { VideoDetailClient } = await import(
      "@/app/videos/[id]/video-detail-client"
    );
    render(
      <VideoDetailClient
        videoId="v1"
        serverNow={Date.now()}
        initialVideo={video({ status: "in_progress", paused: 1 })}
        initialSteps={[step("research_outline", "done")]}
        initialArtifacts={[]}
        projectsDir="/tmp/projects"
        initialWorkflowLabel="ComfyUI label"
        initialQueueState="running"
      />
    );
    expect(screen.getByText(/^paused$/i)).not.toBeNull();
    expect(screen.queryByText(/^in progress$/i)).toBeNull();
    expect(screen.queryByText(/pausing/i)).toBeNull();
  });

  it("paused=1 while a step is still running: shows Pausing… with spinner (not Paused)", async () => {
    // The worker only checks the pause flag between steps, so there is a
    // window where `paused=1` but a step is still executing. The UI must
    // surface this as a transitional state, otherwise the user sees
    // "paused" and assumes work has stopped.
    vi.useRealTimers();
    const { VideoDetailClient } = await import(
      "@/app/videos/[id]/video-detail-client"
    );
    render(
      <VideoDetailClient
        videoId="v1"
        serverNow={Date.now()}
        initialVideo={video({ status: "in_progress", paused: 1 })}
        initialSteps={[step("research_outline", "running")]}
        initialArtifacts={[]}
        projectsDir="/tmp/projects"
        initialWorkflowLabel="ComfyUI label"
        initialQueueState="running"
      />
    );
    const label = screen.getByText(/pausing/i);
    expect(label.querySelector(".animate-spin")).not.toBeNull();
    expect(screen.queryByText(/^paused$/i)).toBeNull();
  });

  it("delete_requested=1 + paused=1: header shows Deleting (delete wins over both paused and pausing)", async () => {
    vi.useRealTimers();
    const { VideoDetailClient } = await import(
      "@/app/videos/[id]/video-detail-client"
    );
    render(
      <VideoDetailClient
        videoId="v1"
        serverNow={Date.now()}
        initialVideo={video({
          status: "in_progress",
          paused: 1,
          delete_requested: 1,
        })}
        initialSteps={[step("research_outline", "running")]}
        initialArtifacts={[]}
        projectsDir="/tmp/projects"
        initialWorkflowLabel="ComfyUI label"
        initialQueueState="running"
      />
    );
    const header = screen
      .getByRole("heading", { name: /test video/i })
      .closest("header") as HTMLElement;
    expect(within(header).getAllByText(/deleting/i).length).toBeGreaterThan(0);
    expect(within(header).queryByText(/^paused$/i)).toBeNull();
    expect(within(header).queryByText(/pausing/i)).toBeNull();
  });

  it("does not render the Flow progress panel for non-Flow workflows", async () => {
    vi.useRealTimers();
    const { VideoDetailClient } = await import(
      "@/app/videos/[id]/video-detail-client"
    );
    render(
      <VideoDetailClient
        videoId="v1"
        serverNow={Date.now()}
        initialVideo={video({ workflow_id: "comfyui" })}
        initialSteps={[step("research_outline", "done")]}
        initialArtifacts={[]}
        projectsDir="/tmp/projects"
        initialWorkflowLabel="ComfyUI label"
        initialQueueState="running"
      />
    );
    expect(screen.queryByText(/flow progress/i)).toBeNull();
  });

  it("shows only the accounts strip (no chunk rows) for google-flow videos whose Flow steps haven't started", async () => {
    vi.useRealTimers();
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(async (url: string) => {
      if (url === "/api/flow/accounts") {
        return new Response(JSON.stringify({ accounts: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });
    const { VideoDetailClient } = await import(
      "@/app/videos/[id]/video-detail-client"
    );
    render(
      <VideoDetailClient
        videoId="v1"
        serverNow={Date.now()}
        initialVideo={video({ workflow_id: "google-flow" })}
        initialSteps={[
          // Earlier pipeline steps — nothing Flow-related has started.
          step("research_outline", "done"),
          step("write_chapters", "running"),
          step("generate_images", "pending"),
        ]}
        initialArtifacts={[]}
        projectsDir="/tmp/projects"
        initialWorkflowLabel="Google Flow"
        initialQueueState="running"
        usesGoogleFlow={true}
        initialFlowSummary={{
          image: { pending: 0, dispatched: 0, done: 0, failed: 0 },
          clip: { pending: 0, dispatched: 0, done: 0, failed: 0 },
          needs_review: [],
          moderation: NO_MODERATION,
        }}
      />
    );
    // Panel renders (strip is always useful) but chunk-count rows and
    // requeue buttons stay hidden until a Flow step starts.
    expect(screen.getByText(/flow progress/i)).toBeTruthy();
    expect(screen.queryByText(/^Main images$/)).toBeNull();
    expect(screen.queryByText(/^Hook videos$/)).toBeNull();
    expect(screen.queryByRole("button", { name: /^requeue failed$/i })).toBeNull();
  });

  it("renders the Flow progress panel with counts and failed reasons for google-flow videos", async () => {
    vi.useRealTimers();
    const { VideoDetailClient } = await import(
      "@/app/videos/[id]/video-detail-client"
    );
    render(
      <VideoDetailClient
        videoId="v1"
        serverNow={Date.now()}
        initialVideo={video({ workflow_id: "google-flow" })}
        initialSteps={[step("generate_images", "running")]}
        initialArtifacts={[]}
        projectsDir="/tmp/projects"
        initialWorkflowLabel="Google Flow"
        initialQueueState="running"
        usesGoogleFlow={true}
        initialFlowSummary={{
          image: { pending: 2, dispatched: 1, done: 40, failed: 1 },
          clip: { pending: 0, dispatched: 0, done: 0, failed: 0 },
          needs_review: [
            {
              id: 42,
              kind: "image",
              status: "failed",
              chunk_id: "c4",
              error_reason: "SAFETY",
              retry_count: 1,
              prompt: "p",
              moderation_round: 0,
            },
          ],
          moderation: NO_MODERATION,
        }}
      />
    );
    expect(screen.getByText(/flow progress/i)).toBeTruthy();
    // Running total: 40 done out of 44 (pending + dispatched + done + failed)
    expect(screen.getByText(/40\s*\/\s*44/)).toBeTruthy();

    // Failed rows render as always-visible cards under "Needs your review":
    // the chunk id, the kind chip, and the error reason are all on-screen
    // without an expand/collapse toggle.
    expect(screen.getByRole("heading", { name: /needs your review/i })).toBeTruthy();
    expect(screen.getByText("c4")).toBeTruthy();
    expect(screen.getByText(/SAFETY/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /edit prompt/i })).toBeTruthy();
    // The new Retry button lets the operator re-queue without editing —
    // present on every review card.
    expect(screen.getByRole("button", { name: /^retry$/i })).toBeTruthy();
  });

  it("surfaces an in-flight row that moderation has rewritten as 'Manual review available' with a Retry control", async () => {
    vi.useRealTimers();
    const { VideoDetailClient } = await import(
      "@/app/videos/[id]/video-detail-client"
    );
    render(
      <VideoDetailClient
        videoId="v1"
        serverNow={Date.now()}
        initialVideo={video({ workflow_id: "google-flow" })}
        initialSteps={[step("generate_clips", "running")]}
        initialArtifacts={[]}
        projectsDir="/tmp/projects"
        initialWorkflowLabel="Google Flow"
        initialQueueState="running"
        usesGoogleFlow={true}
        initialFlowSummary={{
          image: { pending: 0, dispatched: 0, done: 0, failed: 0 },
          // Moderation round 2 has just requeued clip_01 — pre-fix this
          // row was invisible (it's `pending`, not `failed`), leaving the
          // operator with no affordance. Now it surfaces in the review
          // card under the calmer amber header.
          clip: { pending: 1, dispatched: 0, done: 0, failed: 0 },
          needs_review: [
            {
              id: 7,
              kind: "clip",
              status: "pending",
              chunk_id: "clip_01",
              error_reason: null,
              retry_count: 2,
              prompt: "moderator rewrite v2",
              moderation_round: 2,
            },
          ],
          moderation: {
            max_rounds: 2,
            last_event_at: 200,
            image: { round: 0, pending: 0 },
            clip: { round: 2, pending: 0 },
            events: [],
          },
        }}
      />
    );
    // Amber header — no actual failure, just an auto-retry the operator
    // can take over.
    expect(
      screen.getByRole("heading", { name: /manual review available/i })
    ).toBeTruthy();
    expect(screen.queryByRole("heading", { name: /needs your review/i })).toBeNull();
    expect(screen.getByText("clip_01")).toBeTruthy();
    // Pending status: Retry is a no-op (already queued) so it disables;
    // Edit prompt remains available so the operator can override.
    const retryBtn = screen.getByRole("button", { name: /^retry$/i });
    expect((retryBtn as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("button", { name: /edit prompt/i })).toBeTruthy();
  });

  it("inline moderation indicator: per-kind, shows 'moderating N…' when pending and 'round X/M' when not, and isolates kinds via per-kind round on the server", async () => {
    vi.useRealTimers();
    const { VideoDetailClient } = await import(
      "@/app/videos/[id]/video-detail-client"
    );
    render(
      <VideoDetailClient
        videoId="v1"
        serverNow={Date.now()}
        initialVideo={video({ workflow_id: "google-flow" })}
        initialSteps={[step("generate_images", "running")]}
        initialArtifacts={[]}
        projectsDir="/tmp/projects"
        initialWorkflowLabel="Google Flow"
        initialQueueState="running"
        usesGoogleFlow={true}
        initialFlowSummary={{
          // image: 1 failed and pending moderation → "moderating 1…"
          image: { pending: 0, dispatched: 0, done: 0, failed: 1 },
          // clip: nothing failed at all → its row should show
          // nothing because the server reports per-kind round=0 for it.
          // Even though image has been moderated, clip must
          // not pick up that round number.
          clip: { pending: 0, dispatched: 0, done: 5, failed: 0 },
          needs_review: [
            {
              id: 1,
              kind: "image",
              status: "failed",
              chunk_id: "c1",
              error_reason: "PUBLIC_ERROR_DANGER_FILTER",
              retry_count: 0,
              prompt: "p",
              moderation_round: 1,
            },
          ],
          moderation: {
            max_rounds: 2,
            last_event_at: 100,
            image: { round: 1, pending: 1 },
            clip: { round: 0, pending: 0 },
            events: [],
          },
        }}
      />
    );
    // image row shows the active "moderating…" form because pending > 0.
    expect(screen.getByText(/moderating 1…/i)).toBeTruthy();
    // clip row shows neither — its per-kind round/pending are both 0,
    // proving the image moderation state did not leak across.
    expect(screen.queryByText(/moderator rewrites/i)).toBeNull();
  });

  it("inline moderation indicator: shows 'round X/M' on a kind whose pending hit 0 but round > 0, and stays hidden on the other kind even if it has unrelated failures", async () => {
    vi.useRealTimers();
    const { VideoDetailClient } = await import(
      "@/app/videos/[id]/video-detail-client"
    );
    render(
      <VideoDetailClient
        videoId="v1"
        serverNow={Date.now()}
        initialVideo={video({ workflow_id: "google-flow" })}
        initialSteps={[step("generate_images", "running")]}
        initialArtifacts={[]}
        projectsDir="/tmp/projects"
        initialWorkflowLabel="Google Flow"
        initialQueueState="running"
        usesGoogleFlow={true}
        initialFlowSummary={{
          // image: rewritten and now succeeded — round > 0, pending 0.
          image: { pending: 0, dispatched: 0, done: 1, failed: 0 },
          // clip: has failures, but they're non-CP (e.g. a quota
          // timeout) so the server reports per-kind round=0 for it.
          // The "round 1/2" indicator must NOT bleed onto this row.
          clip: { pending: 0, dispatched: 0, done: 0, failed: 1 },
          needs_review: [
            {
              id: 9,
              kind: "clip",
              status: "failed",
              chunk_id: "h1",
              error_reason: "timeout",
              retry_count: 1,
              prompt: "p",
              moderation_round: 0,
            },
          ],
          moderation: {
            max_rounds: 2,
            last_event_at: 200,
            image: { round: 1, pending: 0 },
            clip: { round: 0, pending: 0 },
            events: [],
          },
        }}
      />
    );
    // image row surfaces the completed-round indicator.
    expect(screen.getByText(/moderator rewrites: 1\/2/i)).toBeTruthy();
    // The indicator appears exactly once — proving the clip row
    // (which has unrelated failures) does not pick it up.
    expect(screen.getAllByText(/moderator rewrites/i)).toHaveLength(1);
  });

  it("renders the Flow accounts strip for google-flow videos with per-account status labels", async () => {
    vi.useRealTimers();
    const nowSec = Math.floor(Date.now() / 1000);
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(async (url: string) => {
      if (url === "/api/flow/accounts") {
        return new Response(
          JSON.stringify({
            accounts: [
              {
                id: "acc_01",
                name: "alice",
                token_display: "…Ab12",
                paused_until: null,
                last_seen_at: nowSec - 3,
                credits: 120,
                credits_updated_at: nowSec - 5,
                enabled: 1,
                recovery_reason: null,
                recovery_required_at: null,
                created_at: nowSec - 86400,
              },
              {
                id: "acc_02",
                name: "bob",
                token_display: "…Cd34",
                paused_until: nowSec + 2 * 3600,
                last_seen_at: nowSec - 10,
                credits: 118,
                credits_updated_at: nowSec - 30,
                enabled: 1,
                recovery_reason: null,
                recovery_required_at: null,
                created_at: nowSec - 86400,
              },
              {
                id: "acc_03",
                name: "carol",
                token_display: "…Ef56",
                paused_until: null,
                last_seen_at: nowSec - 20 * 60,
                credits: null,
                credits_updated_at: null,
                enabled: 1,
                recovery_reason: null,
                recovery_required_at: null,
                created_at: nowSec - 86400,
              },
            ],
          }),
          { status: 200 }
        );
      }
      if (url.startsWith("/api/flow/queue-summary/")) {
        return new Response(
          JSON.stringify({
            image: { pending: 0, dispatched: 0, done: 0, failed: 0 },
            clip: { pending: 0, dispatched: 0, done: 0, failed: 0 },
            needs_review: [],
            moderation: NO_MODERATION,
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });

    const { VideoDetailClient } = await import(
      "@/app/videos/[id]/video-detail-client"
    );
    render(
      <VideoDetailClient
        videoId="v1"
        serverNow={Date.now()}
        initialVideo={video({ workflow_id: "google-flow" })}
        initialSteps={[step("generate_images", "running")]}
        initialArtifacts={[]}
        projectsDir="/tmp/projects"
        initialWorkflowLabel="Google Flow"
        initialQueueState="running"
        usesGoogleFlow={true}
        initialFlowSummary={{
          image: { pending: 0, dispatched: 0, done: 0, failed: 0 },
          clip: { pending: 0, dispatched: 0, done: 0, failed: 0 },
          needs_review: [],
          moderation: NO_MODERATION,
        }}
      />
    );

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(await screen.findByText("alice")).toBeTruthy();
    expect(screen.getByText("bob")).toBeTruthy();
    expect(screen.getByText("carol")).toBeTruthy();
    expect(screen.getByText(/seen 3s ago/)).toBeTruthy();
    expect(screen.getByText(/paused 2h left/)).toBeTruthy();
    expect(screen.getByText(/polling stopped · last seen 20m ago/)).toBeTruthy();
    expect(screen.getByText(/\(120 credits\)/)).toBeTruthy();
    expect(screen.getByText(/\(118 credits\)/)).toBeTruthy();

    expect(
      (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.some(
        ([u]) => u === "/api/flow/accounts"
      )
    ).toBe(true);
  });

  it("does not fetch /api/flow/accounts for non-flow videos", async () => {
    vi.useRealTimers();
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200 })
    );

    const { VideoDetailClient } = await import(
      "@/app/videos/[id]/video-detail-client"
    );
    render(
      <VideoDetailClient
        videoId="v1"
        serverNow={Date.now()}
        initialVideo={video({ workflow_id: "comfyui" })}
        initialSteps={[step("research_outline", "done")]}
        initialArtifacts={[]}
        projectsDir="/tmp/projects"
        initialWorkflowLabel="ComfyUI label"
        initialQueueState="running"
      />
    );

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(
      fetchMock.mock.calls.some(([u]) => u === "/api/flow/accounts")
    ).toBe(false);
  });

  it("Requeue failed POSTs to /api/flow/requeue-failed/:videoId", async () => {
    vi.useRealTimers();
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    // Return the queue-summary shape for GETs so the poll doesn't wipe
    // flowSummary; return the requeue body for POSTs.
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return new Response(
          JSON.stringify({ ok: true, requeued: 1 }),
          { status: 200 }
        );
      }
      if (url === "/api/flow/accounts") {
        return new Response(
          JSON.stringify({ accounts: [] }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({
          image: { pending: 0, dispatched: 0, done: 0, failed: 1 },
          clip: { pending: 0, dispatched: 0, done: 0, failed: 0 },
          needs_review: [],
          moderation: NO_MODERATION,
        }),
        { status: 200 }
      );
    });
    const { VideoDetailClient } = await import(
      "@/app/videos/[id]/video-detail-client"
    );
    render(
      <VideoDetailClient
        videoId="v1"
        serverNow={Date.now()}
        initialVideo={video({ workflow_id: "google-flow" })}
        initialSteps={[step("generate_images", "failed")]}
        initialArtifacts={[]}
        projectsDir="/tmp/projects"
        initialWorkflowLabel="Google Flow"
        initialQueueState="running"
        usesGoogleFlow={true}
        initialFlowSummary={{
          image: { pending: 0, dispatched: 0, done: 0, failed: 1 },
          clip: { pending: 0, dispatched: 0, done: 0, failed: 0 },
          needs_review: [
            {
              id: 1,
              kind: "image",
              status: "failed",
              chunk_id: "c1",
              error_reason: "timeout",
              retry_count: 1,
              prompt: "p",
              moderation_round: 0,
            },
          ],
          moderation: NO_MODERATION,
        }}
      />
    );

    await act(async () => {
      (screen.getByRole("button", {
        name: /^requeue failed$/i,
      }) as HTMLButtonElement).click();
    });

    const postCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        typeof url === "string" &&
        url.startsWith("/api/flow/requeue-failed/") &&
        (init as RequestInit | undefined)?.method === "POST"
    );
    expect(postCall).toBeDefined();
    expect(postCall![0]).toBe("/api/flow/requeue-failed/v1");
  });

  it("shows retry/restart actions when video fails", async () => {
    const { VideoDetailClient } = await import(
      "@/app/videos/[id]/video-detail-client"
    );
    render(
      <VideoDetailClient
        videoId="v1"
        serverNow={Date.now()}
        initialVideo={video({ status: "in_progress" })}
        initialSteps={[step("research_outline", "running")]}
        initialArtifacts={[]}
        projectsDir="/tmp/projects"
        initialWorkflowLabel="ComfyUI label"
      />
    );

    // No action buttons initially
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();

    mockFetchOnce({
      video: video({
        status: "failed",
        failed_step: "research_outline",
        failed_reason: "API timeout",
      }),
      steps: [step("research_outline", "failed")],
    });

    await advancePoll();

    expect(screen.getByRole("button", { name: /retry failed step/i })).not.toBeNull();
    expect(screen.getByRole("button", { name: /restart from beginning/i })).not.toBeNull();
    expect(screen.getByText(/API timeout/)).not.toBeNull();
  });

  it("renders the FlowRecoveryBanner when initialFlowRecoveryAccounts is non-empty", async () => {
    vi.useRealTimers();
    const { VideoDetailClient } = await import(
      "@/app/videos/[id]/video-detail-client"
    );
    render(
      <VideoDetailClient
        videoId="v1"
        serverNow={Date.now()}
        initialVideo={video()}
        initialSteps={[step("research_outline", "done")]}
        initialArtifacts={[]}
        projectsDir="/tmp/projects"
        initialWorkflowLabel="ComfyUI label"
        initialQueueState="running"
        initialFlowRecoveryAccounts={[
          { id: "acc_01", name: "Primary", required_at: 1_700_000_000 },
        ]}
      />
    );
    expect(screen.getByText(/reCAPTCHA recovery required/i)).not.toBeNull();
    expect(screen.getByText("Primary")).not.toBeNull();
  });

  it("does NOT render the recovery banner when initialFlowRecoveryAccounts is empty", async () => {
    vi.useRealTimers();
    const { VideoDetailClient } = await import(
      "@/app/videos/[id]/video-detail-client"
    );
    render(
      <VideoDetailClient
        videoId="v1"
        serverNow={Date.now()}
        initialVideo={video()}
        initialSteps={[step("research_outline", "done")]}
        initialArtifacts={[]}
        projectsDir="/tmp/projects"
        initialWorkflowLabel="ComfyUI label"
        initialQueueState="running"
        initialFlowRecoveryAccounts={[]}
      />
    );
    expect(screen.queryByText(/reCAPTCHA recovery required/i)).toBeNull();
  });

  it("renders the FlowServiceOverloadBanner when initialFlowServiceOverloadUntil is a future timestamp", async () => {
    vi.useRealTimers();
    const { VideoDetailClient } = await import(
      "@/app/videos/[id]/video-detail-client"
    );
    const future = Math.floor(Date.now() / 1000) + 15 * 60;
    render(
      <VideoDetailClient
        videoId="v1"
        serverNow={Date.now()}
        initialVideo={video()}
        initialSteps={[step("research_outline", "done")]}
        initialArtifacts={[]}
        projectsDir="/tmp/projects"
        initialWorkflowLabel="ComfyUI label"
        initialQueueState="running"
        initialFlowServiceOverloadUntil={String(future)}
      />
    );
    expect(screen.getByText(/high backend traffic/i)).not.toBeNull();
  });

  it("mounts MagnificHitlBanner for music_video kind and renders its alert when hitl_pending is present", async () => {
    vi.useRealTimers();
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(async (url: string) => {
      if (typeof url === "string" && url.startsWith("/api/magnific/queue-summary/")) {
        return new Response(
          JSON.stringify({
            counts: {},
            hitl_pending: {
              row_id: 5,
              mode: "image-hitl",
              prompt: "renaissance fresco of cathedrals",
            },
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });

    const { VideoDetailClient } = await import(
      "@/app/videos/[id]/video-detail-client"
    );
    render(
      <VideoDetailClient
        videoId="mv1"
        serverNow={Date.now()}
        initialVideo={video({ id: "mv1", kind: "music_video" })}
        initialSteps={[step("generate_loop_image", "running")]}
        initialArtifacts={[]}
        projectsDir="/tmp/projects"
        initialWorkflowLabel="Music-video"
        initialQueueState="running"
      />
    );

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(
      await screen.findByText(/operator selection needed in magnific tab/i)
    ).toBeTruthy();
    expect(screen.getByText(/renaissance fresco of cathedrals/i)).toBeTruthy();
  });

  it("does NOT mount MagnificHitlBanner for narrative kind (no magnific queue-summary fetch)", async () => {
    vi.useRealTimers();
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200 })
    );

    const { VideoDetailClient } = await import(
      "@/app/videos/[id]/video-detail-client"
    );
    render(
      <VideoDetailClient
        videoId="v1"
        serverNow={Date.now()}
        initialVideo={video({ kind: "narrative" })}
        initialSteps={[step("research_outline", "done")]}
        initialArtifacts={[]}
        projectsDir="/tmp/projects"
        initialWorkflowLabel="ComfyUI label"
        initialQueueState="running"
      />
    );

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(
      fetchMock.mock.calls.some(
        ([u]) => typeof u === "string" && u.startsWith("/api/magnific/queue-summary/")
      )
    ).toBe(false);
  });

  it("does NOT render the service-overload banner when initialFlowServiceOverloadUntil is empty", async () => {
    vi.useRealTimers();
    const { VideoDetailClient } = await import(
      "@/app/videos/[id]/video-detail-client"
    );
    render(
      <VideoDetailClient
        videoId="v1"
        serverNow={Date.now()}
        initialVideo={video()}
        initialSteps={[step("research_outline", "done")]}
        initialArtifacts={[]}
        projectsDir="/tmp/projects"
        initialWorkflowLabel="ComfyUI label"
        initialQueueState="running"
        initialFlowServiceOverloadUntil=""
      />
    );
    expect(screen.queryByText(/high backend traffic/i)).toBeNull();
  });
});

async function renderStyleHeader(snapshot: {
  id: string;
  title: string;
  prompt: string;
} | null): Promise<void> {
  installRadixJsdomPolyfills();
  vi.useRealTimers();
  const { VideoDetailClient } = await import(
    "@/app/videos/[id]/video-detail-client"
  );
  render(
    <VideoDetailClient
      videoId="v1"
      serverNow={Date.now()}
      initialVideo={video({
        visual_style_snapshot: snapshot ? JSON.stringify(snapshot) : null,
      })}
      initialSteps={[step("research_outline", "done")]}
      initialArtifacts={[]}
      projectsDir="/tmp/projects"
      initialWorkflowLabel="ComfyUI label"
      initialQueueState="running"
    />
  );
}

describe("VideoDetailClient — Style header row", () => {
  it("renders the snapshot title in a Style row next to Workflow", async () => {
    await renderStyleHeader({
      id: "vs1",
      title: "Cinematic noir",
      prompt: "Noir prompt body",
    });
    const styleTerm = screen.getByText(/^style$/i);
    const dlEntry = styleTerm.closest("div") as HTMLElement;
    expect(within(dlEntry).getByText(/cinematic noir/i)).not.toBeNull();
  });

  it("'Show prompt' disclosure reveals the snapshot prompt text", async () => {
    await renderStyleHeader({
      id: "vs1",
      title: "Cinematic noir",
      prompt: "Noir prompt body",
    });
    expect(screen.queryByText(/noir prompt body/i)).toBeNull();
    const toggle = screen.getByRole("button", { name: /show prompt/i });
    await act(async () => {
      toggle.click();
    });
    expect(screen.getByText(/noir prompt body/i)).not.toBeNull();
  });

  it("with a NULL snapshot, renders 'Default' and no disclosure", async () => {
    await renderStyleHeader(null);
    const styleTerm = screen.getByText(/^style$/i);
    const dlEntry = styleTerm.closest("div") as HTMLElement;
    expect(within(dlEntry).getByText(/default/i)).not.toBeNull();
    expect(
      screen.queryByRole("button", { name: /show prompt/i })
    ).toBeNull();
  });
});

describe("VideoDetailClient — Re-render last step button", () => {
  const MUSIC_STEPS: VideoStep[] = [
    {
      video_id: "mv1",
      step_name: "generate_loop_image",
      status: "done",
      started_at: 100,
      finished_at: 200,
    },
    {
      video_id: "mv1",
      step_name: "generate_loop_clip",
      status: "done",
      started_at: 200,
      finished_at: 300,
    },
    {
      video_id: "mv1",
      step_name: "make_thumbnail",
      status: "done",
      started_at: 300,
      finished_at: 400,
    },
    {
      video_id: "mv1",
      step_name: "generate_music",
      status: "done",
      started_at: 400,
      finished_at: 500,
    },
    {
      video_id: "mv1",
      step_name: "download_music",
      status: "done",
      started_at: 500,
      finished_at: 600,
    },
    {
      video_id: "mv1",
      step_name: "render_music_video",
      status: "done",
      started_at: 600,
      finished_at: 700,
    },
  ];

  function musicVideoDone(): Video {
    return video({
      id: "mv1",
      kind: "music_video",
      status: "done",
      finished_at: 700,
      output_path: "projects/mv1/final.mp4",
      song_count: 6,
      repeat_factor: 4,
      workflow_id: "music-video-magnific-suno",
    });
  }

  function findRerenderButton(): HTMLButtonElement | null {
    return screen.queryByRole("button", {
      name: /re-?render/i,
    }) as HTMLButtonElement | null;
  }

  it("renders a Re-render button on the render_music_video row when the music_video is done", async () => {
    vi.useRealTimers();
    const { VideoDetailClient } = await import(
      "@/app/videos/[id]/video-detail-client"
    );
    render(
      <VideoDetailClient
        videoId="mv1"
        serverNow={Date.now()}
        initialVideo={musicVideoDone()}
        initialSteps={MUSIC_STEPS}
        initialArtifacts={[]}
        projectsDir="/tmp/projects"
        initialWorkflowLabel="Music-video"
        initialQueueState="running"
      />
    );
    const button = findRerenderButton();
    expect(button).not.toBeNull();
    // Button sits inside the render_music_video <li> — verifies it didn't
    // accidentally land in the header or on another step row.
    const renderRow = screen
      .getByText(/render music video/i)
      .closest("li") as HTMLElement;
    expect(within(renderRow).getByRole("button", { name: /re-?render/i })).toBe(
      button
    );
  });

  it("does NOT render the Re-render button while the music_video is still in progress", async () => {
    vi.useRealTimers();
    const { VideoDetailClient } = await import(
      "@/app/videos/[id]/video-detail-client"
    );
    const v = musicVideoDone();
    render(
      <VideoDetailClient
        videoId="mv1"
        serverNow={Date.now()}
        initialVideo={{ ...v, status: "in_progress", finished_at: null }}
        initialSteps={[
          ...MUSIC_STEPS.slice(0, 5),
          {
            video_id: "mv1",
            step_name: "render_music_video",
            status: "running",
            started_at: 600,
            finished_at: null,
          },
        ]}
        initialArtifacts={[]}
        projectsDir="/tmp/projects"
        initialWorkflowLabel="Music-video"
        initialQueueState="running"
      />
    );
    expect(findRerenderButton()).toBeNull();
  });

  it("does NOT render the Re-render button on a narrative video that finished", async () => {
    vi.useRealTimers();
    const { VideoDetailClient } = await import(
      "@/app/videos/[id]/video-detail-client"
    );
    render(
      <VideoDetailClient
        videoId="v1"
        serverNow={Date.now()}
        initialVideo={video({
          kind: "narrative",
          status: "done",
          finished_at: 700,
          output_path: "projects/v1/final.mp4",
        })}
        initialSteps={[step("render", "done")]}
        initialArtifacts={[]}
        projectsDir="/tmp/projects"
        initialWorkflowLabel="ComfyUI label"
        initialQueueState="running"
      />
    );
    expect(findRerenderButton()).toBeNull();
  });

  it("clicking Re-render opens a confirm dialog warning about overwriting final.mp4", async () => {
    vi.useRealTimers();
    const { VideoDetailClient } = await import(
      "@/app/videos/[id]/video-detail-client"
    );
    render(
      <VideoDetailClient
        videoId="mv1"
        serverNow={Date.now()}
        initialVideo={musicVideoDone()}
        initialSteps={MUSIC_STEPS}
        initialArtifacts={[]}
        projectsDir="/tmp/projects"
        initialWorkflowLabel="Music-video"
        initialQueueState="running"
      />
    );
    await act(async () => {
      fireEvent.click(findRerenderButton()!);
    });
    expect(screen.getByRole("alertdialog")).not.toBeNull();
    expect(screen.getByText(/final\.mp4/i)).not.toBeNull();
  });

  it("confirming the dialog POSTs /api/videos/:id/rerender-last-step", async () => {
    vi.useRealTimers();
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );
    const { VideoDetailClient } = await import(
      "@/app/videos/[id]/video-detail-client"
    );
    render(
      <VideoDetailClient
        videoId="mv1"
        serverNow={Date.now()}
        initialVideo={musicVideoDone()}
        initialSteps={MUSIC_STEPS}
        initialArtifacts={[]}
        projectsDir="/tmp/projects"
        initialWorkflowLabel="Music-video"
        initialQueueState="running"
      />
    );
    await act(async () => {
      fireEvent.click(findRerenderButton()!);
    });
    const dialog = screen.getByRole("alertdialog");
    await act(async () => {
      fireEvent.click(
        within(dialog).getByRole("button", { name: /re-?render/i })
      );
    });
    const postCall = (fetchMock.mock.calls as [string, RequestInit][]).find(
      ([url, init]) =>
        typeof url === "string" &&
        url === "/api/videos/mv1/rerender-last-step" &&
        init?.method === "POST"
    );
    expect(postCall).toBeDefined();
  });
});
