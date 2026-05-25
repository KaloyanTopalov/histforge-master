import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock next/navigation (npm package — legitimate boundary mock) so we can
// assert on the redirect target without Next.js's internal throw mechanism.
const redirectMock = vi.fn();
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    redirectMock(path);
  },
}));

describe("root page", () => {
  beforeEach(() => {
    redirectMock.mockClear();
  });

  it("redirects to /videos", async () => {
    const Page = (await import("@/app/page")).default;
    Page();
    expect(redirectMock).toHaveBeenCalledWith("/videos");
  });
});
