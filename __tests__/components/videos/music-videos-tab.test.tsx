import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { VideoListItem } from "@/types";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

import { MusicVideosTab } from "@/app/videos/music-videos-tab";

function video(overrides: Partial<VideoListItem> = {}): VideoListItem {
  return {
    id: "mv1",
    title: "Test music video",
    topic_info: "",
    workflow_id: "music-video-magnific-suno",
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
    kind: "music_video",
    magnific_image_prompt: "prompt",
    magnific_motion_prompt: null,
    suno_style_prompt: "style",
    song_count: 3,
    repeat_factor: 2,
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
    id: "music-video-magnific-suno",
    shortLabel: "Magnific × Suno",
    label: "Music video (Magnific × Suno)",
    kind: "music_video" as const,
  },
];

const NOOP = (): void => {};

interface RenderOpts {
  topics?: VideoListItem[];
  queue?: VideoListItem[];
  finished?: VideoListItem[];
  onOpenAdd?: () => void;
}

function renderTab(opts: RenderOpts = {}): void {
  render(
    <MusicVideosTab
      topics={opts.topics ?? []}
      queue={opts.queue ?? []}
      finished={opts.finished ?? []}
      workflows={WORKFLOWS}
      queueState="running"
      rowInflight={null}
      now={Date.now()}
      projectsDir="/tmp/projects"
      togglingQueue={false}
      onOpenAdd={opts.onOpenAdd ?? NOOP}
      onStartVideo={NOOP}
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

describe("MusicVideosTab", () => {
  it("renders Topics, Video queue, and Finished videos headings", () => {
    renderTab();
    expect(screen.getByRole("heading", { name: /topics/i })).not.toBeNull();
    expect(screen.getByRole("heading", { name: /video queue/i })).not.toBeNull();
    expect(screen.getByRole("heading", { name: /finished videos/i })).not.toBeNull();
  });

  it("renders an Add Music Video button in the Topics section", () => {
    renderTab();
    expect(
      screen.getByRole("button", { name: /add music video/i }),
    ).not.toBeNull();
  });

  it("does NOT render the Add Topic or Add Ready Script buttons (narrative-only)", () => {
    renderTab();
    expect(screen.queryByRole("button", { name: /^add topic$/i })).toBeNull();
    expect(
      screen.queryByRole("button", { name: /add ready script/i }),
    ).toBeNull();
  });

  it("clicking Add Music Video fires onOpenAdd", () => {
    const onOpenAdd = vi.fn();
    renderTab({ onOpenAdd });
    fireEvent.click(
      screen.getByRole("button", { name: /add music video/i }),
    );
    expect(onOpenAdd).toHaveBeenCalledTimes(1);
  });

  it("renders music-video rows in their respective sections", () => {
    renderTab({
      topics: [video({ id: "mv-t", title: "Topic MV", status: "new" })],
      queue: [video({ id: "mv-q", title: "Queue MV", status: "queued" })],
      finished: [
        video({
          id: "mv-f",
          title: "Finished MV",
          status: "done",
          finished_at: 9999,
        }),
      ],
    });
    expect(screen.getByText(/Topic MV/)).not.toBeNull();
    expect(screen.getByText(/Queue MV/)).not.toBeNull();
    expect(screen.getByText(/Finished MV/)).not.toBeNull();
  });

  it("shows a paused-queue notice when queueState='paused'", () => {
    render(
      <MusicVideosTab
        topics={[]}
        queue={[]}
        finished={[]}
        workflows={WORKFLOWS}
        queueState="paused"
        rowInflight={null}
        now={Date.now()}
        projectsDir="/tmp/projects"
        togglingQueue={false}
        onOpenAdd={NOOP}
        onStartVideo={NOOP}
        onDelete={NOOP}
        onPause={NOOP}
        onResume={NOOP}
        onToggleQueue={NOOP}
      />,
    );
    expect(screen.getByText(/queue is paused/i)).not.toBeNull();
  });
});
