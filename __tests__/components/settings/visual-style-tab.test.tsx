import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { AllSettings } from "@/lib/settings";
import { installRadixJsdomPolyfills } from "../../helpers/radix-jsdom";

/**
 * Character-lock + style-lock plan, Task 1.2.
 *
 * The Visual Style tab gains two textareas — `style_lock_description`
 * and `character_lock_negative` — that operators edit alongside the
 * existing visual-style gallery. These settings are provider-agnostic
 * (consumed by step 09's prompt-assembly post-processing for ComfyUI
 * AND Google Flow), so the Visual Style tab is the right home.
 *
 * Tests pin three contracts:
 *   1. Both textareas mount with the seeded values pre-filled.
 *   2. The Save button is visible on the Visual Style tab now that
 *      TAB_FIELDS["visual-style"] is non-empty (it used to be `[]`,
 *      which gated Save off in settings-form.tsx).
 *   3. Editing a textarea + clicking Save sends a PATCH whose body
 *      carries only the edited key — the existing dirty-diff path.
 */

// Mock next/navigation (npm package — legitimate boundary mock).
const navMocks = vi.hoisted(() => ({
  searchParams: new URLSearchParams("tab=visual-style"),
  router: {
    refresh: vi.fn(),
    replace: vi.fn(),
    push: vi.fn(),
  },
  pathname: "/settings",
}));

vi.mock("next/navigation", () => ({
  useRouter: () => navMocks.router,
  useSearchParams: () => navMocks.searchParams,
  usePathname: () => navMocks.pathname,
}));

const STYLE_LOCK_SEED =
  "2D hand-drawn animation style, plain white background, pure black line work only, no color, no shading, no gradients, no 3D rendering, no photorealism, slight hand-drawn imperfection in linework. The character must be drawn in the exact same minimalist style as the reference ingredient.";

const NEGATIVE_LOCK_SEED =
  "color, shading, gradient, 3D, photorealistic, vector-clean lines, multiple characters, child, cartoon mascot, anime, manga, smiling, happy expression";

/**
 * Full AllSettings shape — keeps the tab-test fixture decoupled from
 * settings-form.test.tsx so a future schema addition fails this file
 * loudly instead of silently sharing a stale fixture.
 */
const defaults: AllSettings = {
  openrouter_script_model: "anthropic/claude-sonnet-4.6",
  openrouter_visual_model: "anthropic/claude-haiku-4.5",
  claude_cli_script_model: "claude-opus-4-7",
  claude_cli_visual_model: "claude-opus-4-7",
  image_provider: "comfyui",
  comfyui_base_url: "http://127.0.0.1:8188",
  comfyui_workflow_path: "prompts/comfyui/default-workflow.json",
  comfyui_hook_video_workflow_path:
    "prompts/comfyui/default-hook-video-workflow.json",
  google_flow_relogin_needed: false,
  google_flow_service_overload_cooldown_minutes: 15,
  google_flow_account_cooldown_hours: 4,
  google_flow_max_retries: 3,
  google_flow_image_model: "NARWHAL",
  google_flow_video_model: "veo_3_1_t2v_lite_low_priority",
  google_flow_aspect_ratio: "landscape",
  google_flow_image_aspect_ratio: "16:9",
  google_flow_hook_clip_seconds: "8",
  google_flow_dispatch_timeout_minutes: 30,
  aspect_ratio: "16:9",
  long_edge_px: 1920,
  framerate: 30,
  video_encoder: "libx264",
  hook_video_clip_seconds: 8,
  hook_length_seconds: 120,
  script_length_minutes: 90,
  voice_id: "voice-1",
  voiceover_model_id: "eleven_multilingual_v2",
  voice_stability: 0.75,
  voice_similarity: 0.5,
  voice_style: 0.0,
  voice_speed: 1.0,
  voice_use_speaker_boost: true,
  queue_state: "running",
  flow_create_project_failed: "",
  flow_service_overload_until: "",
  google_flow_content_moderation_enabled: true,
  google_flow_content_moderation_max_rounds: 2,
  google_flow_content_moderation_model: "",
  chatterbox_base_url: "http://127.0.0.1:8004",
  chatterbox_fast_base_url: "http://127.0.0.1:8005",
  chatterbox_voice_mode: "predefined",
  chatterbox_voice_filename: "",
  chatterbox_temperature: 0.8,
  chatterbox_exaggeration: 0.5,
  chatterbox_cfg_weight: 0.5,
  chatterbox_speed_factor: 1.0,
  chatterbox_fast_max_chunk_chars: 300,
  chatterbox_fast_silence_ms: 150,
  chatterbox_fast_workers: 2,
  visual_prompts_batch_size: 4,
  claude_cli_visual_prompts_concurrency: 3,
  openrouter_visual_prompts_concurrency: 16,
  image_chunk_target_seconds: 12,
  image_chunk_min_seconds: 4,
  image_chunk_max_seconds: 12,
  step_09_examples_json: "",
  magnific_token: "tok-mag-1",
  magnific_image_model: "flux-realism",
  magnific_video_model: "seedance",
  magnific_dispatch_timeout_minutes: 30,
  magnific_relogin_needed: false,
  music_video_loop_trim_tail_seconds: 0.3,
  music_video_loop_xfade_seconds: 0.2,
  style_lock_description: STYLE_LOCK_SEED,
  character_lock_negative: NEGATIVE_LOCK_SEED,
  magnific_runtime_enabled: false,
  magnific_runtime_user_data_dir: "data/magnific-userdata",
  magnific_runtime_window_visible: false,
  magnific_runtime_extension_path: "extensions/magnific-ext",
  draw_on_python_path: "",
};

beforeEach(() => {
  installRadixJsdomPolyfills();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/visual-styles")) {
        return new Response(JSON.stringify({ visual_styles: [] }), {
          status: 200,
        });
      }
      if (url.includes("/api/flow/accounts")) {
        return new Response(JSON.stringify({ accounts: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    })
  );
  navMocks.searchParams = new URLSearchParams("tab=visual-style");
  navMocks.router.refresh.mockReset();
  navMocks.router.replace.mockReset();
  navMocks.router.push.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderForm(): Promise<void> {
  const { SettingsForm } = await import("@/app/settings/settings-form");
  render(<SettingsForm initial={defaults} />);
}

function settingsPatchBody(): unknown {
  const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
  const call = [...fetchMock.mock.calls]
    .reverse()
    .find(
      (c) =>
        c[0] === "/api/settings" &&
        (c[1] as RequestInit | undefined)?.method === "PATCH"
    );
  if (!call) throw new Error("No PATCH /api/settings call recorded");
  return JSON.parse((call[1] as RequestInit).body as string);
}

describe("Visual Style tab — style + character lock textareas", () => {
  it("mounts both textareas with their seeded values pre-filled", async () => {
    await renderForm();

    const styleArea = screen.getByLabelText(
      /\[style_lock_description\]/
    ) as HTMLTextAreaElement;
    expect(styleArea).toBeTruthy();
    expect(styleArea.tagName).toBe("TEXTAREA");
    expect(styleArea.value).toBe(STYLE_LOCK_SEED);

    const negArea = screen.getByLabelText(
      /\[character_lock_negative\]/
    ) as HTMLTextAreaElement;
    expect(negArea).toBeTruthy();
    expect(negArea.tagName).toBe("TEXTAREA");
    expect(negArea.value).toBe(NEGATIVE_LOCK_SEED);
  });

  it("renders the Save button on the Visual Style tab (TAB_FIELDS no longer empty)", async () => {
    await renderForm();
    // Save was previously hidden on this tab because TAB_FIELDS["visual-style"]
    // was []. Adding the two textareas flips that gate on.
    expect(screen.getByRole("button", { name: /^save$/i })).toBeTruthy();
  });

  it("editing style_lock_description and saving PATCHes only that key", async () => {
    await renderForm();

    const styleArea = screen.getByLabelText(
      /\[style_lock_description\]/
    ) as HTMLTextAreaElement;

    await act(async () => {
      fireEvent.change(styleArea, { target: { value: "new style block" } });
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    });

    expect(settingsPatchBody()).toEqual({
      style_lock_description: "new style block",
    });
  });

  it("editing character_lock_negative and saving PATCHes only that key", async () => {
    await renderForm();

    const negArea = screen.getByLabelText(
      /\[character_lock_negative\]/
    ) as HTMLTextAreaElement;

    await act(async () => {
      fireEvent.change(negArea, { target: { value: "new negatives" } });
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    });

    expect(settingsPatchBody()).toEqual({
      character_lock_negative: "new negatives",
    });
  });
});
