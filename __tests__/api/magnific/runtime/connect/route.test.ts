import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockConnect } = vi.hoisted(() => ({ mockConnect: vi.fn() }));

vi.mock("@/lib/magnific-runtime", () => ({
  magnificRuntime: { connect: mockConnect },
}));

async function callConnect(): Promise<Response> {
  const { POST } = await import(
    "@/app/api/magnific/runtime/connect/route"
  );
  return POST(
    new Request("http://localhost/api/magnific/runtime/connect", {
      method: "POST",
    }),
  );
}

beforeEach(() => {
  mockConnect.mockReset();
});

describe("POST /api/magnific/runtime/connect", () => {
  it("returns the runtime.connect() success payload verbatim", async () => {
    mockConnect.mockResolvedValueOnce({ success: true });
    const res = await callConnect();
    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
  });

  it("returns the timeout payload verbatim (still HTTP 200 — not an HTTP error)", async () => {
    mockConnect.mockResolvedValueOnce({ success: false, reason: "timeout" });
    const res = await callConnect();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: false, reason: "timeout" });
  });

  it("returns the connect_in_progress payload verbatim (re-entrant call)", async () => {
    mockConnect.mockResolvedValueOnce({
      success: false,
      reason: "connect_in_progress",
    });
    const res = await callConnect();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: false,
      reason: "connect_in_progress",
    });
  });

  it("does NOT pass a timeout argument — runtime owns the 5-minute default", async () => {
    mockConnect.mockResolvedValueOnce({ success: true });
    await callConnect();
    expect(mockConnect).toHaveBeenCalledWith();
  });
});
