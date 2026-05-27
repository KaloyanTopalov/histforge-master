import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockStop } = vi.hoisted(() => ({ mockStop: vi.fn() }));

vi.mock("@/lib/magnific-runtime", () => ({
  magnificRuntime: { stop: mockStop },
}));

async function callStop(): Promise<Response> {
  const { POST } = await import(
    "@/app/api/magnific/runtime/stop/route"
  );
  return POST(
    new Request("http://localhost/api/magnific/runtime/stop", {
      method: "POST",
    }),
  );
}

beforeEach(() => {
  mockStop.mockReset();
});

describe("POST /api/magnific/runtime/stop", () => {
  it("calls magnificRuntime.stop() and returns {success:true} on success", async () => {
    mockStop.mockResolvedValueOnce(undefined);
    const res = await callStop();
    expect(mockStop).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
  });

  it("returns {success:false, error} with status 500 when stop() rejects", async () => {
    mockStop.mockRejectedValueOnce(new Error("teardown failed"));
    const res = await callStop();
    expect(res.status).toBe(500);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain("teardown failed");
  });
});
