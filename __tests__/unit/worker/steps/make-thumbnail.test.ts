import { describe, it, expect, afterEach, vi } from "vitest";
import { join } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import {
  runMakeThumbnail,
  step as makeThumbnailStep,
} from "@/worker/steps/make-thumbnail";
import { cleanup, tempDir } from "../../../helpers/step-fixtures";

afterEach(cleanup);

describe("make_thumbnail (music-video)", () => {
  it("exports a Step with the music_video metadata contract", () => {
    expect(makeThumbnailStep.name).toBe("make_thumbnail");
    expect(makeThumbnailStep.module).toBe("music_video");
    expect(makeThumbnailStep.inputs ?? []).toEqual(["loop_image.png"]);
    expect(makeThumbnailStep.outputs).toEqual(["thumbnail.jpg"]);
  });

  it("invokes ffmpeg with the 1920x1080 scale-and-pad args at the thumbnail.jpg path", async () => {
    const projectsDir = tempDir("make-thumb");
    const videoId = "v_thumb_01";
    // Seed the input so the existence check (added in a later cycle) doesn't
    // short-circuit. The exec is a vi.fn so no real ffmpeg runs.
    mkdirSync(join(projectsDir, videoId), { recursive: true });
    writeFileSync(join(projectsDir, videoId, "loop_image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const exec = vi.fn().mockResolvedValue(undefined);

    await runMakeThumbnail(videoId, { projectsDir, exec });

    expect(exec).toHaveBeenCalledTimes(1);
    const args = exec.mock.calls[0][0] as string[];
    expect(args).toContain("-i");
    expect(args).toContain(join(projectsDir, videoId, "loop_image.png"));
    expect(args).toContain("-vf");
    expect(args).toContain(
      "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black"
    );
    expect(args[args.length - 1]).toBe(
      join(projectsDir, videoId, "thumbnail.jpg")
    );
  });

  it("skips ffmpeg invocation when thumbnail.jpg already exists (idempotent re-entry)", async () => {
    const projectsDir = tempDir("make-thumb-skip");
    const videoId = "v_thumb_02";
    const projDir = join(projectsDir, videoId);
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, "loop_image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(join(projDir, "thumbnail.jpg"), Buffer.from([0xff, 0xd8, 0xff]));
    const exec = vi.fn().mockResolvedValue(undefined);

    await runMakeThumbnail(videoId, { projectsDir, exec });

    expect(exec).not.toHaveBeenCalled();
  });

  it("bubbles exec failures so the orchestrator can mark the step failed", async () => {
    const projectsDir = tempDir("make-thumb-fail");
    const videoId = "v_thumb_03";
    mkdirSync(join(projectsDir, videoId), { recursive: true });
    writeFileSync(join(projectsDir, videoId, "loop_image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const exec = vi
      .fn()
      .mockRejectedValue(new Error("ffmpeg exited with code=1"));

    await expect(
      runMakeThumbnail(videoId, { projectsDir, exec })
    ).rejects.toThrow(/ffmpeg/i);
  });
});
