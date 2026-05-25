import { describe, it, expect } from "vitest";
import { TTS_PROVIDER_META } from "@/lib/tts/meta";

describe("TTS_PROVIDER_META", () => {
  it("exposes the AI33 metadata — consumed by ai33.ts and the settings UI", () => {
    expect(TTS_PROVIDER_META.ai33.label).toBe("AI33");
    expect(TTS_PROVIDER_META.ai33.envKey).toBe("AI33_API_KEY");
    expect(TTS_PROVIDER_META.ai33.endpoint).toBe("api.ai33.pro/v1");
  });

  it("exposes the GenAIPro metadata — consumed by genaipro.ts and the settings UI", () => {
    expect(TTS_PROVIDER_META.genaipro.label).toBe("GenAIPro");
    expect(TTS_PROVIDER_META.genaipro.envKey).toBe("GENAIPRO_API_KEY");
    expect(TTS_PROVIDER_META.genaipro.endpoint).toBe("genaipro.vn/api/v1");
  });

  it("exposes the Chatterbox metadata with empty envKey (no API key — local server)", () => {
    expect(TTS_PROVIDER_META.chatterbox.label).toBe("Chatterbox");
    expect(TTS_PROVIDER_META.chatterbox.envKey).toBe("");
    expect(TTS_PROVIDER_META.chatterbox.endpoint).toBe("127.0.0.1:8004");
  });

  it("exposes the Chatterbox-fast metadata pointing at port 8005 (parallel sidecar)", () => {
    expect(TTS_PROVIDER_META["chatterbox-fast"].label).toBe(
      "Chatterbox (fast)"
    );
    expect(TTS_PROVIDER_META["chatterbox-fast"].envKey).toBe("");
    expect(TTS_PROVIDER_META["chatterbox-fast"].endpoint).toBe(
      "127.0.0.1:8005"
    );
  });

  it("registers exactly four providers (drift guard)", () => {
    expect(Object.keys(TTS_PROVIDER_META).length).toBe(4);
  });
});
