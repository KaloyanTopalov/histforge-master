import { describe, it, expect, afterEach } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { createDb } from "@/lib/db";
import {
  computeVisualStyleSnapshot,
  parseVisualStyleSnapshot,
} from "@/lib/visual-styles";

const openDbs: DatabaseType[] = [];
function freshDb(): DatabaseType {
  const db = createDb(":memory:");
  openDbs.push(db);
  return db;
}
afterEach(() => {
  while (openDbs.length) {
    try {
      openDbs.pop()!.close();
    } catch {
      /* ignore */
    }
  }
});

function seedStyle(
  db: DatabaseType,
  id: string,
  title: string,
  prompt: string
): void {
  const now = Date.now();
  db.prepare(
    "INSERT INTO visual_styles (id, title, prompt, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
  ).run(id, title, prompt, now, now);
}

describe("computeVisualStyleSnapshot", () => {
  it("returns null for a null id (the documented 'no style' shape)", () => {
    const db = freshDb();
    expect(computeVisualStyleSnapshot(db, null)).toBeNull();
  });

  it("returns null when the referenced row is missing (decision 13)", () => {
    const db = freshDb();
    expect(computeVisualStyleSnapshot(db, "ghost")).toBeNull();
  });

  it("returns a JSON string with {id,title,prompt} (no timestamps) for an existing row", () => {
    const db = freshDb();
    seedStyle(db, "vs1", "Cinematic noir", "noir style prompt");
    const json = computeVisualStyleSnapshot(db, "vs1");
    expect(json).not.toBeNull();
    const parsed = JSON.parse(json!);
    expect(parsed).toEqual({
      id: "vs1",
      title: "Cinematic noir",
      prompt: "noir style prompt",
    });
    // Timestamps intentionally omitted — snapshot freezes content, not
    // the gallery row's lifecycle.
    expect(parsed.created_at).toBeUndefined();
    expect(parsed.updated_at).toBeUndefined();
  });
});

describe("parseVisualStyleSnapshot", () => {
  it("returns null for a null input (the documented 'no style' branch)", () => {
    expect(parseVisualStyleSnapshot(null)).toBeNull();
  });

  it("returns null for an undefined input (caller-side optional chaining)", () => {
    expect(parseVisualStyleSnapshot(undefined)).toBeNull();
  });

  it("returns the parsed snapshot for a JSON-encoded snapshot string", () => {
    const json = JSON.stringify({
      id: "vs1",
      title: "Cinematic noir",
      prompt: "noir style prompt",
    });
    expect(parseVisualStyleSnapshot(json)).toEqual({
      id: "vs1",
      title: "Cinematic noir",
      prompt: "noir style prompt",
    });
  });

  it("round-trips with computeVisualStyleSnapshot", () => {
    const db = freshDb();
    seedStyle(db, "vs1", "Cinematic noir", "noir style prompt");
    const json = computeVisualStyleSnapshot(db, "vs1");
    expect(parseVisualStyleSnapshot(json)).toEqual({
      id: "vs1",
      title: "Cinematic noir",
      prompt: "noir style prompt",
    });
  });
});
