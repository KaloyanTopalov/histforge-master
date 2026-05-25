import { describe, it, expect } from "vitest";

describe("GET /api/health", () => {
  it("returns { ok: true }", async () => {
    const { GET } = await import("@/app/api/health/route");
    const res = await GET();
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });
});
