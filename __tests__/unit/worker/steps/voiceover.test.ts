import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { step as voiceoverStep } from "@/worker/steps/06-voiceover";
import type { TtsProvider, TtsResult } from "@/lib/tts";
import {
  tempDir,
  makeStepContext,
  cleanup,
} from "../../../helpers/step-fixtures";

afterEach(cleanup);

function mockProvider(
  impl?: TtsProvider["synthesize"]
): TtsProvider {
  return {
    synthesize: vi.fn(impl ?? (async () => ({}))),
  };
}

describe("voiceover (step 6)", () => {
  it("reads script/full_script.md and calls provider.synthesize with audio/narration.mp3", async () => {
    // Step 6 is thin glue: it pipes full_script.md into the TTS provider
    // and tells it where to write the mp3. Pin the inputs/outputs so a
    // future refactor can't silently point at the wrong files.
    const projectsDir = tempDir("projects");
    const videoId = "v_test_voiceover";
    const scriptDir = join(projectsDir, videoId, "script");
    mkdirSync(scriptDir, { recursive: true });
    writeFileSync(
      join(scriptDir, "full_script.md"),
      "The full narration text."
    );

    const ttsProvider = mockProvider();

    await voiceoverStep.run(
      videoId,
      makeStepContext({ projectsDir, ttsProvider })
    );

    expect(ttsProvider.synthesize).toHaveBeenCalledOnce();
    const [text, outPath] = (ttsProvider.synthesize as ReturnType<typeof vi.fn>)
      .mock.calls[0];
    expect(text).toBe("The full narration text.");
    expect(outPath).toBe(
      join(projectsDir, videoId, "audio", "narration.mp3")
    );
  });

  it("passes a log callback that writes diagnostics to the video's pipeline.log", async () => {
    // The TTS provider uses `opts.log` to surface unusual poll events.
    // Step 6 must bind it so those messages land in the per-video
    // pipeline.log. Pin end-to-end: invoke the captured log fn, then
    // read pipeline.log and assert the line is there.
    const projectsDir = tempDir("projects");
    const videoId = "v_test_voiceover_log";
    const scriptDir = join(projectsDir, videoId, "script");
    mkdirSync(scriptDir, { recursive: true });
    writeFileSync(join(scriptDir, "full_script.md"), "hi");

    let capturedLog: ((message: string) => void) | undefined;
    const ttsProvider = mockProvider(
      async (_text, _outPath, opts) => {
        capturedLog = opts?.log;
        return {};
      }
    );

    await voiceoverStep.run(
      videoId,
      makeStepContext({ projectsDir, ttsProvider })
    );

    expect(typeof capturedLog).toBe("function");
    capturedLog!("sample diagnostic from poll loop");

    const logContents = readFileSync(
      join(projectsDir, videoId, "pipeline.log"),
      "utf-8"
    );
    expect(logContents).toContain("[voiceover]");
    expect(logContents).toContain("sample diagnostic from poll loop");
  });

  it("passes the script file content through to the provider verbatim", async () => {
    // Sanitization (em-dash normalization, etc.) is the responsibility
    // of step 05 (assemble_script). Step 06 reads full_script.md and
    // hands it to the provider untouched — anything on disk has
    // already been normalized upstream.
    const projectsDir = tempDir("projects");
    const videoId = "v_test_voiceover_verbatim";
    const scriptDir = join(projectsDir, videoId, "script");
    mkdirSync(scriptDir, { recursive: true });
    writeFileSync(
      join(scriptDir, "full_script.md"),
      "One, two, three."
    );

    const ttsProvider = mockProvider();

    await voiceoverStep.run(
      videoId,
      makeStepContext({ projectsDir, ttsProvider })
    );

    const [text] = (ttsProvider.synthesize as ReturnType<typeof vi.fn>)
      .mock.calls[0];
    expect(text).toBe("One, two, three.");
  });

  it("logs transcript paths when provider returns them in TtsResult", async () => {
    const projectsDir = tempDir("projects");
    const videoId = "v_test_voiceover_tx";
    const scriptDir = join(projectsDir, videoId, "script");
    mkdirSync(scriptDir, { recursive: true });
    writeFileSync(join(scriptDir, "full_script.md"), "hi");

    const result: TtsResult = {
      transcripts: {
        srtPath: "/tmp/audio/narration.srt",
        jsonPath: "/tmp/audio/narration.json",
      },
    };
    const ttsProvider = mockProvider(async () => result);

    await voiceoverStep.run(
      videoId,
      makeStepContext({ projectsDir, ttsProvider })
    );

    const logContents = readFileSync(
      join(projectsDir, videoId, "pipeline.log"),
      "utf-8"
    );
    expect(logContents).toContain("[voiceover]");
    expect(logContents).toContain("narration.srt");
    expect(logContents).toContain("narration.json");
  });

  it("declares the AI33 task_id sidecar as an output so orchestrator failure cleanup wipes the resume token", () => {
    // The orchestrator's failure-cleanup loop deletes only the exact paths
    // declared in `step.outputs` — it does not recursively wipe `audio/`.
    // Without the sidecar listed, a terminal AI33 error throws, the three
    // narration.* files get cleaned up, and `.tts_task_id` survives — so
    // a user-clicked Retry resumes the dead task and throws again in a loop.
    expect(voiceoverStep.outputs).toContain("audio/.tts_task_id");
  });
});
