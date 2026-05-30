import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import {
  mkdirSync,
  writeFileSync,
  existsSync,
  rmSync as fsRmSync,
  mkdtempSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Wrap @/lib/cleanup so test 3 can assert whether the step invoked the
// wipe at all. Tests 1+2 still observe the real wipe behavior because
// the mock delegates to the actual implementation. Hoisted by vitest.
vi.mock("@/lib/cleanup", async () => {
  const actual = await vi.importActual<typeof import("@/lib/cleanup")>(
    "@/lib/cleanup"
  );
  return {
    cleanupProjectArtifacts: vi.fn(actual.cleanupProjectArtifacts),
  };
});

let tempDir: string;
let projectsDir: string;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "histforge-cleanup-gating-"));
  process.env.DATABASE_URL = join(tempDir, "test.db");
  projectsDir = join(tempDir, "projects");
  mkdirSync(projectsDir, { recursive: true });
});

afterAll(async () => {
  const { getDb } = await import("@/lib/db");
  try {
    getDb().close();
  } catch {
    // already closed
  }
  fsRmSync(tempDir, { recursive: true, force: true });
  delete process.env.DATABASE_URL;
});

beforeEach(async () => {
  const { getDb, seedDefaultSettings } = await import("@/lib/db");
  seedDefaultSettings(getDb());
  fsRmSync(projectsDir, { recursive: true, force: true });
  mkdirSync(projectsDir, { recursive: true });
  const cleanupModule = await import("@/lib/cleanup");
  vi.mocked(cleanupModule.cleanupProjectArtifacts).mockClear();
});

function setupProject(videoId: string): string {
  const projDir = join(projectsDir, videoId);
  mkdirSync(projDir, { recursive: true });
  // KEEP set
  writeFileSync(join(projDir, "final.mp4"), "video");
  mkdirSync(join(projDir, "script"), { recursive: true });
  writeFileSync(join(projDir, "script", "full_script.md"), "script");
  writeFileSync(join(projDir, "pipeline.log"), "log");
  // Intermediates
  mkdirSync(join(projDir, "images"), { recursive: true });
  writeFileSync(join(projDir, "images", "image_001.png"), "img");
  mkdirSync(join(projDir, "audio"), { recursive: true });
  writeFileSync(join(projDir, "audio", "narration.mp3"), "audio");
  mkdirSync(join(projDir, "alignment"), { recursive: true });
  writeFileSync(join(projDir, "alignment", "alignment.json"), "[]");
  mkdirSync(join(projDir, "chunks"), { recursive: true });
  writeFileSync(join(projDir, "chunks", "chunks.json"), "[]");
  return projDir;
}

async function runStep(videoId: string): Promise<void> {
  const { step } = await import("@/worker/steps/15-cleanup");
  const { makeStepContext } = await import("../../../helpers/step-fixtures");
  await step.run(videoId, makeStepContext({ projectsDir }));
}

describe("step 15 — cleanup gating on auto_cleanup_after_render", () => {
  it("setting=false → step is a no-op (intermediates and keep set both survive)", async () => {
    const { setSetting } = await import("@/lib/settings");
    const { getDb } = await import("@/lib/db");
    setSetting("auto_cleanup_after_render", false, getDb());

    const projDir = setupProject("vid_gate_false");
    await runStep("vid_gate_false");

    // Intermediates untouched
    expect(existsSync(join(projDir, "images", "image_001.png"))).toBe(true);
    expect(existsSync(join(projDir, "audio", "narration.mp3"))).toBe(true);
    expect(existsSync(join(projDir, "alignment", "alignment.json"))).toBe(true);
    expect(existsSync(join(projDir, "chunks", "chunks.json"))).toBe(true);
    // KEEP set still present (no false-positive cleanup)
    expect(existsSync(join(projDir, "final.mp4"))).toBe(true);
    expect(existsSync(join(projDir, "pipeline.log"))).toBe(true);
    expect(existsSync(join(projDir, "script", "full_script.md"))).toBe(true);
  });

  it("setting=true → step wipes intermediates; KEEP set survives", async () => {
    const { setSetting } = await import("@/lib/settings");
    const { getDb } = await import("@/lib/db");
    setSetting("auto_cleanup_after_render", true, getDb());

    const projDir = setupProject("vid_gate_true");
    await runStep("vid_gate_true");

    // Intermediates wiped
    expect(existsSync(join(projDir, "images"))).toBe(false);
    expect(existsSync(join(projDir, "audio"))).toBe(false);
    expect(existsSync(join(projDir, "alignment"))).toBe(false);
    expect(existsSync(join(projDir, "chunks"))).toBe(false);
    // KEEP set survives
    expect(existsSync(join(projDir, "final.mp4"))).toBe(true);
    expect(existsSync(join(projDir, "pipeline.log"))).toBe(true);
    expect(existsSync(join(projDir, "script", "full_script.md"))).toBe(true);
  });

  it("ORDER pin: setting=false → step short-circuits BEFORE invoking the wipe (cleanupProjectArtifacts never called)", async () => {
    // Structural pin on the gating contract: the setting decides FIRST.
    // When false, the wipe function is never invoked — equivalent to
    // saying "no fs read/write on the project dir happens". A future
    // refactor that "reads files first, then checks setting" would
    // invoke the mock and fail this test, preventing a partial-wipe
    // regression. Mirrors Session 1's precheck-fires-before-exec
    // ordering pin.
    const { setSetting } = await import("@/lib/settings");
    const { getDb } = await import("@/lib/db");
    const cleanupModule = await import("@/lib/cleanup");
    setSetting("auto_cleanup_after_render", false, getDb());

    setupProject("vid_gate_order");
    await runStep("vid_gate_order");

    expect(
      vi.mocked(cleanupModule.cleanupProjectArtifacts)
    ).not.toHaveBeenCalled();
  });
});
