import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tempDir: string;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "histforge-drafts-list-"));
  process.env.HISTFORGE_PROMPTS_DIR = tempDir;
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.HISTFORGE_PROMPTS_DIR;
});

beforeEach(() => {
  rmSync(draftsDir(), { recursive: true, force: true });
  mkdirSync(draftsDir(), { recursive: true });
});

const VALID_DRAFT = {
  id: "fast-narrative",
  label: "Fast narrative",
  short_label: "Fast",
  description: "Skips character research",
  script_llm_provider: "openrouter",
  tts_provider: "ai33",
  image_provider: "comfyui",
  video_provider: "comfyui",
  enabled: true,
  steps: [{ step_name: "research_outline" }, { step_name: "write_hook" }],
};

function draftsDir(): string {
  return join(tempDir, "workflows", "drafts");
}

function writeDraft(
  name: string,
  body: unknown,
  mtime?: number
): void {
  const path = join(draftsDir(), name);
  writeFileSync(
    path,
    typeof body === "string" ? body : JSON.stringify(body),
    "utf-8"
  );
  if (mtime !== undefined) {
    utimesSync(path, mtime, mtime);
  }
}

describe("GET /api/workflows/drafts", () => {
  it("returns [] when drafts directory is empty", async () => {
    const { GET } = await import("@/app/api/workflows/drafts/route");
    const res = await GET(new Request("http://localhost/api/workflows/drafts"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });

  it("lists valid drafts sorted by mtime descending", async () => {
    writeDraft("alpha.json", { ...VALID_DRAFT, id: "alpha" }, 1000);
    writeDraft("beta.json", { ...VALID_DRAFT, id: "beta" }, 2000);

    const { GET } = await import("@/app/api/workflows/drafts/route");
    const res = await GET(new Request("http://localhost/api/workflows/drafts"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(2);
    expect(body[0]).toMatchObject({
      filename: "beta.json",
      slug: "beta",
      label: "Fast narrative",
      providers: {
        script: "openrouter",
        tts: "ai33",
        image: "comfyui",
        video: "comfyui",
      },
      stepCount: 2,
      mtime: 2000,
      errors: [],
    });
    expect(body[1]).toMatchObject({
      filename: "alpha.json",
      slug: "alpha",
      mtime: 1000,
      errors: [],
    });
  });

  it("breaks mtime ties by filename ascending", async () => {
    writeDraft("zebra.json", { ...VALID_DRAFT, id: "zebra" }, 1500);
    writeDraft("alpha.json", { ...VALID_DRAFT, id: "alpha" }, 1500);
    writeDraft("mango.json", { ...VALID_DRAFT, id: "mango" }, 1500);

    const { GET } = await import("@/app/api/workflows/drafts/route");
    const res = await GET(new Request("http://localhost/api/workflows/drafts"));
    const body = await res.json();
    expect(body.map((r: { filename: string }) => r.filename)).toEqual([
      "alpha.json",
      "mango.json",
      "zebra.json",
    ]);
  });

  it("emits errors=['invalid_json'] for unparseable files", async () => {
    writeDraft("broken.json", "{ not valid json", 1000);

    const { GET } = await import("@/app/api/workflows/drafts/route");
    const res = await GET(new Request("http://localhost/api/workflows/drafts"));
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      filename: "broken.json",
      slug: null,
      label: null,
      providers: null,
      stepCount: null,
      errors: ["invalid_json"],
    });
  });

  it("emits errors=['missing_fields'] when JSON is valid but lacks id", async () => {
    const { id: _id, ...withoutId } = VALID_DRAFT;
    writeDraft("noslug.json", withoutId, 1000);

    const { GET } = await import("@/app/api/workflows/drafts/route");
    const res = await GET(new Request("http://localhost/api/workflows/drafts"));
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      filename: "noslug.json",
      slug: null,
      errors: ["missing_fields"],
    });
  });

  for (const key of [
    "is_builtin",
    "version",
    "created_at",
    "updated_at",
  ] as const) {
    it(`flags unknown_field when a draft includes server-controlled key '${key}'`, async () => {
      writeDraft(
        "advisory.json",
        { ...VALID_DRAFT, id: "advisory", [key]: "anything" },
        1000
      );

      const { GET } = await import("@/app/api/workflows/drafts/route");
      const res = await GET(
        new Request("http://localhost/api/workflows/drafts")
      );
      const body = await res.json();
      expect(body).toHaveLength(1);
      expect(body[0].errors).toContain("unknown_field");
      expect(body[0].slug).toBe("advisory");
    });
  }

  it("accumulates missing_fields and unknown_field together (missing_fields first)", async () => {
    const { id: _id, ...withoutId } = VALID_DRAFT;
    writeDraft(
      "combo.json",
      { ...withoutId, is_builtin: 1 },
      1000
    );

    const { GET } = await import("@/app/api/workflows/drafts/route");
    const res = await GET(new Request("http://localhost/api/workflows/drafts"));
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].errors).toEqual(["missing_fields", "unknown_field"]);
  });

  it("silently excludes files that fail the basename regex", async () => {
    writeDraft("good.json", { ...VALID_DRAFT, id: "good" }, 1000);
    // Files that don't match /^[a-z0-9-]+\.json$/
    writeDraft("not-a-slug.json.bak", "garbage", 1000);
    writeDraft("Foo.json", "garbage", 1000);
    writeDraft("under_score.json", "garbage", 1000);

    const { GET } = await import("@/app/api/workflows/drafts/route");
    const res = await GET(new Request("http://localhost/api/workflows/drafts"));
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].filename).toBe("good.json");
  });

  it("surfaces chunker_step from the draft JSON when present", async () => {
    writeDraft(
      "with-chunker.json",
      { ...VALID_DRAFT, id: "with-chunker", chunker_step: "chunk_images_only" },
      1000
    );

    const { GET } = await import("@/app/api/workflows/drafts/route");
    const res = await GET(new Request("http://localhost/api/workflows/drafts"));
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].chunker_step).toBe("chunk_images_only");
  });

  it("returns chunker_step: null when the draft JSON omits the field", async () => {
    writeDraft(
      "no-chunker.json",
      { ...VALID_DRAFT, id: "no-chunker" },
      1000
    );

    const { GET } = await import("@/app/api/workflows/drafts/route");
    const res = await GET(new Request("http://localhost/api/workflows/drafts"));
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].chunker_step).toBeNull();
  });

  it("returns chunker_step: null when the field is present but not a string", async () => {
    writeDraft(
      "bad-chunker.json",
      { ...VALID_DRAFT, id: "bad-chunker", chunker_step: 42 },
      1000
    );

    const { GET } = await import("@/app/api/workflows/drafts/route");
    const res = await GET(new Request("http://localhost/api/workflows/drafts"));
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].chunker_step).toBeNull();
  });

  it("creates the drafts directory lazily if missing", async () => {
    rmSync(draftsDir(), { recursive: true, force: true });
    // also remove parent so ensureDraftsDirs has to recreate
    rmSync(join(tempDir, "workflows"), { recursive: true, force: true });

    const { GET } = await import("@/app/api/workflows/drafts/route");
    const res = await GET(new Request("http://localhost/api/workflows/drafts"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });
});
