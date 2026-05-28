import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockStart } = vi.hoisted(() => ({ mockStart: vi.fn() }));

vi.mock("@/lib/magnific-runtime", () => ({
  magnificRuntime: { start: mockStart },
}));

async function callStart(): Promise<Response> {
  const { POST } = await import(
    "@/app/api/magnific/runtime/start/route"
  );
  return POST(
    new Request("http://localhost/api/magnific/runtime/start", {
      method: "POST",
    }),
  );
}

beforeEach(() => {
  mockStart.mockReset();
});

describe("POST /api/magnific/runtime/start", () => {
  it("calls magnificRuntime.start() and returns {success:true} on success", async () => {
    mockStart.mockResolvedValueOnce(undefined);
    const res = await callStart();
    expect(mockStart).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
  });

  it("returns {success:false, error} with status 500 when start() rejects", async () => {
    mockStart.mockRejectedValueOnce(new Error("Chromium not installed"));
    const res = await callStart();
    expect(res.status).toBe(500);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain("Chromium not installed");
  });
});
