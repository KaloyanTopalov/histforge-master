import { describe, it, expect, afterEach } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { createDb, seedDefaultSettings } from "@/lib/db";
import * as visualStylesRepo from "@/lib/repos/visual-styles";
import type { VisualStyle } from "@/types";

const openDbs: DatabaseType[] = [];
function freshDb(): DatabaseType {
  const db = createDb(":memory:");
  seedDefaultSettings(db);
  openDbs.push(db);
  return db;
}
afterEach(() => {
  while (openDbs.length) {
    try {
      openDbs.pop()!.close();
    } catch {
      // already closed
    }
  }
});

function makeRow(overrides: Partial<VisualStyle> = {}): VisualStyle {
  const now = 1700000000000;
  return {
    id: "vs_1",
    title: "Cinematic",
    prompt: "cinematic lighting, film grain",
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

describe("visualStylesRepo.insert + findById", () => {
  it("round-trips a row", () => {
    const db = freshDb();
    const row = makeRow();
    visualStylesRepo.insert(db, row);
    expect(visualStylesRepo.findById(db, "vs_1")).toEqual(row);
  });
});

describe("visualStylesRepo.findById", () => {
  it("returns null when the row is missing", () => {
    const db = freshDb();
    expect(visualStylesRepo.findById(db, "nope")).toBeNull();
  });
});

describe("visualStylesRepo.list", () => {
  it("orders alphabetically case-insensitively", () => {
    const db = freshDb();
    visualStylesRepo.insert(db, makeRow({ id: "a", title: "banana" }));
    visualStylesRepo.insert(db, makeRow({ id: "b", title: "Apple" }));
    visualStylesRepo.insert(db, makeRow({ id: "c", title: "cherry" }));
    const titles = visualStylesRepo.list(db).map((r) => r.title);
    expect(titles).toEqual(["Apple", "banana", "cherry"]);
  });

  it("returns [] when the table is empty", () => {
    const db = freshDb();
    expect(visualStylesRepo.list(db)).toEqual([]);
  });
});

describe("visualStylesRepo.update", () => {
  it("partial update writes only named fields and bumps updated_at", () => {
    const db = freshDb();
    visualStylesRepo.insert(
      db,
      makeRow({ id: "vs_1", title: "Old", prompt: "old prompt" })
    );
    const before = visualStylesRepo.findById(db, "vs_1")!;
    // Force a clock gap so the timestamp comparison is meaningful.
    const result = visualStylesRepo.update(db, "vs_1", { title: "New" });
    expect(result).toEqual({ updated: true });
    const after = visualStylesRepo.findById(db, "vs_1")!;
    expect(after.title).toBe("New");
    expect(after.prompt).toBe("old prompt");
    expect(after.updated_at).toBeGreaterThanOrEqual(before.updated_at);
  });

  it("no-op when no fields supplied (does not touch updated_at)", () => {
    const db = freshDb();
    visualStylesRepo.insert(db, makeRow({ id: "vs_1" }));
    const before = visualStylesRepo.findById(db, "vs_1")!;
    const result = visualStylesRepo.update(db, "vs_1", {});
    expect(result).toEqual({ updated: false });
    const after = visualStylesRepo.findById(db, "vs_1")!;
    expect(after.updated_at).toBe(before.updated_at);
  });

  it("returns { updated: false } when the row is missing", () => {
    const db = freshDb();
    const result = visualStylesRepo.update(db, "nope", { title: "X" });
    expect(result).toEqual({ updated: false });
  });
});

describe("visualStylesRepo.deleteById", () => {
  it("returns { deleted: true } when a row is removed", () => {
    const db = freshDb();
    visualStylesRepo.insert(db, makeRow({ id: "vs_1" }));
    expect(visualStylesRepo.deleteById(db, "vs_1")).toEqual({
      deleted: true,
    });
    expect(visualStylesRepo.findById(db, "vs_1")).toBeNull();
  });

  it("returns { deleted: false } when no row matched", () => {
    const db = freshDb();
    expect(visualStylesRepo.deleteById(db, "nope")).toEqual({
      deleted: false,
    });
  });
});
