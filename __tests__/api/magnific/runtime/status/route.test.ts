import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockStatus } = vi.hoisted(() => ({ mockStatus: vi.fn() }));

vi.mock("@/lib/magnific-runtime", () => ({
  magnificRuntime: { status: mockStatus },
}));

async function callStatus(): Promise<Response> {
  const { GET } = await import(
    "@/app/api/magnific/runtime/status/route"
  );
  return GET(
    new Request("http://localhost/api/magnific/runtime/status"),
  );
}

beforeEach(() => {
  mockStatus.mockReset();
});

describe("GET /api/magnific/runtime/status", () => {
  it("returns the stopped state payload verbatim", async () => {
    const payload = {
      running: false,
      connected: false,
      session_valid: false,
      last_error: null,
    };
    mockStatus.mockResolvedValueOnce(payload);
    const res = await callStatus();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(payload);
  });

  it("returns the running+connected state payload verbatim", async () => {
    const payload = {
      running: true,
      connected: true,
      session_valid: true,
      last_error: null,
    };
    mockStatus.mockResolvedValueOnce(payload);
    const res = await callStatus();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(payload);
  });

  it("returns the running-but-userDataDir-missing payload verbatim", async () => {
    const payload = {
      running: true,
      connected: false,
      session_valid: true,
      last_error: null,
    };
    mockStatus.mockResolvedValueOnce(payload);
    expect(await (await callStatus()).json()).toEqual(payload);
  });

  it("returns the session-expired payload (last_error included) verbatim", async () => {
    const payload = {
      running: true,
      connected: true,
      session_valid: false,
      last_error: "auth check 401",
    };
    mockStatus.mockResolvedValueOnce(payload);
    expect(await (await callStatus()).json()).toEqual(payload);
  });
});
