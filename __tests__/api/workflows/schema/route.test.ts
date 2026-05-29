import { describe, it, expect } from "vitest";
import { join } from "node:path";

describe("GET /api/workflows/schema", () => {
  it("returns the catalog with modules, steps, providers", async () => {
    const { GET } = await import("@/app/api/workflows/schema/route");
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.modules).toEqual([
      "script",
      "tts",
      "image",
      "video",
      "glue",
      "music_video",
    ]);
    expect(Array.isArray(body.steps)).toBe(true);
    expect(body.steps.length).toBeGreaterThan(0);
    expect(body.providers).toMatchObject({
      script: expect.any(Array),
      tts: expect.any(Array),
      image: expect.any(Array),
      video: expect.any(Array),
    });
  });

  it("each step entry has the seven documented fields and for_each is null or a literal string", async () => {
    const { GET } = await import("@/app/api/workflows/schema/route");
    const res = await GET();
    const body = await res.json();
    for (const step of body.steps) {
      expect(Object.keys(step).sort()).toEqual(
        [
          "description",
          "for_each",
          "inputs",
          "label",
          "module",
          "name",
          "produces",
        ].sort()
      );
      expect(
        step.for_each === null ||
          step.for_each === "chapters" ||
          step.for_each === "chunks"
      ).toBe(true);
      // JSON serialization drops undefined silently — guard against the
      // step file omitting `for_each` and the route forgetting `?? null`.
      expect(step.for_each).not.toBe(undefined);
    }
  });

  // Snapshot is brittle by design — it's the surface where reviewers see
  // a contract change. Stored in __snapshots__/schema.json (file snapshot,
  // not inline) so the test file stays focused and phase diffs are
  // localized.
  it("includes every entry in REAL_STEPS (catches module-typo regressions)", async () => {
    const { GET } = await import("@/app/api/workflows/schema/route");
    const { REAL_STEPS } = await import("@/worker/steps");
    const res = await GET();
    const body = await res.json();
    const returned = new Set(body.steps.map((s: { name: string }) => s.name));
    for (const step of REAL_STEPS) {
      expect(returned.has(step.name)).toBe(true);
    }
    expect(body.steps).toHaveLength(REAL_STEPS.length);
  });

  it("for_each is `chapters` for write_chapters, `chunks` for the per-chunk steps, `null` otherwise", async () => {
    const { GET } = await import("@/app/api/workflows/schema/route");
    const res = await GET();
    const body = await res.json();
    const byName = new Map(
      body.steps.map((s: { name: string; for_each: string | null }) => [
        s.name,
        s.for_each,
      ])
    );
    expect(byName.get("write_chapters")).toBe("chapters");
    const chunksScoped = [
      "generate_visual_prompts",
      "generate_images",
      "generate_clips",
    ];
    for (const name of chunksScoped) {
      expect(byName.get(name)).toBe("chunks");
    }
    const perIteration = new Set(["write_chapters", ...chunksScoped]);
    for (const [name, forEach] of byName) {
      if (!perIteration.has(name as string)) {
        expect(forEach).toBeNull();
      }
    }
  });

  it("providers.script lists every registered LLM provider", async () => {
    const { GET } = await import("@/app/api/workflows/schema/route");
    const res = await GET();
    const body = await res.json();
    expect(body.providers.script).toEqual(
      expect.arrayContaining(["openrouter", "claude_cli"])
    );
  });

  it("providers.image is derived from the image registry", async () => {
    const { GET } = await import("@/app/api/workflows/schema/route");
    const { imageProviders } = await import("@/lib/image");
    const res = await GET();
    const body = await res.json();
    expect(body.providers.image).toEqual(Object.keys(imageProviders));
  });

  it("providers.image includes magnific (matches the registered Magnific provider)", async () => {
    const { GET } = await import("@/app/api/workflows/schema/route");
    const res = await GET();
    const body = await res.json();
    expect(body.providers.image).toContain("magnific");
  });

  it("providers.video is derived from the video registry", async () => {
    const { GET } = await import("@/app/api/workflows/schema/route");
    const { videoProviders } = await import("@/lib/video");
    const res = await GET();
    const body = await res.json();
    expect(body.providers.video).toEqual(Object.keys(videoProviders));
  });

  it("exposes the supported `kinds` so the AI-skill drafts importer can author music videos too", async () => {
    const { GET } = await import("@/app/api/workflows/schema/route");
    const res = await GET();
    const body = await res.json();
    expect(body.kinds).toEqual(["narrative", "music_video"]);
  });

  it("matches the snapshot (regression guard for Phase 6 consumer)", async () => {
    const { GET } = await import("@/app/api/workflows/schema/route");
    const res = await GET();
    const body = await res.json();
    await expect(JSON.stringify(body, null, 2) + "\n").toMatchFileSnapshot(
      join(__dirname, "__snapshots__", "schema.json")
    );
  });
});
