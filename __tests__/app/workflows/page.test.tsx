import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanup, render, screen, within } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

let tempDir: string;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "histforge-workflows-page-"));
  process.env.DATABASE_URL = join(tempDir, "test.db");
});

afterAll(async () => {
  const { getDb } = await import("@/lib/db");
  try {
    getDb().close();
  } catch {
    /* already closed */
  }
  rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(async () => {
  const { getDb, seedDefaultSettings, seedDefaultWorkflows } = await import(
    "@/lib/db"
  );
  const db = getDb();
  db.exec(
    "DELETE FROM video_steps; DELETE FROM videos; DELETE FROM workflow_steps; DELETE FROM workflows; DELETE FROM settings;"
  );
  seedDefaultSettings(db);
  seedDefaultWorkflows(db);
});

afterEach(() => {
  cleanup();
});

describe("WorkflowsPage", () => {
  it("renders a row for each seeded workflow with its short label and providers", async () => {
    const Page = (await import("@/app/workflows/page")).default;
    render(Page());

    const comfyuiRow = screen.getByTestId("workflow-row-comfyui");
    const text = comfyuiRow.textContent ?? "";
    // Long-form label
    expect(text).toMatch(/ComfyUI \(local images, local hook video\)/);
    // Short label rendered as its own element (the long-form label contains
    // the substring "ComfyUI", so a textContent regex isn't enough — confirm
    // there's a DOM node whose direct text is exactly "ComfyUI").
    expect(within(comfyuiRow).getByText("ComfyUI")).toBeTruthy();
    // Providers: openrouter / ai33 / comfyui / comfyui
    expect(text).toMatch(/openrouter/);
    expect(text).toMatch(/ai33/);
    // Step count = 3 (script-module steps in seed)
    expect(within(comfyuiRow).getByText("3")).toBeTruthy();

    // Both seeded workflows present
    expect(screen.getByTestId("workflow-row-google-flow")).toBeTruthy();
  });

  it("flags built-in workflows visibly", async () => {
    const Page = (await import("@/app/workflows/page")).default;
    render(Page());

    // Both seeded rows are built-ins; the page renders a "Built-in"
    // marker on each — anywhere in the card content is fine.
    const comfyuiRow = screen.getByTestId("workflow-row-comfyui");
    expect(
      within(comfyuiRow).getByText(/built-in/i)
    ).toBeTruthy();
  });

  it("flags enabled vs disabled state", async () => {
    const { getDb } = await import("@/lib/db");
    getDb()
      .prepare("UPDATE workflows SET enabled = 0 WHERE id = ?")
      .run("google-flow");

    const Page = (await import("@/app/workflows/page")).default;
    render(Page());

    const comfyuiRow = screen.getByTestId("workflow-row-comfyui");
    const googleRow = screen.getByTestId("workflow-row-google-flow");
    expect(within(comfyuiRow).getByText(/^enabled$/i)).toBeTruthy();
    expect(within(googleRow).getByText(/^disabled$/i)).toBeTruthy();
  });
});
