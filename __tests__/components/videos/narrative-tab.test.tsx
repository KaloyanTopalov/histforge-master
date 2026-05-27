import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { VideoListItem } from "@/types";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

import { NarrativeTab } from "@/app/videos/narrative-tab";

function video(overrides: Partial<VideoListItem> = {}): VideoListItem {
  return {
    id: "v1",
    title: "Test video",
    topic_info: "info",
    workflow_id: "comfyui",
    status: "new",
    current_step: null,
    failed_step: null,
    failed_reason: null,
    started_at: null,
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
    magnific_motion_prompt: null,
    suno_style_prompt: null,
    song_count: null,
    repeat_factor: null,
    image_chunk_target_seconds: null,
    image_chunk_min_seconds: null,
    image_chunk_max_seconds: null,
    created_at: 1000,
    runtime_ms: 0,
    running_step_started_at: null,
    ...overrides,
  };
}

const WORKFLOWS = [
  {
    id: "comfyui",
    shortLabel: "ComfyUI",
    label: "ComfyUI full label",
    kind: "narrative" as const,
  },
];

const NOOP = (): void => {};

const EMPTY_BANNER_FLAGS = {
  flowCreateProjectFailed: "",
  flowServiceOverloadUntil: "",
  googleFlowReloginNeeded: false,
  flowRecoveryAccounts: [],
};

interface RenderOpts {
  topics?: VideoListItem[];
  queue?: VideoListItem[];
  finished?: VideoListItem[];
  hasNew?: boolean;
  startingAll?: boolean;
  bannerFlags?: {
    flowCreateProjectFailed: string;
    flowServiceOverloadUntil: string;
    googleFlowReloginNeeded: boolean;
    flowRecoveryAccounts: Array<{
      id: string;
      name: string;
      required_at: number;
    }>;
  };
  setBannerFlags?: (flags: Partial<RenderOpts["bannerFlags"]>) => void;
  onOpenAdd?: () => void;
  onOpenAddReadyScript?: () => void;
  onStartAll?: () => void;
}

function renderTab(opts: RenderOpts = {}): void {
  render(
    <NarrativeTab
      topics={opts.topics ?? []}
      queue={opts.queue ?? []}
      finished={opts.finished ?? []}
      workflows={WORKFLOWS}
      queueState="running"
      rowInflight={null}
      now={Date.now()}
      projectsDir="/tmp/projects"
      togglingQueue={false}
      startingAll={opts.startingAll ?? false}
      hasNew={opts.hasNew ?? false}
      bannerFlags={opts.bannerFlags ?? EMPTY_BANNER_FLAGS}
      setBannerFlags={opts.setBannerFlags ?? NOOP}
      onOpenAdd={opts.onOpenAdd ?? NOOP}
      onOpenAddReadyScript={opts.onOpenAddReadyScript ?? NOOP}
      onStartAll={opts.onStartAll ?? NOOP}
      onStartVideo={NOOP}
      onEditVideo={NOOP}
      onDelete={NOOP}
      onPause={NOOP}
      onResume={NOOP}
      onToggleQueue={NOOP}
    />,
  );
}

beforeEach(() => {
  /* no-op */
});

afterEach(() => {
  cleanup();
});

describe("NarrativeTab", () => {
  it("renders Topics, Video queue, and Finished videos headings", () => {
    renderTab();
    expect(screen.getByRole("heading", { name: /topics/i })).not.toBeNull();
    expect(
      screen.getByRole("heading", { name: /video queue/i }),
    ).not.toBeNull();
    expect(
      screen.getByRole("heading", { name: /finished videos/i }),
    ).not.toBeNull();
  });

  it("renders Add Topic and Add Ready Script buttons in the Topics section", () => {
    renderTab();
    expect(
      screen.getByRole("button", { name: /^add topic$/i }),
    ).not.toBeNull();
    expect(
      screen.getByRole("button", { name: /add ready script/i }),
    ).not.toBeNull();
  });

  it("does NOT render an Add Music Video button (music-video-only)", () => {
    renderTab();
    expect(
      screen.queryByRole("button", { name: /add music video/i }),
    ).toBeNull();
  });

  it("clicking Add Topic fires onOpenAdd", () => {
    const onOpenAdd = vi.fn();
    renderTab({ onOpenAdd });
    fireEvent.click(screen.getByRole("button", { name: /^add topic$/i }));
    expect(onOpenAdd).toHaveBeenCalledTimes(1);
  });

  it("clicking Add Ready Script fires onOpenAddReadyScript", () => {
    const onOpenAddReadyScript = vi.fn();
    renderTab({ onOpenAddReadyScript });
    fireEvent.click(
      screen.getByRole("button", { name: /add ready script/i }),
    );
    expect(onOpenAddReadyScript).toHaveBeenCalledTimes(1);
  });

  it("disables Add All to Queue when hasNew is false", () => {
    renderTab({ hasNew: false });
    const btn = screen.getByRole("button", { name: /add all to queue/i });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it("enables Add All to Queue when hasNew is true", () => {
    renderTab({ hasNew: true });
    const btn = screen.getByRole("button", { name: /add all to queue/i });
    expect((btn as HTMLButtonElement).disabled).toBe(false);
  });

  it("clicking Add All to Queue fires onStartAll", () => {
    const onStartAll = vi.fn();
    renderTab({ hasNew: true, onStartAll });
    fireEvent.click(
      screen.getByRole("button", { name: /add all to queue/i }),
    );
    expect(onStartAll).toHaveBeenCalledTimes(1);
  });

  it("renders narrative-kind rows in their respective sections", () => {
    renderTab({
      topics: [video({ id: "n-t", title: "Topic narrative", status: "new" })],
      queue: [
        video({ id: "n-q", title: "Queue narrative", status: "queued" }),
      ],
      finished: [
        video({
          id: "n-f",
          title: "Finished narrative",
          status: "done",
          finished_at: 9999,
        }),
      ],
    });
    expect(screen.getByText(/Topic narrative/)).not.toBeNull();
    expect(screen.getByText(/Queue narrative/)).not.toBeNull();
    expect(screen.getByText(/Finished narrative/)).not.toBeNull();
  });

  it("renders the Flow recovery banner when flowRecoveryAccounts is non-empty", () => {
    renderTab({
      bannerFlags: {
        ...EMPTY_BANNER_FLAGS,
        flowRecoveryAccounts: [
          { id: "acc_01", name: "Primary", required_at: 1_700_000_000 },
        ],
      },
    });
    expect(screen.getByText(/reCAPTCHA recovery required/i)).not.toBeNull();
  });

  it("renders the relogin banner when googleFlowReloginNeeded is true", () => {
    renderTab({
      bannerFlags: { ...EMPTY_BANNER_FLAGS, googleFlowReloginNeeded: true },
    });
    expect(screen.getByText(/youforge flow session expired/i)).not.toBeNull();
  });

  it("shows a paused-queue notice when queueState='paused'", () => {
    render(
      <NarrativeTab
        topics={[]}
        queue={[]}
        finished={[]}
        workflows={WORKFLOWS}
        queueState="paused"
        rowInflight={null}
        now={Date.now()}
        projectsDir="/tmp/projects"
        togglingQueue={false}
        startingAll={false}
        hasNew={false}
        bannerFlags={EMPTY_BANNER_FLAGS}
        setBannerFlags={NOOP}
        onOpenAdd={NOOP}
        onOpenAddReadyScript={NOOP}
        onStartAll={NOOP}
        onStartVideo={NOOP}
        onEditVideo={NOOP}
        onDelete={NOOP}
        onPause={NOOP}
        onResume={NOOP}
        onToggleQueue={NOOP}
      />,
    );
    expect(screen.getByText(/queue is paused/i)).not.toBeNull();
  });

  it("editing a ready-script row vs a topic row dispatches the right edit mode via onEditVideo", () => {
    const onEditVideo = vi.fn();
    const topicRow = video({ id: "t-1", title: "Topic" });
    const scriptRow = video({
      id: "s-1",
      title: "Script",
      provided_script: "some script",
    });
    render(
      <NarrativeTab
        topics={[topicRow, scriptRow]}
        queue={[]}
        finished={[]}
        workflows={WORKFLOWS}
        queueState="running"
        rowInflight={null}
        now={Date.now()}
        projectsDir="/tmp/projects"
        togglingQueue={false}
        startingAll={false}
        hasNew={false}
        bannerFlags={EMPTY_BANNER_FLAGS}
        setBannerFlags={NOOP}
        onOpenAdd={NOOP}
        onOpenAddReadyScript={NOOP}
        onStartAll={NOOP}
        onStartVideo={NOOP}
        onEditVideo={onEditVideo}
        onDelete={NOOP}
        onPause={NOOP}
        onResume={NOOP}
        onToggleQueue={NOOP}
      />,
    );
    const editButtons = screen.getAllByRole("button", { name: /edit/i });
    fireEvent.click(editButtons[0]);
    fireEvent.click(editButtons[1]);
    expect(onEditVideo).toHaveBeenCalledTimes(2);
    // The component delegates the edit mode decision to the parent — it
    // just hands back the video. Mode selection (edit vs editReadyScript)
    // lives in videos-client based on `provided_script`.
    expect(onEditVideo.mock.calls[0][0].id).toBe("t-1");
    expect(onEditVideo.mock.calls[1][0].id).toBe("s-1");
  });
});
