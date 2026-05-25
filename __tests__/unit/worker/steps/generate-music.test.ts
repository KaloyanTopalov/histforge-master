import { describe, it, expect, afterEach } from "vitest";
import { step as generateMusicStep } from "@/worker/steps/generate-music";
import {
  cleanup,
  makeStepContext,
  tempDir,
} from "../../../helpers/step-fixtures";

afterEach(cleanup);

describe("generate_music (music-video stub)", () => {
  it("exports a Step with the music_video metadata contract", () => {
    expect(generateMusicStep.name).toBe("generate_music");
    expect(generateMusicStep.module).toBe("music_video");
    expect(generateMusicStep.inputs ?? []).toEqual([]);
    expect(generateMusicStep.outputs).toEqual([]);
  });

  it("resolves without error (no-op until Plan 3 wires the suno_queue)", async () => {
    const projectsDir = tempDir("gen-music");
    await expect(
      generateMusicStep.run("v_music_01", makeStepContext({ projectsDir }))
    ).resolves.toBeUndefined();
  });
});
