import { describe, it, expect } from "vitest";
import { loadClassicScript } from "../../helpers/load-classic-script";

type ClientContextModule = {
  buildClientContext: (input?: {
    projectId?: string;
    recaptchaToken?: string;
    sessionId?: string;
    paygateTier?: string;
  }) => Record<string, unknown>;
};

const { buildClientContext } = loadClassicScript<ClientContextModule>(
  "extensions/youforge-flow/src/client-context.js",
);

describe("buildClientContext", () => {
  it("produces minimal upload-image shape with projectId only", () => {
    expect(buildClientContext({ projectId: "proj-123" })).toEqual({
      projectId: "proj-123",
      tool: "PINHOLE",
    });
  });

  it("produces image-gen shape with recaptcha token and sessionId, no paygate", () => {
    expect(
      buildClientContext({
        projectId: "proj-123",
        recaptchaToken: "rc-abc",
        sessionId: "sess-xyz",
      }),
    ).toEqual({
      projectId: "proj-123",
      tool: "PINHOLE",
      recaptchaContext: {
        token: "rc-abc",
        applicationType: "RECAPTCHA_APPLICATION_TYPE_WEB",
      },
      sessionId: "sess-xyz",
    });
  });

  it("produces full video-gen shape with paygate tier", () => {
    expect(
      buildClientContext({
        projectId: "proj-123",
        recaptchaToken: "rc-abc",
        sessionId: "sess-xyz",
        paygateTier: "PAYGATE_TIER_ULTRA",
      }),
    ).toEqual({
      projectId: "proj-123",
      tool: "PINHOLE",
      recaptchaContext: {
        token: "rc-abc",
        applicationType: "RECAPTCHA_APPLICATION_TYPE_WEB",
      },
      sessionId: "sess-xyz",
      userPaygateTier: "PAYGATE_TIER_ULTRA",
    });
  });

  it("omits optional fields when their inputs are falsy", () => {
    expect(
      buildClientContext({
        projectId: "proj-123",
        recaptchaToken: "",
        sessionId: undefined,
        paygateTier: null as unknown as string,
      }),
    ).toEqual({ projectId: "proj-123", tool: "PINHOLE" });
  });
});
