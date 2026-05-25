import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tempDir: string;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "histforge-drafts-discard-"));
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

function draftsDir(): string {
  return join(tempDir, "workflows", "drafts");
}

async function callDelete(filename: string) {
  const { DELETE } = await import(
    "@/app/api/workflows/drafts/[filename]/route"
  );
  return DELETE(
    new Request(`http://localhost/api/workflows/drafts/${filename}`, {
      method: "DELETE",
    }),
    { params: { filename } }
  );
}

describe("DELETE /api/workflows/drafts/[filename]", () => {
  it("removes the draft file and returns 200 { deleted: true }", async () => {
    const path = join(draftsDir(), "foo.json");
    writeFileSync(path, JSON.stringify({ id: "foo" }), "utf-8");

    const res = await callDelete("foo.json");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ deleted: true });
    expect(existsSync(path)).toBe(false);
  });

  it("returns 404 draft_not_found when the file is missing", async () => {
    const res = await callDelete("missing.json");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("draft_not_found");
  });

  it("returns 400 invalid_filename for path traversal", async () => {
    const res = await callDelete("../foo.json");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_filename");
  });

  it("returns 400 invalid_filename for wrong extension", async () => {
    const res = await callDelete("foo.txt");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_filename");
  });

  it("returns 400 invalid_filename for uppercase characters", async () => {
    const res = await callDelete("Foo.json");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_filename");
  });
});
