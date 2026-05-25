import { afterEach, describe, expect, it } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { createDb, seedDefaultSettings } from "@/lib/db";
import { getSetting } from "@/lib/settings";

/**
 * Character-lock + style-lock plan, Task 1.1.
 *
 * Two new operator-editable settings — `style_lock_description` and
 * `character_lock_negative` — feed the prompt-assembly post-processing
 * in step 09. This test pins two contracts that the implementation must
 * not regress:
 *
 *   1. On a fresh `:memory:` DB, the seeded defaults are the verbatim
 *      spec text. Step 09 reads them through `getSetting`, so any drift
 *      between spec and code surfaces here before it ships.
 *   2. On an "upgraded" DB that already has a settings table but is
 *      missing the new keys (i.e. a dev DB that predates this change
 *      and never re-ran `npm run db:init`), the `INSERT OR IGNORE`
 *      block inside `createDb` must seed the keys on next open.
 *      `seedDefaultSettings` only runs in `db:init`, so without the
 *      `createDb` migration `getSetting` would throw at step-09 runtime.
 *      The plan flags this as the most common footgun for this change.
 */

const STYLE_LOCK_DEFAULT =
  "2D hand-drawn animation style, plain white background, pure black line work only, no color, no shading, no gradients, no 3D rendering, no photorealism, slight hand-drawn imperfection in linework. The character must be drawn in the exact same minimalist style as the reference ingredient.";

const CHARACTER_LOCK_NEGATIVE_DEFAULT =
  "color, shading, gradient, 3D, photorealistic, vector-clean lines, multiple characters, child, cartoon mascot, anime, manga, smiling, happy expression";

const openDbs: DatabaseType[] = [];

afterEach(() => {
  while (openDbs.length) {
    const db = openDbs.pop()!;
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
});

function freshDb(): DatabaseType {
  const db = createDb(":memory:");
  seedDefaultSettings(db);
  openDbs.push(db);
  return db;
}

describe("settings: style_lock_description + character_lock_negative", () => {
  it("seeds the spec-defined default for style_lock_description on a fresh DB", () => {
    const db = freshDb();
    expect(getSetting("style_lock_description", db)).toBe(STYLE_LOCK_DEFAULT);
  });

  it("seeds the spec-defined default for character_lock_negative on a fresh DB", () => {
    const db = freshDb();
    expect(getSetting("character_lock_negative", db)).toBe(
      CHARACTER_LOCK_NEGATIVE_DEFAULT
    );
  });

  it("seeds both keys from createDb itself (not just seedDefaultSettings) so upgraded DBs backfill on next open", () => {
    // `seedDefaultSettings` runs only on `npm run db:init`. Existing dev
    // DBs are upgraded by re-opening, which goes through `createDb` and
    // *not* `seedDefaultSettings`. The plan flags this as the most
    // common footgun for this change: forgetting the `INSERT OR IGNORE`
    // statements inside `createDb`'s migration block means upgraded DBs
    // never see the new keys and `getSetting` throws at step-09 runtime.
    //
    // Test approach: call `createDb(":memory:")` directly — no
    // `seedDefaultSettings` afterwards. Anything present in the
    // settings table must have been put there by `createDb` itself.
    // Both new keys must be there.
    const db = createDb(":memory:");
    openDbs.push(db);
    expect(getSetting("style_lock_description", db)).toBe(STYLE_LOCK_DEFAULT);
    expect(getSetting("character_lock_negative", db)).toBe(
      CHARACTER_LOCK_NEGATIVE_DEFAULT
    );
  });
});
