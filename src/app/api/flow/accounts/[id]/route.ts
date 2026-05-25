import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import * as gfRepo from "@/lib/repos/google-flow";
import * as flowLifecycle from "@/lib/lifecycle/flow";

interface RouteCtx {
  params: { id: string };
}

const PatchAccountSchema = z
  .object({
    name: z.string().min(1).max(64).optional(),
    enabled: z.boolean().optional(),
    // ISO8601 — or null to resume (clear paused_until).
    paused_until_iso: z.union([z.string(), z.null()]).optional(),
  })
  .refine(
    (v) =>
      v.name !== undefined ||
      v.enabled !== undefined ||
      v.paused_until_iso !== undefined,
    { message: "at least one field required" }
  );

export async function PATCH(
  req: Request,
  ctx: RouteCtx
): Promise<NextResponse> {
  const db = getDb();
  const account = gfRepo.findAccountById(db, ctx.params.id);
  if (!account) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }
  const parsed = PatchAccountSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_input", issues: parsed.error.issues },
      { status: 400 }
    );
  }

  let pausedUntil: number | null | undefined;
  if (parsed.data.paused_until_iso !== undefined) {
    if (parsed.data.paused_until_iso === null) {
      pausedUntil = null;
    } else {
      const parsedDate = Date.parse(parsed.data.paused_until_iso);
      if (Number.isNaN(parsedDate)) {
        return NextResponse.json(
          { error: "invalid_input" },
          { status: 400 }
        );
      }
      pausedUntil = Math.floor(parsedDate / 1000);
    }
  }

  flowLifecycle.editAccount(db, ctx.params.id, {
    name: parsed.data.name,
    enabled: parsed.data.enabled,
    pausedUntil,
  });

  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _req: Request,
  ctx: RouteCtx
): Promise<NextResponse> {
  const db = getDb();
  const account = gfRepo.findAccountById(db, ctx.params.id);
  if (!account) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  flowLifecycle.requeueAllOnAccountDeletion(db, ctx.params.id);

  return NextResponse.json({ ok: true });
}
