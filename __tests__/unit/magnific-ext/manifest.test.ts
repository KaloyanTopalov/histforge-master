import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const EXT_ROOT = path.resolve(process.cwd(), "extensions/magnific-ext");

function readManifest(): Record<string, unknown> {
  const src = readFileSync(path.join(EXT_ROOT, "manifest.json"), "utf8");
  return JSON.parse(src) as Record<string, unknown>;
}

describe("magnific-ext manifest", () => {
  it("is MV3", () => {
    const m = readManifest();
    expect(m.manifest_version).toBe(3);
  });

  it("declares the required runtime permissions", () => {
    const m = readManifest();
    const perms = m.permissions as string[];
    // storage: settings cache. alarms: poll loop. tabs/scripting: open and
    // drive Magnific page in Phase 2.3+. notifications: surface session
    // failures (optional but ported from youforge-flow for parity).
    for (const p of ["storage", "alarms", "tabs", "scripting", "notifications"]) {
      expect(perms).toContain(p);
    }
  });

  it("scopes host_permissions to www.magnific.com (no broad <all_urls> in main)", () => {
    const m = readManifest();
    const hosts = m.host_permissions as string[];
    expect(hosts.some((h) => h.includes("www.magnific.com"))).toBe(true);
    expect(hosts).not.toContain("<all_urls>");
  });

  it("declares <all_urls> as optional for the HistForge origin grant", () => {
    const m = readManifest();
    const optional = m.optional_host_permissions as string[];
    expect(optional).toContain("<all_urls>");
  });

  it("references background.js as the service worker", () => {
    const m = readManifest();
    const bg = m.background as { service_worker: string };
    expect(bg.service_worker).toBe("background.js");
  });

  it("ships an action + icons", () => {
    const m = readManifest();
    const icons = m.icons as Record<string, string>;
    expect(icons["16"]).toMatch(/\.png$/);
    expect(icons["48"]).toMatch(/\.png$/);
    expect(icons["128"]).toMatch(/\.png$/);
    for (const key of ["16", "48", "128"] as const) {
      expect(existsSync(path.join(EXT_ROOT, icons[key]))).toBe(true);
    }
  });

  it("declares a content_script for the Magnific image-gen page (Phase 2.3)", () => {
    const m = readManifest();
    const scripts = (m.content_scripts ?? []) as Array<{
      matches: string[];
      js: string[];
    }>;
    expect(scripts.length).toBeGreaterThan(0);
    const magnificScript = scripts.find((s) =>
      s.matches.some((p) => p.includes("www.magnific.com")),
    );
    expect(magnificScript).toBeDefined();
    expect(magnificScript?.js).toContain("content-magnific.js");
    // The script file must exist on disk so the unpacked load doesn't 404
    expect(
      existsSync(path.join(EXT_ROOT, "content-magnific.js")),
    ).toBe(true);
  });

  it("declares a content_script entry that injects content-magnific-i2v.js on www.magnific.com (Phase 2.4)", () => {
    const m = readManifest();
    const scripts = (m.content_scripts ?? []) as Array<{
      matches: string[];
      js: string[];
    }>;
    const magnificMatching = scripts.filter((s) =>
      s.matches.some((p) => p.includes("www.magnific.com")),
    );
    const injectsI2V = magnificMatching.some((s) =>
      s.js.includes("content-magnific-i2v.js"),
    );
    expect(injectsI2V).toBe(true);
    expect(
      existsSync(path.join(EXT_ROOT, "content-magnific-i2v.js")),
    ).toBe(true);
  });

  it("declares a content_script entry that injects content-image-batch.js on www.magnific.com (S4)", () => {
    const m = readManifest();
    const scripts = (m.content_scripts ?? []) as Array<{
      matches: string[];
      js: string[];
    }>;
    const magnificMatching = scripts.filter((s) =>
      s.matches.some((p) => p.includes("www.magnific.com")),
    );
    const injectsBatch = magnificMatching.some((s) =>
      s.js.includes("content-image-batch.js"),
    );
    expect(injectsBatch).toBe(true);
    expect(
      existsSync(path.join(EXT_ROOT, "content-image-batch.js")),
    ).toBe(true);
    // content-shared.js must still load first so editableFrom/fillPrompt are
    // defined as isolated-world globals before any orchestrator runs.
    const sharedScript = magnificMatching.find((s) =>
      s.js.includes("content-image-batch.js"),
    );
    expect(sharedScript?.js[0]).toBe("content-shared.js");
  });
});

describe("magnific-ext background.js importScripts order", () => {
  it("loads logger, settings-schema, settings, state, runner, messages in dependency order", () => {
    const src = readFileSync(path.join(EXT_ROOT, "background.js"), "utf8");
    const imports = [...src.matchAll(/importScripts\(['"]([^'"]+)['"]\)/g)].map(
      (m) => m[1],
    );
    // Use bare basename to avoid "settings.js" matching "settings-schema.js".
    const idx = (file: string): number =>
      imports.findIndex((s) => s.endsWith(`/${file}`) || s === file);
    // logger must come first so every downstream module can call safeLog
    expect(idx("logger.js")).toBeGreaterThanOrEqual(0);
    expect(idx("logger.js")).toBeLessThan(idx("http.js"));
    // settings-schema must precede settings (closure refs)
    expect(idx("settings-schema.js")).toBeLessThan(idx("settings.js"));
    // settings precedes state, both precede runner; runner precedes messages
    expect(idx("settings.js")).toBeLessThan(idx("state.js"));
    expect(idx("state.js")).toBeLessThan(idx("runner.js"));
    expect(idx("runner.js")).toBeLessThan(idx("messages.js"));
    // host-permission precedes runner (runner's stopPolling forward-ref is
    // resolved at call time; loading earlier is the conservative choice
    // matching youforge-flow's layout)
    expect(idx("host-permission.js")).toBeLessThan(idx("runner.js"));
  });

  it("loads the executor registry + image-hitl executor before messages.js (so notifyVariationSelected resolves)", () => {
    const src = readFileSync(path.join(EXT_ROOT, "background.js"), "utf8");
    const imports = [...src.matchAll(/importScripts\(['"]([^'"]+)['"]\)/g)].map(
      (m) => m[1],
    );
    const idx = (file: string): number =>
      imports.findIndex((s) => s.endsWith(file));
    expect(idx("image-hitl.js")).toBeGreaterThanOrEqual(0);
    expect(idx("executors/index.js")).toBeGreaterThanOrEqual(0);
    // executor file must precede the registry (registry calls runImageHitl)
    expect(idx("image-hitl.js")).toBeLessThan(idx("executors/index.js"));
    // registry must precede messages.js (router calls notifyVariationSelected)
    expect(idx("executors/index.js")).toBeLessThan(idx("messages.js"));
  });

  it("loads the image-to-video executor before the registry (Phase 2.4)", () => {
    const src = readFileSync(path.join(EXT_ROOT, "background.js"), "utf8");
    const imports = [...src.matchAll(/importScripts\(['"]([^'"]+)['"]\)/g)].map(
      (m) => m[1],
    );
    const idx = (file: string): number =>
      imports.findIndex((s) => s.endsWith(file));
    expect(idx("image-to-video.js")).toBeGreaterThanOrEqual(0);
    // executor file must precede the registry (registry refs runImageToVideo)
    expect(idx("image-to-video.js")).toBeLessThan(idx("executors/index.js"));
    // registry must still precede messages.js
    expect(idx("executors/index.js")).toBeLessThan(idx("messages.js"));
  });

  it("loads the image-batch executor before the registry (S4)", () => {
    const src = readFileSync(path.join(EXT_ROOT, "background.js"), "utf8");
    const imports = [...src.matchAll(/importScripts\(['"]([^'"]+)['"]\)/g)].map(
      (m) => m[1],
    );
    const idx = (file: string): number =>
      imports.findIndex((s) => s.endsWith(file));
    expect(idx("image-batch.js")).toBeGreaterThanOrEqual(0);
    // executor file must precede the registry (registry refs runImageBatch)
    expect(idx("image-batch.js")).toBeLessThan(idx("executors/index.js"));
    // registry must still precede messages.js
    expect(idx("executors/index.js")).toBeLessThan(idx("messages.js"));
  });
});
