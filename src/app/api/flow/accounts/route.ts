import { NextResponse } from "next/server";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import type { Database as DatabaseType } from "better-sqlite3";
import { getDb } from "@/lib/db";
import * as gfRepo from "@/lib/repos/google-flow";
import type { GoogleFlowAccount } from "@/types";

const CreateAccountSchema = z.object({
  name: z.string().min(1).max(64),
});

/**
 * Derive the next `acc_NN` slug from the highest existing id. Using
 * MAX+1 (rather than SEQUENCE(*) or row counts) preserves stable ids
 * across deletes — gaps are fine, reuse would confuse operators who
 * identify accounts by id in settings UI / webhook URLs.
 */
function nextAccountId(db: DatabaseType): string {
  const row = db
    .prepare(
      `SELECT COALESCE(MAX(CAST(SUBSTR(id, 5) AS INTEGER)), 0) + 1 AS next
         FROM google_flow_accounts`
    )
    .get() as { next: number };
  return `acc_${String(row.next).padStart(2, "0")}`;
}

function mintToken(): string {
  return randomBytes(24).toString("base64url");
}

function webhookUrls(origin: string, token: string): {
  pollUrl: string;
  resultUrl: string;
  statusUrl: string;
  projectUrl: string;
} {
  return {
    pollUrl: `${origin}/api/flow/next-task/${token}`,
    resultUrl: `${origin}/api/flow/submit-result/${token}`,
    statusUrl: `${origin}/api/flow/status/${token}`,
    projectUrl: `${origin}/api/flow/project/${token}`,
  };
}

function redact(account: GoogleFlowAccount): Record<string, unknown> {
  const { token, ...rest } = account;
  // Legacy `quota_used_today` column is still on the DB row at runtime;
  // strip it at the API boundary so the UI never sees a dead field.
  const out: Record<string, unknown> = { ...rest };
  delete out.quota_used_today;
  return {
    ...out,
    token_display: `…${token.slice(-4)}`,
  };
}

export async function POST(req: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }
  const parsed = CreateAccountSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_input", issues: parsed.error.issues },
      { status: 400 }
    );
  }

  const db = getDb();
  const id = nextAccountId(db);
  const token = mintToken();
  gfRepo.insertAccount(db, {
    id,
    name: parsed.data.name,
    token,
    created_at: Math.floor(Date.now() / 1000),
  });

  const origin = new URL(req.url).origin;
  return NextResponse.json(
    {
      id,
      name: parsed.data.name,
      token,
      ...webhookUrls(origin, token),
    },
    { status: 201 }
  );
}

export async function GET(): Promise<NextResponse> {
  const db = getDb();
  const accounts = gfRepo.listAccounts(db).map(redact);
  return NextResponse.json({ accounts });
}
