import { describe, it, expect } from "vitest";
import type { VideoStep } from "@/types";
import {
  humanizeStepName,
  groupArtifactsByStep,
  LOGS_GROUP_KEY,
  OTHER_GROUP_KEY,
} from "@/lib/artifact-grouping";

function step(name: string): VideoStep {
  return {
    video_id: "v1",
    step_name: name,
    status: "pending",
    started_at: null,
    finished_at: null,
  };
}

describe("humanizeStepName", () => {
  it("turns generate_images into 'Generate images'", () => {
    expect(humanizeStepName("generate_images")).toBe("Generate images");
  });

  it("turns generate_clips into 'Generate clips'", () => {
    expect(humanizeStepName("generate_clips")).toBe("Generate clips");
  });
});

describe("groupArtifactsByStep", () => {
  it("returns [] for empty inputs", () => {
    expect(groupArtifactsByStep([], [])).toEqual([]);
    expect(groupArtifactsByStep([], [step("research_outline")])).toEqual([]);
  });

  it("accumulates multiple artifacts under the same step into one group", () => {
    const groups = groupArtifactsByStep(
      ["script/04_chapter_01.md", "script/04_chapter_02.md", "script/story_so_far.md"],
      [step("write_chapters")]
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]).toEqual({
      stepName: "write_chapters",
      stepIndex: 1,
      artifacts: [
        "script/04_chapter_01.md",
        "script/04_chapter_02.md",
        "script/story_so_far.md",
      ],
    });
  });

  it("pins pipeline.log to the logs group (not just *.log files)", () => {
    const groups = groupArtifactsByStep(["pipeline.log"], []);
    expect(groups).toEqual([
      { stepName: LOGS_GROUP_KEY, stepIndex: null, artifacts: ["pipeline.log"] },
    ]);
  });

  it("renders the unified humanized title regardless of provider", () => {
    // After Phase 5, both providers (comfyui / google_flow) emit the same
    // unified slug — so the humanized title is necessarily identical.
    const groups = groupArtifactsByStep(
      ["images/c1.png"],
      [step("generate_images")]
    );
    expect(humanizeStepName(groups[0].stepName)).toBe("Generate images");
  });

  it("routes a known path to the step that produced it", () => {
    const groups = groupArtifactsByStep(
      ["script/01_outline.md"],
      [step("research_outline")]
    );
    expect(groups).toEqual([
      {
        stepName: "research_outline",
        stepIndex: 1,
        artifacts: ["script/01_outline.md"],
      },
    ]);
  });

  it("places unknown paths into the OTHER group sorted after step groups", () => {
    const groups = groupArtifactsByStep(
      ["script/01_outline.md", "mystery/file.txt"],
      [step("research_outline")]
    );
    // Step group first, Other last.
    expect(groups.map((g) => g.stepName)).toEqual([
      "research_outline",
      OTHER_GROUP_KEY,
    ]);
    expect(groups[1]).toEqual({
      stepName: OTHER_GROUP_KEY,
      stepIndex: null,
      artifacts: ["mystery/file.txt"],
    });
  });

  it("pins logs into a synthetic logs group at the top", () => {
    const groups = groupArtifactsByStep(
      ["script/01_outline.md", "pipeline.log", "worker.log"],
      [step("research_outline")]
    );
    // Logs come first regardless of source order.
    expect(groups[0]).toEqual({
      stepName: LOGS_GROUP_KEY,
      stepIndex: null,
      artifacts: ["pipeline.log", "worker.log"],
    });
    expect(groups[1].stepName).toBe("research_outline");
  });

  it("routes images/* to the unified producer step", () => {
    const groups = groupArtifactsByStep(
      ["images/c1.png"],
      [step("generate_images")]
    );
    expect(groups[0].stepName).toBe("generate_images");
  });

  it("routes images/* to OTHER when no producer step is present", () => {
    const groups = groupArtifactsByStep(
      ["images/c1.png"],
      [step("research_outline")]
    );
    // Falls into the unowned bucket — no provider step claims it.
    expect(groups[groups.length - 1].stepName).toBe(OTHER_GROUP_KEY);
    expect(groups[groups.length - 1].artifacts).toEqual(["images/c1.png"]);
  });

  it("routes videos/clip/* to the unified producer step (parallel to images/)", () => {
    const groups = groupArtifactsByStep(
      ["videos/clip/c1.mp4"],
      [step("generate_clips")]
    );
    expect(groups[0].stepName).toBe("generate_clips");
  });

  it("orders step-owned groups by 1-based index from the steps array, with logs first and 'Other' last", () => {
    const groups = groupArtifactsByStep(
      [
        "render/intro.mp4",
        "script/03_hook.md",
        "mystery.bin",
        "pipeline.log",
        "script/01_outline.md",
      ],
      [
        step("research_outline"), // index 1
        step("write_hook"),       // index 2
        step("render"),           // index 3
      ]
    );
    expect(groups.map((g) => g.stepName)).toEqual([
      LOGS_GROUP_KEY,
      "research_outline",
      "write_hook",
      "render",
      OTHER_GROUP_KEY,
    ]);
    expect(groups.map((g) => g.stepIndex)).toEqual([null, 1, 2, 3, null]);
  });

  it("attributes chunks/* to the chunk step (its creator), not the step that mutates it later", () => {
    const groups = groupArtifactsByStep(
      ["chunks/chunks.json"],
      // Both chunk (creator) and moderator (mutator) are present; ownership
      // tracks the file's provenance, not who edited it last.
      [step("chunk_clips_then_images"), step("moderate_chunks")]
    );
    expect(groups[0].stepName).toBe("chunk_clips_then_images");
  });

  it("attributes final.mp4 (project root) to the render step alongside render/* outputs", () => {
    // final.mp4 is render's output but lives at the project root, not under
    // render/. The implementation handles both shapes; this pins that
    // asymmetry separately from the omnibus mappings test below.
    const groups = groupArtifactsByStep(
      ["final.mp4", "render/segment_01.mp4"],
      [step("render")]
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].stepName).toBe("render");
    expect(groups[0].artifacts.sort()).toEqual([
      "final.mp4",
      "render/segment_01.mp4",
    ]);
  });

  it("attributes the standard step → output mappings (script, audio, alignment, render)", () => {
    const groups = groupArtifactsByStep(
      [
        "script/03_hook.md",
        "script/04_chapter_01.md",
        "script/story_so_far.md",
        "script/full_script.md",
        "audio/narration.mp3",
        "alignment/alignment.json",
        "render/segment_01.mp4",
        "final.mp4",
      ],
      [
        step("write_hook"),
        step("write_chapters"),
        step("assemble_script"),
        step("voiceover"),
        step("align"),
        step("render"),
      ]
    );
    const owners = Object.fromEntries(
      groups.flatMap((g) => g.artifacts.map((a) => [a, g.stepName]))
    );
    expect(owners).toEqual({
      "script/03_hook.md": "write_hook",
      "script/04_chapter_01.md": "write_chapters",
      "script/story_so_far.md": "write_chapters",
      "script/full_script.md": "assemble_script",
      "audio/narration.mp3": "voiceover",
      "alignment/alignment.json": "align",
      "render/segment_01.mp4": "render",
      "final.mp4": "render",
    });
  });
});
