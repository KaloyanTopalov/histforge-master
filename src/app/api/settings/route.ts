import { NextResponse } from "next/server";
import {
  getAllSettings,
  setSetting,
  type SettingKey,
  type SettingValue,
} from "@/lib/settings";
import { getDb } from "@/lib/db";

export async function GET(): Promise<NextResponse> {
  return NextResponse.json(getAllSettings());
}

export async function PATCH(req: Request): Promise<NextResponse> {
  const body = (await req.json()) as Record<string, unknown>;
  const db = getDb();

  // Apply every update in a single transaction so a per-field schema
  // failure rolls back any changes made earlier in the PATCH — the
  // operator sees all-or-nothing semantics.
  try {
    db.transaction(() => {
      for (const [key, value] of Object.entries(body)) {
        setSetting(
          key as SettingKey,
          value as SettingValue<SettingKey>,
          db
        );
      }
    })();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "invalid_setting", message },
      { status: 400 }
    );
  }

  return NextResponse.json(getAllSettings(db));
}
