import { NextResponse } from "next/server";
import type { Database as DatabaseType } from "better-sqlite3";
import type { z } from "zod";
import { getDb } from "./db";
import * as gfRepo from "./repos/google-flow";
import type { GoogleFlowAccount } from "@/types";

/**
 * Unified auth + validation gate for Google Flow extension webhooks
 * (`next-task`, `submit-result`, `status`). Centralising here makes
 * the token-match logic and the `last_seen_at` liveness signal
 * impossible to drift between routes.
 *
 * Steps, in order:
 *   1. JSON parse          → 400 on malformed body
 *   2. Zod validation      → 400 on schema failure
 *   3. URL token vs body accountToken → 401 on mismatch
 *   4. Account lookup by token        → 404 on unknown
 *   5. Always bump last_seen_at — this is the account's liveness
 *      signal and fires even when we'll return 403 disabled, so
 *      the dashboard still shows the extension as alive.
 *   6. Optional `enabled` gate → 403 when the caller opts in and
 *      the row has enabled=0.
 *
 * Callers handle `ok === false` by returning `result.response`
 * directly; on success, they receive the parsed body, the account
 * row, and a shared `db`/`now` so they don't have to re-derive.
 */
export interface FlowAuthSuccess<T> {
  ok: true;
  account: GoogleFlowAccount;
  parsed: T;
  db: DatabaseType;
  now: number;
}

export interface FlowAuthFailure {
  ok: false;
  response: NextResponse;
}

export type FlowAuthResult<T> = FlowAuthSuccess<T> | FlowAuthFailure;

interface TokenContext {
  params: { token: string };
}

export async function resolveFlowAccount<T extends { accountToken: string }>(
  req: Request,
  ctx: TokenContext,
  schema: z.ZodType<T>,
  opts?: { requireEnabled?: boolean }
): Promise<FlowAuthResult<T>> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "invalid_input" },
        { status: 400 }
      ),
    };
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "invalid_input", issues: parsed.error.issues },
        { status: 400 }
      ),
    };
  }

  if (parsed.data.accountToken !== ctx.params.token) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "token_mismatch" },
        { status: 401 }
      ),
    };
  }

  const db = getDb();
  const account = gfRepo.findAccountByToken(db, ctx.params.token);
  if (!account) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "unknown_token" },
        { status: 404 }
      ),
    };
  }

  const now = Math.floor(Date.now() / 1000);
  gfRepo.updateAccountLastSeen(db, account.id, now);

  if (opts?.requireEnabled && account.enabled === 0) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "account_disabled" },
        { status: 403 }
      ),
    };
  }

  return { ok: true, account, parsed: parsed.data, db, now };
}
