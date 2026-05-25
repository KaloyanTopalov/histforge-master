import { describe, it, expect } from "vitest";
import { isAllowedMagnificHost } from "@/lib/magnific-media";

describe("isAllowedMagnificHost", () => {
  it("accepts the documented Magnific result hosts", () => {
    expect(isAllowedMagnificHost("https://cdn.cdnpk.net/output/abc.png")).toBe(
      true
    );
    expect(
      isAllowedMagnificHost("https://foo.cdnpk.net/output/abc.mp4")
    ).toBe(true);
    expect(
      isAllowedMagnificHost("https://cdn.freepikcdn.com/output/abc.png")
    ).toBe(true);
    expect(
      isAllowedMagnificHost("https://foo.freepikcdn.com/output/abc.mp4")
    ).toBe(true);
  });

  it("rejects anything outside the allowlist", () => {
    expect(isAllowedMagnificHost("http://127.0.0.1/x")).toBe(false);
    expect(isAllowedMagnificHost("http://localhost:8080/x")).toBe(false);
    expect(isAllowedMagnificHost("https://evil.example.com/x")).toBe(false);
    expect(isAllowedMagnificHost("file:///etc/passwd")).toBe(false);
    expect(isAllowedMagnificHost("https://cdnpk.net.evil.com/x")).toBe(false);
    expect(isAllowedMagnificHost("https://freepikcdn.com.evil.com/x")).toBe(
      false
    );
    expect(isAllowedMagnificHost("not a url")).toBe(false);
    expect(isAllowedMagnificHost("")).toBe(false);
  });

  it("rejects non-https schemes including data: URLs", () => {
    expect(isAllowedMagnificHost("http://x.cdnpk.net/output/x.png")).toBe(
      false
    );
    expect(isAllowedMagnificHost("data:image/png;base64,iVBORw=")).toBe(false);
  });
});
