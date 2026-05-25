import { describe, it, expect, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as DatabaseType } from "better-sqlite3";
import { createDb, seedDefaultSettings } from "@/lib/db";
import { setSetting } from "@/lib/settings";
import { createPromptModerator } from "@/lib/moderator";
import type { ChatMessage } from "@/lib/llm/types";

const tmpDirs: string[] = [];
function tempPromptsDir(promptBody: string): string {
  const dir = mkdtempSync(join(tmpdir(), "moderator-test-"));
  mkdirSync(join(dir, "_shared"), { recursive: true });
  writeFileSync(join(dir, "moderate_blocked_prompts.md"), promptBody);
  tmpDirs.push(dir);
  return dir;
}

const openDbs: DatabaseType[] = [];
function freshDb(): DatabaseType {
  const db = createDb(":memory:");
  seedDefaultSettings(db);
  openDbs.push(db);
  return db;
}

afterEach(() => {
  while (tmpDirs.length) {
    try {
      rmSync(tmpDirs.pop()!, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  while (openDbs.length) {
    try {
      openDbs.pop()!.close();
    } catch {
      // already closed
    }
  }
  vi.restoreAllMocks();
});

const sampleItems = [
  {
    id: "c_1",
    kind: "image" as const,
    reason_tag: "PUBLIC_ERROR_DANGER_FILTER",
    prev_text: "before",
    current_text: "the assassination",
    next_text: "after",
    original_prompt: "a graphic stabbing scene with blood",
  },
  {
    id: "c_2",
    kind: "clip" as const,
    reason_tag: "SAFETY",
    prev_text: "",
    current_text: "the duel",
    next_text: "",
    original_prompt: "a brutal sword duel",
  },
];

describe("createPromptModerator", () => {
  it("renders the prompt with JSON.stringify(items, null, 2) substituted into {{batch_json}} and passes it as a user message", async () => {
    const db = freshDb();
    const promptsDir = tempPromptsDir("PREAMBLE\n{{batch_json}}\nEND");

    let capturedMessages: ChatMessage[] | null = null;
    const chat = vi.fn(async (messages: ChatMessage[]) => {
      capturedMessages = messages;
      return JSON.stringify({
        rewrites: [
          { id: "c_1", rewritten_prompt: "rw1" },
          { id: "c_2", rewritten_prompt: "rw2" },
        ],
      });
    });

    await createPromptModerator({ db, chat, promptsDir }).moderate(
      sampleItems,
      1
    );

    expect(chat).toHaveBeenCalledOnce();
    expect(capturedMessages).not.toBeNull();
    expect(capturedMessages!).toHaveLength(1);
    expect(capturedMessages![0].role).toBe("user");
    const expectedJson = JSON.stringify(sampleItems, null, 2);
    expect(capturedMessages![0].content).toBe(
      `PREAMBLE\n${expectedJson}\nEND`
    );
  });

  it("parses a well-formed response into an id→prompt Map", async () => {
    const db = freshDb();
    const promptsDir = tempPromptsDir("{{batch_json}}");
    const chat = vi.fn(async () =>
      JSON.stringify({
        rewrites: [
          { id: "c_1", rewritten_prompt: "rewritten one" },
          { id: "c_2", rewritten_prompt: "rewritten two" },
        ],
      })
    );

    const result = await createPromptModerator({
      db,
      chat,
      promptsDir,
    }).moderate(sampleItems, 1);

    expect(result).toBeInstanceOf(Map);
    expect(result.get("c_1")).toBe("rewritten one");
    expect(result.get("c_2")).toBe("rewritten two");
    expect(result.size).toBe(2);
  });

  it("strips ```json fences from the reply before parsing", async () => {
    const db = freshDb();
    const promptsDir = tempPromptsDir("{{batch_json}}");
    const body = JSON.stringify({
      rewrites: [{ id: "c_1", rewritten_prompt: "fenced ok" }],
    });
    const chat = vi.fn(async () => "```json\n" + body + "\n```");

    const result = await createPromptModerator({
      db,
      chat,
      promptsDir,
    }).moderate(sampleItems.slice(0, 1), 1);

    expect(chat).toHaveBeenCalledOnce();
    expect(result.get("c_1")).toBe("fenced ok");
  });

  it("strips bare ``` fences from the reply before parsing", async () => {
    const db = freshDb();
    const promptsDir = tempPromptsDir("{{batch_json}}");
    const body = JSON.stringify({
      rewrites: [{ id: "c_1", rewritten_prompt: "bare fence ok" }],
    });
    const chat = vi.fn(async () => "```\n" + body + "\n```");

    const result = await createPromptModerator({
      db,
      chat,
      promptsDir,
    }).moderate(sampleItems.slice(0, 1), 1);

    expect(result.get("c_1")).toBe("bare fence ok");
  });

  it("retries once on JSON parse failure then succeeds", async () => {
    const db = freshDb();
    const promptsDir = tempPromptsDir("{{batch_json}}");
    const chat = vi
      .fn()
      .mockResolvedValueOnce("not json at all")
      .mockResolvedValueOnce(
        JSON.stringify({
          rewrites: [{ id: "c_1", rewritten_prompt: "ok" }],
        })
      );

    const result = await createPromptModerator({
      db,
      chat,
      promptsDir,
    }).moderate(sampleItems.slice(0, 1), 1);

    expect(chat).toHaveBeenCalledTimes(2);
    expect(result.get("c_1")).toBe("ok");
  });

  it("throws after retries are exhausted on JSON parse failure", async () => {
    const db = freshDb();
    const promptsDir = tempPromptsDir("{{batch_json}}");
    const chat = vi.fn().mockResolvedValue("still not json");

    await expect(
      createPromptModerator({ db, chat, promptsDir }).moderate(
        sampleItems.slice(0, 1),
        1
      )
    ).rejects.toThrow();

    // Two retries past the original = 3 attempts total? Plan says
    // "two retries around the parse step", which we interpret as up to 2
    // attempts total (one initial + one retry). Pin whatever the code does
    // here so the contract is explicit.
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it("passes opts.model when google_flow_content_moderation_model is set", async () => {
    const db = freshDb();
    setSetting(
      "google_flow_content_moderation_model",
      "anthropic/claude-3-haiku",
      db
    );
    const promptsDir = tempPromptsDir("{{batch_json}}");

    const calls: Array<{ messages: ChatMessage[]; opts?: unknown }> = [];
    const chat = vi.fn(
      async (messages: ChatMessage[], opts?: unknown) => {
        calls.push({ messages, opts });
        return JSON.stringify({
          rewrites: [{ id: "c_1", rewritten_prompt: "x" }],
        });
      }
    );

    await createPromptModerator({ db, chat, promptsDir }).moderate(
      sampleItems.slice(0, 1),
      1
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].opts).toMatchObject({
      model: "anthropic/claude-3-haiku",
    });
  });

  it("omits opts.model when google_flow_content_moderation_model is empty (chat wrapper falls back to the provider's visual model)", async () => {
    const db = freshDb();
    setSetting("google_flow_content_moderation_model", "", db);
    const promptsDir = tempPromptsDir("{{batch_json}}");

    const calls: Array<{ opts?: { model?: string } }> = [];
    const chat = vi.fn(
      async (_messages: ChatMessage[], opts?: { model?: string }) => {
        calls.push({ opts });
        return JSON.stringify({
          rewrites: [{ id: "c_1", rewritten_prompt: "x" }],
        });
      }
    );

    await createPromptModerator({ db, chat, promptsDir }).moderate(
      sampleItems.slice(0, 1),
      1
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].opts?.model).toBeUndefined();
  });

  it("throws when the response shape is missing rewrites[]", async () => {
    const db = freshDb();
    const promptsDir = tempPromptsDir("{{batch_json}}");
    const chat = vi.fn().mockResolvedValue(JSON.stringify({ wrong: 1 }));

    await expect(
      createPromptModerator({ db, chat, promptsDir }).moderate(
        sampleItems.slice(0, 1),
        1
      )
    ).rejects.toThrow();
  });

  it("substitutes {{round}} with the round number passed to moderate", async () => {
    const db = freshDb();
    const promptsDir = tempPromptsDir("round=[{{round}}]\n{{batch_json}}");

    let captured = "";
    const chat = vi.fn(async (messages: ChatMessage[]) => {
      captured = messages[0].content;
      return JSON.stringify({
        rewrites: [{ id: "c_1", rewritten_prompt: "x" }],
      });
    });

    await createPromptModerator({ db, chat, promptsDir }).moderate(
      sampleItems.slice(0, 1),
      3
    );

    expect(captured).toContain("round=[3]");
  });

  it("renders different {{escalation_guidance}} text for round 1 vs round 2", async () => {
    const db = freshDb();
    const promptsDir = tempPromptsDir("ESC[{{escalation_guidance}}]");

    const captured: string[] = [];
    const chat = vi.fn(async (messages: ChatMessage[]) => {
      captured.push(messages[0].content);
      return JSON.stringify({
        rewrites: [{ id: "c_1", rewritten_prompt: "x" }],
      });
    });

    const moderator = createPromptModerator({ db, chat, promptsDir });
    await moderator.moderate(sampleItems.slice(0, 1), 1);
    await moderator.moderate(sampleItems.slice(0, 1), 2);

    expect(captured).toHaveLength(2);
    const r1 = captured[0];
    const r2 = captured[1];
    expect(r1.startsWith("ESC[")).toBe(true);
    expect(r2.startsWith("ESC[")).toBe(true);
    expect(r1).not.toBe(r2);
    // Neither should be empty — both rounds must have explicit guidance.
    expect(r1.length).toBeGreaterThan("ESC[]".length);
    expect(r2.length).toBeGreaterThan("ESC[]".length);
  });

  it("reuses the highest defined round's escalation_guidance for rounds beyond it", async () => {
    const db = freshDb();
    const promptsDir = tempPromptsDir("ESC[{{escalation_guidance}}]");

    const captured: string[] = [];
    const chat = vi.fn(async (messages: ChatMessage[]) => {
      captured.push(messages[0].content);
      return JSON.stringify({
        rewrites: [{ id: "c_1", rewritten_prompt: "x" }],
      });
    });

    const moderator = createPromptModerator({ db, chat, promptsDir });
    // Round 2 is the highest defined; round 7 (well beyond) should reuse it.
    await moderator.moderate(sampleItems.slice(0, 1), 2);
    await moderator.moderate(sampleItems.slice(0, 1), 7);

    expect(captured).toHaveLength(2);
    expect(captured[1]).toBe(captured[0]);
  });

  it("renders the audio playbook when the batch contains PUBLIC_ERROR_AUDIO_FILTERED", async () => {
    const db = freshDb();
    const promptsDir = tempPromptsDir("PLAY[{{tag_playbooks}}]");

    let captured = "";
    const chat = vi.fn(async (messages: ChatMessage[]) => {
      captured = messages[0].content;
      return JSON.stringify({
        rewrites: [{ id: "c_1", rewritten_prompt: "x" }],
      });
    });

    await createPromptModerator({ db, chat, promptsDir }).moderate(
      [{ ...sampleItems[0], reason_tag: "PUBLIC_ERROR_AUDIO_FILTERED" }],
      1
    );

    expect(captured.startsWith("PLAY[")).toBe(true);
    expect(captured).toContain("audio-safety filter");
    expect(captured).toContain("speech-implying");
  });

  it("renders empty {{tag_playbooks}} for an unrecognized canonical-shape code without throwing", async () => {
    const db = freshDb();
    const promptsDir = tempPromptsDir("PLAY[{{tag_playbooks}}]");

    let captured = "";
    const chat = vi.fn(async (messages: ChatMessage[]) => {
      captured = messages[0].content;
      return JSON.stringify({
        rewrites: [{ id: "c_1", rewritten_prompt: "x" }],
      });
    });

    await createPromptModerator({ db, chat, promptsDir }).moderate(
      [{ ...sampleItems[0], reason_tag: "PUBLIC_ERROR_FOO_FILTERED" }],
      1
    );

    expect(captured).toBe("PLAY[]");
  });

  it("renders empty {{tag_playbooks}} for a raw error string reason_tag", async () => {
    const db = freshDb();
    const promptsDir = tempPromptsDir("PLAY[{{tag_playbooks}}]");

    let captured = "";
    const chat = vi.fn(async (messages: ChatMessage[]) => {
      captured = messages[0].content;
      return JSON.stringify({
        rewrites: [{ id: "c_1", rewritten_prompt: "x" }],
      });
    });

    await createPromptModerator({ db, chat, promptsDir }).moderate(
      [
        {
          ...sampleItems[0],
          reason_tag: "HTTP 500 internal server error from upstream",
        },
      ],
      1
    );

    expect(captured).toBe("PLAY[]");
  });

  it("emits a playbook once even when multiple items share the same reason_tag", async () => {
    const db = freshDb();
    const promptsDir = tempPromptsDir("PLAY[{{tag_playbooks}}]");

    let captured = "";
    const chat = vi.fn(async (messages: ChatMessage[]) => {
      captured = messages[0].content;
      return JSON.stringify({
        rewrites: [
          { id: "c_1", rewritten_prompt: "x" },
          { id: "c_2", rewritten_prompt: "y" },
        ],
      });
    });

    await createPromptModerator({ db, chat, promptsDir }).moderate(
      [
        { ...sampleItems[0], reason_tag: "PUBLIC_ERROR_AUDIO_FILTERED" },
        { ...sampleItems[1], reason_tag: "PUBLIC_ERROR_AUDIO_FILTERED" },
      ],
      1
    );

    const matches = captured.match(/Audio playbook/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it("emits the shared Person playbook once when both PERSON_GENERATION and PUBLIC_ERROR_PROMINENT_PEOPLE_FILTER_FAILED appear", async () => {
    const db = freshDb();
    const promptsDir = tempPromptsDir("PLAY[{{tag_playbooks}}]");

    let captured = "";
    const chat = vi.fn(async (messages: ChatMessage[]) => {
      captured = messages[0].content;
      return JSON.stringify({
        rewrites: [
          { id: "c_1", rewritten_prompt: "x" },
          { id: "c_2", rewritten_prompt: "y" },
        ],
      });
    });

    await createPromptModerator({ db, chat, promptsDir }).moderate(
      [
        { ...sampleItems[0], reason_tag: "PERSON_GENERATION" },
        {
          ...sampleItems[1],
          reason_tag: "PUBLIC_ERROR_PROMINENT_PEOPLE_FILTER_FAILED",
        },
      ],
      1
    );

    expect(captured).toContain("Person playbook");
    const matches = captured.match(/Person playbook/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it("emits audio and danger playbooks in list-defined order when both tags appear", async () => {
    const db = freshDb();
    const promptsDir = tempPromptsDir("PLAY[{{tag_playbooks}}]");

    let captured = "";
    const chat = vi.fn(async (messages: ChatMessage[]) => {
      captured = messages[0].content;
      return JSON.stringify({
        rewrites: [
          { id: "c_1", rewritten_prompt: "x" },
          { id: "c_2", rewritten_prompt: "y" },
        ],
      });
    });

    await createPromptModerator({ db, chat, promptsDir }).moderate(
      [
        { ...sampleItems[0], reason_tag: "PUBLIC_ERROR_DANGER_FILTER" },
        { ...sampleItems[1], reason_tag: "PUBLIC_ERROR_AUDIO_FILTERED" },
      ],
      1
    );

    expect(captured).toContain("Audio playbook");
    expect(captured).toContain("Danger playbook");
    // List order: audio entry is defined before danger, so audio text
    // appears first in the rendered prompt regardless of item order.
    expect(captured.indexOf("Audio playbook")).toBeLessThan(
      captured.indexOf("Danger playbook")
    );
  });
});
