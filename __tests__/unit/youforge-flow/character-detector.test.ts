import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

// character-detector.js is loaded as a classic script in the SW. The
// sandbox provides minimal stubs for chrome.webRequest + chrome.storage
// and exposes the module's globals so tests can drive
// handleFlowImageGenRequest directly with synthesised webRequest details.

type StorageMap = Record<string, unknown>;
type DetectorModule = {
  registerCharacterDetector: () => void;
  handleFlowImageGenRequest: (details: unknown) => void;
  recordDetected: (items: Array<{ entityId: string; label: string }>) => Promise<void>;
};

interface WebRequestStub {
  onBeforeRequest: {
    addListener: ReturnType<typeof vi.fn>;
  };
}

interface StorageStub {
  local: {
    get: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
    _state: StorageMap;
  };
}

function loadDetector() {
  const src = readFileSync(
    path.resolve(
      process.cwd(),
      "extensions/youforge-flow/src/character-detector.js",
    ),
    "utf8",
  );
  const state: StorageMap = {};
  const storage: StorageStub = {
    local: {
      _state: state,
      get: vi.fn(async (key: string) => {
        if (typeof key === "string") {
          return key in state ? { [key]: state[key] } : {};
        }
        return {};
      }) as unknown as ReturnType<typeof vi.fn>,
      set: vi.fn(async (patch: StorageMap) => {
        for (const k of Object.keys(patch)) state[k] = patch[k];
      }) as unknown as ReturnType<typeof vi.fn>,
    },
  };
  const webRequest: WebRequestStub = {
    onBeforeRequest: {
      addListener: vi.fn(),
    },
  };
  const sandbox: Record<string, unknown> = {
    console: { log: () => {} },
    safeLog: () => {},
    chrome: { webRequest, storage },
    TextDecoder,
    Uint8Array,
    ArrayBuffer,
    Date,
    JSON,
    Array,
    Promise,
    Object,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return {
    mod: sandbox as unknown as DetectorModule,
    webRequest,
    storage,
  };
}

function bytesOf(json: unknown): ArrayBuffer {
  const text = JSON.stringify(json);
  const u8 = new TextEncoder().encode(text);
  // Return a fresh ArrayBuffer the way Chrome does (not a SharedArrayBuffer).
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

const ENTITY_A = "48658452-0289-4fbe-a130-05943bd4bf2b";
const ENTITY_B = "11111111-2222-3333-4444-555555555555";
const FLOW_URL =
  "https://aisandbox-pa.googleapis.com/v1/projects/proj-1/flowMedia:batchGenerateImages";

describe("character-detector", () => {
  let ctx: ReturnType<typeof loadDetector>;
  beforeEach(() => {
    ctx = loadDetector();
  });

  describe("registerCharacterDetector", () => {
    it("registers on chrome.webRequest.onBeforeRequest with the Flow URL pattern + requestBody extraInfoSpec", () => {
      ctx.mod.registerCharacterDetector();
      expect(ctx.webRequest.onBeforeRequest.addListener).toHaveBeenCalledTimes(1);
      const [, filter, extra] = ctx.webRequest.onBeforeRequest.addListener.mock.calls[0];
      expect(filter).toEqual({
        urls: [
          "https://aisandbox-pa.googleapis.com/v1/projects/*/flowMedia:batchGenerateImages",
        ],
      });
      expect(extra).toEqual(["requestBody"]);
    });
  });

  describe("handleFlowImageGenRequest", () => {
    // The detector queues writes through an internal Promise chain.
    // Waiting one full event-loop turn (setTimeout(0)) is more reliable
    // than counting microtask flushes, since the chain can do multiple
    // awaits per call.
    async function flushMicrotasks() {
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    }

    it("extracts referenceEntities[].entityId and stores it under detectedCharacters", async () => {
      const body = {
        requests: [
          {
            structuredPrompt: { parts: [{ text: "a knight in armor" }] },
            referenceEntities: [{ entityId: ENTITY_A }],
          },
        ],
      };
      ctx.mod.handleFlowImageGenRequest({
        method: "POST",
        url: FLOW_URL,
        requestBody: { raw: [{ bytes: bytesOf(body) }] },
      });
      await flushMicrotasks();
      const stored = ctx.storage.local._state.detectedCharacters as Array<{
        entityId: string;
        label: string;
      }>;
      expect(stored).toHaveLength(1);
      expect(stored[0].entityId).toBe(ENTITY_A);
      expect(stored[0].label).toBe("a knight in armor");
    });

    it("ignores non-POST requests", async () => {
      ctx.mod.handleFlowImageGenRequest({
        method: "GET",
        url: FLOW_URL,
        requestBody: {
          raw: [{ bytes: bytesOf({ requests: [{ referenceEntities: [{ entityId: ENTITY_A }] }] }) }],
        },
      });
      await flushMicrotasks();
      expect(ctx.storage.local._state.detectedCharacters).toBeUndefined();
    });

    it("ignores URLs that don't match the Flow image-gen path", async () => {
      ctx.mod.handleFlowImageGenRequest({
        method: "POST",
        url: "https://aisandbox-pa.googleapis.com/v1/some/other/endpoint",
        requestBody: {
          raw: [{ bytes: bytesOf({ requests: [{ referenceEntities: [{ entityId: ENTITY_A }] }] }) }],
        },
      });
      await flushMicrotasks();
      expect(ctx.storage.local._state.detectedCharacters).toBeUndefined();
    });

    it("skips requests with no referenceEntities (unlocked generation)", async () => {
      ctx.mod.handleFlowImageGenRequest({
        method: "POST",
        url: FLOW_URL,
        requestBody: {
          raw: [{ bytes: bytesOf({ requests: [{ structuredPrompt: { parts: [{ text: "plain prompt" }] } }] }) }],
        },
      });
      await flushMicrotasks();
      expect(ctx.storage.local._state.detectedCharacters).toBeUndefined();
    });

    it("move-to-front: re-seeing an entityId refreshes its position without growing the list", async () => {
      const seedTime = Date.now();
      ctx.storage.local._state.detectedCharacters = [
        { entityId: ENTITY_A, label: "old label", lastSeen: seedTime - 10000 },
        { entityId: ENTITY_B, label: "other character", lastSeen: seedTime - 5000 },
      ];
      ctx.mod.handleFlowImageGenRequest({
        method: "POST",
        url: FLOW_URL,
        requestBody: {
          raw: [{ bytes: bytesOf({ requests: [{
            structuredPrompt: { parts: [{ text: "new prompt for A" }] },
            referenceEntities: [{ entityId: ENTITY_A }],
          }] }) }],
        },
      });
      await flushMicrotasks();
      const stored = ctx.storage.local._state.detectedCharacters as Array<{
        entityId: string;
        label: string;
        lastSeen: number;
      }>;
      expect(stored).toHaveLength(2);
      expect(stored[0].entityId).toBe(ENTITY_A);
      expect(stored[0].label).toBe("new prompt for A");
      expect(stored[0].lastSeen).toBeGreaterThanOrEqual(seedTime);
      expect(stored[1].entityId).toBe(ENTITY_B);
    });

    it("caps the list at 10 entries (drops the oldest, which is last in the recency-sorted array)", async () => {
      // The detector preserves recency-first ordering: index 0 = newest.
      // Seed in that order, with entry 9 as the oldest (earliest lastSeen).
      // After unshift + slice(0, 10), entry 9 should be dropped.
      const now = Date.now();
      const seed: Array<{ entityId: string; label: string; lastSeen: number }> = [];
      for (let i = 0; i < 10; i++) {
        seed.push({
          entityId: `aaaaaaaa-bbbb-cccc-dddd-${String(i).padStart(12, "0")}`,
          label: `entry ${i}`,
          lastSeen: now - i * 1000, // i=0 newest, i=9 oldest
        });
      }
      ctx.storage.local._state.detectedCharacters = seed;
      const NEW_ID = "ffffffff-0000-1111-2222-333333333333";
      ctx.mod.handleFlowImageGenRequest({
        method: "POST",
        url: FLOW_URL,
        requestBody: {
          raw: [{ bytes: bytesOf({ requests: [{
            structuredPrompt: { parts: [{ text: "a fresh character" }] },
            referenceEntities: [{ entityId: NEW_ID }],
          }] }) }],
        },
      });
      await flushMicrotasks();
      const stored = ctx.storage.local._state.detectedCharacters as Array<{ entityId: string }>;
      expect(stored).toHaveLength(10);
      expect(stored[0].entityId).toBe(NEW_ID);
      // Entry 9 (oldest) was dropped to make room for the new ID.
      expect(stored.find((e) => e.entityId.endsWith("000000000009"))).toBeUndefined();
      // Entry 0 (newest pre-existing) is still present, now at index 1.
      expect(stored[1].entityId).toBe(seed[0].entityId);
    });

    it("handles multiple referenceEntities in a single request", async () => {
      ctx.mod.handleFlowImageGenRequest({
        method: "POST",
        url: FLOW_URL,
        requestBody: {
          raw: [{ bytes: bytesOf({ requests: [{
            structuredPrompt: { parts: [{ text: "two characters" }] },
            referenceEntities: [
              { entityId: ENTITY_A },
              { entityId: ENTITY_B },
            ],
          }] }) }],
        },
      });
      await flushMicrotasks();
      const stored = ctx.storage.local._state.detectedCharacters as Array<{ entityId: string }>;
      // Both stored. ENTITY_B was inserted last so move-to-front puts it at index 0.
      expect(stored).toHaveLength(2);
      expect(stored.map((e) => e.entityId).sort()).toEqual([ENTITY_A, ENTITY_B].sort());
    });

    it("truncates labels longer than 80 chars with an ellipsis", async () => {
      const longText = "x".repeat(120);
      ctx.mod.handleFlowImageGenRequest({
        method: "POST",
        url: FLOW_URL,
        requestBody: {
          raw: [{ bytes: bytesOf({ requests: [{
            structuredPrompt: { parts: [{ text: longText }] },
            referenceEntities: [{ entityId: ENTITY_A }],
          }] }) }],
        },
      });
      await flushMicrotasks();
      const stored = ctx.storage.local._state.detectedCharacters as Array<{ label: string }>;
      expect(stored[0].label.length).toBeLessThanOrEqual(81); // 80 + ellipsis
      expect(stored[0].label.endsWith("…")).toBe(true);
    });

    it("falls back to '(no prompt)' label when structuredPrompt is missing", async () => {
      ctx.mod.handleFlowImageGenRequest({
        method: "POST",
        url: FLOW_URL,
        requestBody: {
          raw: [{ bytes: bytesOf({ requests: [{
            referenceEntities: [{ entityId: ENTITY_A }],
          }] }) }],
        },
      });
      await flushMicrotasks();
      const stored = ctx.storage.local._state.detectedCharacters as Array<{ label: string }>;
      expect(stored[0].label).toBe("(no prompt)");
    });

    it("survives a body that isn't valid JSON", async () => {
      const garbage = new TextEncoder().encode("<html>not json</html>");
      ctx.mod.handleFlowImageGenRequest({
        method: "POST",
        url: FLOW_URL,
        requestBody: { raw: [{ bytes: garbage.buffer }] },
      });
      await flushMicrotasks();
      expect(ctx.storage.local._state.detectedCharacters).toBeUndefined();
    });

    it("survives requestBody without a raw field (form-data path)", async () => {
      ctx.mod.handleFlowImageGenRequest({
        method: "POST",
        url: FLOW_URL,
        requestBody: { formData: { key: ["value"] } },
      });
      await flushMicrotasks();
      expect(ctx.storage.local._state.detectedCharacters).toBeUndefined();
    });
  });
});
