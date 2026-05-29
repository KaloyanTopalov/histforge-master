import { describe, it, expect } from "vitest";
import type { Video } from "@/types";
import * as videoPredicates from "@/lib/lifecycle/predicates/video";

function makeVideo(overrides: Partial<Video> = {}): Video {
  return {
    id: "v1",
    title: "T",
    topic_info: "info",
    workflow_id: "comfyui",
    status: "queued",
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
    magnific_project_id: null,
    created_at: 0,
    ...overrides,
  };
}

describe("videoPredicates.isPausable", () => {
  it("true for a queued, unpaused, undeleted video", () => {
    expect(videoPredicates.isPausable(makeVideo({ status: "queued" }))).toBe(
      true
    );
  });

  it("true for an in_progress, unpaused, undeleted video", () => {
    expect(
      videoPredicates.isPausable(makeVideo({ status: "in_progress" }))
    ).toBe(true);
  });

  it("false when already paused", () => {
    expect(
      videoPredicates.isPausable(
        makeVideo({ status: "in_progress", paused: 1 })
      )
    ).toBe(false);
  });

  it("false when delete is pending", () => {
    expect(
      videoPredicates.isPausable(
        makeVideo({ status: "in_progress", delete_requested: 1 })
      )
    ).toBe(false);
  });

  it("false for terminal/draft statuses (new, done, failed)", () => {
    for (const status of ["new", "done", "failed"] as const) {
      expect(videoPredicates.isPausable(makeVideo({ status }))).toBe(false);
    }
  });
});

describe("videoPredicates.isResumable", () => {
  it("true for a paused, undeleted video", () => {
    expect(
      videoPredicates.isResumable(
        makeVideo({ status: "in_progress", paused: 1 })
      )
    ).toBe(true);
  });

  it("false when not paused", () => {
    expect(
      videoPredicates.isResumable(
        makeVideo({ status: "in_progress", paused: 0 })
      )
    ).toBe(false);
  });

  it("false when delete is pending even if paused", () => {
    expect(
      videoPredicates.isResumable(
        makeVideo({
          status: "in_progress",
          paused: 1,
          delete_requested: 1,
        })
      )
    ).toBe(false);
  });
});

describe("videoPredicates.isRetryable", () => {
  it("true for a failed video with a failed_step", () => {
    expect(
      videoPredicates.isRetryable(
        makeVideo({ status: "failed", failed_step: "voiceover" })
      )
    ).toBe(true);
  });

  it("false when the video is not failed", () => {
    expect(
      videoPredicates.isRetryable(makeVideo({ status: "in_progress" }))
    ).toBe(false);
  });

  it("false when failed_step is missing (corrupt state)", () => {
    expect(
      videoPredicates.isRetryable(
        makeVideo({ status: "failed", failed_step: null })
      )
    ).toBe(false);
  });
});

describe("videoPredicates.isRestartable", () => {
  it("true for failed", () => {
    expect(
      videoPredicates.isRestartable(makeVideo({ status: "failed" }))
    ).toBe(true);
  });

  it("true for done", () => {
    expect(videoPredicates.isRestartable(makeVideo({ status: "done" }))).toBe(
      true
    );
  });

  it("false for new, queued, in_progress", () => {
    for (const status of ["new", "queued", "in_progress"] as const) {
      expect(videoPredicates.isRestartable(makeVideo({ status }))).toBe(false);
    }
  });
});

describe("videoPredicates.isDeletable", () => {
  it("true for every status (DELETE accepts all, branches inside)", () => {
    for (const status of [
      "new",
      "queued",
      "in_progress",
      "done",
      "failed",
    ] as const) {
      expect(videoPredicates.isDeletable(makeVideo({ status }))).toBe(true);
    }
  });
});

describe("videoPredicates.isRerenderable", () => {
  it("true for a music_video that has reached done", () => {
    expect(
      videoPredicates.isRerenderable(
        makeVideo({ kind: "music_video", status: "done" })
      )
    ).toBe(true);
  });

  it("false for a narrative video, even when done", () => {
    expect(
      videoPredicates.isRerenderable(
        makeVideo({ kind: "narrative", status: "done" })
      )
    ).toBe(false);
  });

  it("false for a music_video that is not done", () => {
    for (const status of [
      "new",
      "queued",
      "in_progress",
      "failed",
    ] as const) {
      expect(
        videoPredicates.isRerenderable(
          makeVideo({ kind: "music_video", status })
        )
      ).toBe(false);
    }
  });
});
