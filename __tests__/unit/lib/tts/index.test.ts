import { describe, it, expect } from "vitest";
import { getTtsProvider } from "@/lib/tts";

describe("getTtsProvider", () => {
  it('returns a TtsProvider for "ai33"', () => {
    const provider = getTtsProvider("ai33");
    expect(provider).toBeDefined();
    expect(typeof provider.synthesize).toBe("function");
  });

  it('returns a TtsProvider for "genaipro"', () => {
    const provider = getTtsProvider("genaipro");
    expect(provider).toBeDefined();
    expect(typeof provider.synthesize).toBe("function");
  });

  it('returns a TtsProvider for "chatterbox"', () => {
    const provider = getTtsProvider("chatterbox");
    expect(provider).toBeDefined();
    expect(typeof provider.synthesize).toBe("function");
  });

  it('returns a TtsProvider for "chatterbox-fast"', () => {
    const provider = getTtsProvider("chatterbox-fast");
    expect(provider).toBeDefined();
    expect(typeof provider.synthesize).toBe("function");
  });

  it("throws on unknown provider name", () => {
    expect(() => getTtsProvider("nope")).toThrow(/Unknown TTS provider: "nope"/);
  });
});
