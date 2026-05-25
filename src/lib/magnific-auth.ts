import { NextResponse } from "next/server";
import type { Database as DatabaseType } from "better-sqlite3";
import { getDb } from "./db";
import { getSetting } from "./settings";

/**
 * Auth gate for the `/api/magnific/*` extension webhooks. Magnific is
 * single-account in v1 (per ADR-0012), so the URL `[token]` segment is
 * the only credential: compare it against the `magnific_token` setting
 * and bail with 404 on mismatch.
 *
 * The empty-string default (set by `DEFAULTS` in db.ts before the
 * operator opens Settings > Magnific the first time) is never a valid
 * credential — an unset token rejects every call. This stops a fresh
 * install from accepting `POST /api/magnific/next-task/` (empty path
 * segment) as if it were authenticated.
 *
 * Unlike `resolveFlowAccount`, there is no body validation here — the
 * extension's POST body is empty for next-task and is parsed by the
 * route itself for submit-result. Keeping this helper synchronous and
 * stateless lets the routes call it inline without an `await`.
 */
export interface MagnificAuthSuccess {
  ok: true;
  db: DatabaseType;
}

export interface MagnificAuthFailure {
  ok: false;
  response: NextResponse;
}

export type MagnificAuthResult = MagnificAuthSuccess | MagnificAuthFailure;

export function resolveMagnificToken(token: string): MagnificAuthResult {
  const db = getDb();
  const expected = getSetting("magnific_token", db);
  if (!expected || token !== expected) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "unknown_token" },
        { status: 404 }
      ),
    };
  }
  return { ok: true, db };
}
