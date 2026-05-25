import type { Database as DatabaseType } from "better-sqlite3";
import { getDb } from "@/lib/db";
import { getSetting } from "@/lib/settings";
import { render } from "@/lib/prompts";
import type { ChatMessage } from "@/lib/llm/types";
import type { GoogleFlowQueueKind } from "@/types";

/**
 * Input shape for one prompt the moderator should rewrite. Carried
 * through the moderate_blocked_prompts.md template as JSON via the
 * `{{batch_json}}` placeholder; the round number, escalation guidance,
 * and per-tag playbooks flow through `{{round}}`,
 * `{{escalation_guidance}}`, and `{{tag_playbooks}}` alongside.
 */
export interface ModerationItem {
  id: string;
  kind: GoogleFlowQueueKind;
  reason_tag: string;
  prev_text: string;
  current_text: string;
  next_text: string;
  original_prompt: string;
}

export interface CreatePromptModeratorOpts {
  db?: DatabaseType;
  promptsDir?: string;
  chat: (
    messages: ChatMessage[],
    opts?: { db?: DatabaseType; model?: string }
  ) => Promise<string>;
}

/**
 * Object-with-method shape mirrors `LlmProvider` / `ImageProvider` /
 * `TtsProvider`. Constructed once per pipeline run by the coordinator
 * (see `runPipeline`) and threaded down to `GoogleFlowStepDeps.moderator`
 * so the moderation seam lives at the coordinator boundary rather than
 * leaking through the image/video provider opts surface.
 */
export interface PromptModerator {
  moderate(
    items: ModerationItem[],
    round: number
  ): Promise<Map<string, string>>;
}

const MAX_PARSE_ATTEMPTS = 2;

// Round-specific guidance injected into the moderator prompt as
// `{{escalation_guidance}}`. Round 1 stays close to the template's
// baseline rules; round 2+ tells the LLM the previous rewrite still
// failed and to strip more aggressively. Rounds beyond the highest key
// reuse the highest entry's text — raising `max_rounds` later won't
// crash.
const ESCALATION_GUIDANCE: Record<number, string> = {
  1: "This is the first rewrite pass. Apply the rules below carefully: preserve the historical setting, era, costume, and emotional weight, but neutralize the specific language that tripped the filter. Stay close to the original scene — reframe the trigger language, not the story.",
  2: "The previous rewrite still failed Google's filter. Be more aggressive this round: drop scene-specific verbs and named gestures, replace any remaining suggestive vocabulary with abstract or atmospheric framing, and lean on lighting, posture, and setting rather than action. Sacrifice scene specificity to get past the filter — a generic, atmospheric prompt that renders is better than another rejection.",
};

const HIGHEST_DEFINED_ROUND = Math.max(
  ...Object.keys(ESCALATION_GUIDANCE).map(Number)
);

function resolveEscalationGuidance(round: number): string {
  return (
    ESCALATION_GUIDANCE[round] ?? ESCALATION_GUIDANCE[HIGHEST_DEFINED_ROUND]
  );
}

// Per-tag playbooks injected into the moderator prompt as
// `{{tag_playbooks}}` — layered *on top of* the general rules in the
// template, not replacing them. Each entry fires at most once if any of
// its `codes` appears in the batch's `reason_tag` set. Entries emit in
// list order (deterministic for tests). Non-canonical values (raw error
// strings or future Google codes outside CONTENT_POLICY_REASONS) match
// nothing and drop naturally — no filtering required.
const TAG_PLAYBOOKS: ReadonlyArray<{
  readonly codes: readonly string[];
  readonly text: string;
}> = [
  {
    codes: ["PUBLIC_ERROR_AUDIO_FILTERED"],
    text:
      "**Audio playbook** — Google's audio-safety filter rejected this batch. Veo invents dialogue, ambient sound, and SFX from the visual prompt, so any speech-implying verb or noun phrase becomes audio Google will try to synthesize. Two patterns drive these rejections: speech-implying language AND framing that primes hateful, threatening, or harmful speech. Strip speech-implying verbs and noun phrases: 'calls for', 'shouts of', 'the cry of', 'cries out', 'demands', 'pleads', 'roars'. Strip framing that casts a person as inferior by birth, class, race, or lineage — 'illegitimate child/boy/birth', 'denied entry because of his birth/race/class'. Strip authority-violence framing: 'ruthless authority', 'barely restrained violence', 'menacing presence', 'force, not charm', 'rule by fear', and 'mercenaries' paired with 'violence/threat/intimidation'. Replace with neutral observational framing: the figure's posture, expression, setting, and ambient mood rather than implied speech, grievance, or threat.",
  },
  {
    codes: ["PUBLIC_ERROR_DANGER_FILTER"],
    text:
      "**Danger playbook** — Google's danger filter rejected this batch. Two failure modes drive these rejections: explicit gore vocabulary AND assassination/political-violence framing. Strip every wound/blood/stab descriptor: 'blood', 'bloodstained', 'blood pooling', 'stab wounds', 'wounded', 'mutilated', 'torn flesh', 'gore', 'corpse', 'stabbing', 'slashing', 'killing'. Strip event framing that names the act: 'brutal assassination', 'savage attack', 'moment of violent chaos'. Describe aftermath, implication, or emotional reaction — a fallen figure in dark-stained robes, stunned onlookers, attackers fleeing into shadow. The scene can still convey tragedy through chiaroscuro lighting, posture, and the reactions of bystanders.",
  },
  {
    codes: ["PERSON_GENERATION", "PUBLIC_ERROR_PROMINENT_PEOPLE_FILTER_FAILED"],
    text:
      "**Person playbook** — Google's prominent-people / person-generation filter rejected this batch. Any named historical, political, military, or cultural figure trips this — even a vague reference to a famous name fails every time. Replace every name with role + era + visual descriptors: 'a stout British prime minister in his late sixties, bow tie and three-piece suit, cigar in hand' instead of 'Churchill'; 'a gaunt Dutch post-impressionist painter in his late thirties, red hair and beard, paint-stained smock' instead of 'Vincent van Gogh'. Strip the name even when the chunk text uses it directly. Generic roles (soldier, painter, king, scientist) and fictional/composite characters are fine.",
  },
];

function composeTagPlaybooks(items: ModerationItem[]): string {
  const tags = new Set(items.map((i) => i.reason_tag));
  const parts: string[] = [];
  for (const entry of TAG_PLAYBOOKS) {
    if (entry.codes.some((c) => tags.has(c))) parts.push(entry.text);
  }
  return parts.join("\n\n");
}

/**
 * Build a `PromptModerator` that renders `prompts/moderate_blocked_prompts.md`,
 * calls the closure-captured `chat`, and parses the documented
 * `{rewrites: [...]}` envelope.
 *
 * Retries up to {@link MAX_PARSE_ATTEMPTS} times if the response can't
 * be parsed; the underlying chat() already retries network failures
 * (see lib/llm/openrouter.ts).
 *
 * Model selection: when `google_flow_content_moderation_model` is set,
 * it's passed via `opts.model`. When empty, opts.model is omitted so
 * the injected `chat` (the pipeline's `visualPromptChat` wrapper) falls
 * back to the workflow-pinned provider's visual model.
 */
export function createPromptModerator(
  opts: CreatePromptModeratorOpts
): PromptModerator {
  return {
    async moderate(items, round) {
      const db = opts.db ?? getDb();
      const promptsDir = opts.promptsDir ?? "prompts";
      const moderatorModel = getSetting(
        "google_flow_content_moderation_model",
        db
      );

      const batchJson = JSON.stringify(items, null, 2);
      const userPrompt = render(
        "moderate_blocked_prompts.md",
        {
          batch_json: batchJson,
          round,
          escalation_guidance: resolveEscalationGuidance(round),
          tag_playbooks: composeTagPlaybooks(items),
        },
        promptsDir
      );

      const chatOpts: { db: DatabaseType; model?: string } = { db };
      if (moderatorModel) chatOpts.model = moderatorModel;

      let lastError: unknown;
      for (let attempt = 0; attempt < MAX_PARSE_ATTEMPTS; attempt++) {
        const reply = await opts.chat(
          [{ role: "user", content: userPrompt }],
          chatOpts
        );
        try {
          return parseModeratorReply(reply);
        } catch (err) {
          lastError = err;
        }
      }
      throw lastError instanceof Error
        ? lastError
        : new Error(String(lastError));
    },
  };
}

function parseModeratorReply(reply: string): Map<string, string> {
  const cleaned = stripCodeFence(reply);
  const parsed: unknown = JSON.parse(cleaned);
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as { rewrites?: unknown }).rewrites)
  ) {
    throw new Error(
      `moderator: response missing rewrites[]: ${reply.slice(0, 200)}`
    );
  }
  const rewrites = (parsed as { rewrites: unknown[] }).rewrites;
  const out = new Map<string, string>();
  for (const r of rewrites) {
    if (
      !r ||
      typeof r !== "object" ||
      typeof (r as { id?: unknown }).id !== "string" ||
      typeof (r as { rewritten_prompt?: unknown }).rewritten_prompt !==
        "string"
    ) {
      throw new Error(
        `moderator: bad rewrite entry: ${JSON.stringify(r).slice(0, 200)}`
      );
    }
    const item = r as { id: string; rewritten_prompt: string };
    out.set(item.id, item.rewritten_prompt);
  }
  return out;
}

// The prompt forbids markdown fences but LLMs sometimes wrap JSON in
// ```json ... ``` anyway. Strip a single surrounding fence so JSON.parse
// can consume the body.
function stripCodeFence(raw: string): string {
  return raw
    .trim()
    .replace(/^```(?:json)?\s*\n?/i, "")
    .replace(/\n?```\s*$/, "");
}
