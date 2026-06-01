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

// Mock next/navigation (npm package — legitimate boundary mock) so the
// form's router + searchParams hooks don't crash in jsdom, and so tests
// can control the initial ?tab= value + assert on router.replace calls.
const navMocks = vi.hoisted(() => ({
  searchParams: new URLSearchParams(),
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

const defaultSettings: AllSettings = {
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
  flow_service_overload_until: "",
  // Distinct values per field so getByDisplayValue() in tab tests can
  // still single out each control by its rendered number.
  google_flow_service_overload_cooldown_minutes: 17,
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
  style_lock_description: "seeded style lock",
  character_lock_negative: "seeded negative",
  magnific_runtime_enabled: false,
  magnific_runtime_user_data_dir: "data/magnific-userdata",
  magnific_runtime_window_visible: false,
  magnific_runtime_extension_path: "extensions/magnific-ext",
  draw_on_python_path: "",
};

beforeEach(() => {
  installRadixJsdomPolyfills();
  // GoogleFlowAccounts useEffect calls /api/flow/accounts and reads
  // body.accounts. A bare {ok:true} payload makes accounts undefined and
  // the next render crashes on `.length`. Branch by URL so accounts gets a
  // valid empty array regardless of what the test does next.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/flow/accounts")) {
        return new Response(JSON.stringify({ accounts: [] }), {
          status: 200,
        });
      }
      if (url.includes("/api/visual-styles")) {
        // VisualStyleGallery (mounted on the Visual Style tab) reads
        // body.visual_styles on load. Return an empty list — the form
        // tests don't exercise the gallery, just need it to not crash.
        return new Response(JSON.stringify({ visual_styles: [] }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    })
  );
  // Reset navigation mock state between tests so ?tab= + replace calls
  // from one test don't leak into the next.
  navMocks.searchParams = new URLSearchParams();
  navMocks.router.refresh.mockReset();
  navMocks.router.replace.mockReset();
  navMocks.router.push.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderForm(
  initial: AllSettings = defaultSettings
): Promise<void> {
  const { SettingsForm } = await import("@/app/settings/settings-form");
  render(<SettingsForm initial={initial} />);
}

async function clickSave(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
  });
}

function clickTab(name: RegExp): void {
  // Radix Tabs activates on mouseDown (button=0), not click —
  // fireEvent.click alone doesn't flip the tab in jsdom.
  const tab = screen.getByRole("tab", { name });
  fireEvent.mouseDown(tab, { button: 0 });
}

/**
 * Drive a Radix Select: focus the trigger, open the portal with Enter,
 * then click the option whose accessible name matches `optionName`.
 * fireEvent.change on the hidden native <select> does NOT drive Radix
 * state.
 */
async function pickSelect(
  triggerName: RegExp,
  optionName: RegExp,
): Promise<void> {
  const trigger = screen.getByRole("combobox", { name: triggerName });
  await act(async () => {
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter", code: "Enter" });
  });
  const option = await screen.findByRole("option", { name: optionName });
  await act(async () => {
    fireEvent.click(option);
  });
}

function tabByName(name: RegExp): HTMLElement {
  return screen.getByRole("tab", { name });
}

/**
 * Pull the JSON body from the most-recent PATCH against /api/settings.
 * Tests that activate the Google Flow tab also trigger an unrelated GET
 * to /api/flow/accounts, so indexing fetchMock.mock.calls by position is
 * fragile. Find the settings PATCH by URL and method instead.
 */
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

describe("SettingsForm tab navigation", () => {
  it("renders seven tab buttons: Script, Visual Style, TTS, Google Flow, Magnific, ComfyUI, Render", async () => {
    await renderForm();
    expect(tabByName(/^script$/i)).toBeTruthy();
    expect(tabByName(/visual style/i)).toBeTruthy();
    expect(tabByName(/^tts$/i)).toBeTruthy();
    expect(tabByName(/google flow/i)).toBeTruthy();
    expect(tabByName(/^magnific$/i)).toBeTruthy();
    expect(tabByName(/comfyui/i)).toBeTruthy();
    expect(tabByName(/render/i)).toBeTruthy();
    // LLM tab is gone — its content moved to the Script tab.
    expect(screen.queryByRole("tab", { name: /^llm$/i })).toBeNull();
  });

  it("defaults to Script when the URL has no ?tab= param", async () => {
    await renderForm();
    expect(tabByName(/^script$/i).getAttribute("aria-selected")).toBe("true");
    expect(tabByName(/comfyui/i).getAttribute("aria-selected")).toBe("false");
  });

  it("activates the tab named in ?tab= on mount", async () => {
    navMocks.searchParams = new URLSearchParams("tab=comfyui");
    await renderForm();
    expect(tabByName(/comfyui/i).getAttribute("aria-selected")).toBe("true");
    expect(tabByName(/^script$/i).getAttribute("aria-selected")).toBe("false");
  });

  it("falls back to Script when ?tab= names an unknown tab (including the legacy 'llm' and 'openrouter' ids)", async () => {
    navMocks.searchParams = new URLSearchParams("tab=llm");
    await renderForm();
    expect(tabByName(/^script$/i).getAttribute("aria-selected")).toBe("true");

    cleanup();
    navMocks.searchParams = new URLSearchParams("tab=openrouter");
    await renderForm();
    expect(tabByName(/^script$/i).getAttribute("aria-selected")).toBe("true");
  });

  it("clicking a tab activates it and updates the URL via router.replace", async () => {
    await renderForm();

    clickTab(/^tts$/i);

    expect(tabByName(/^tts$/i).getAttribute("aria-selected")).toBe("true");
    expect(navMocks.router.replace).toHaveBeenCalledTimes(1);
    const [destination] = navMocks.router.replace.mock.calls[0];
    expect(String(destination)).toContain("tab=tts");
  });
});

describe("SettingsForm field distribution", () => {
  it("Magnific tab: renders the token (masked) + both model fields and hides the dispatch timeout under Advanced", async () => {
    await renderForm();
    clickTab(/^magnific$/i);

    // Token field is mounted but masked — its visible value is bullets,
    // never the literal token. The Reveal button is also present.
    const tokenInput = screen.getByLabelText(
      /\[magnific_token\]/
    ) as HTMLInputElement;
    expect(tokenInput).toBeTruthy();
    expect(tokenInput.value).not.toBe("tok-mag-1");
    expect(tokenInput.value).toContain("•");
    expect(screen.getByRole("button", { name: /reveal token/i })).toBeTruthy();

    // Both model TextFields seeded with the persisted values.
    const imageModel = screen.getByLabelText(
      /\[magnific_image_model\]/
    ) as HTMLInputElement;
    expect(imageModel.value).toBe("flux-realism");
    const videoModel = screen.getByLabelText(
      /\[magnific_video_model\]/
    ) as HTMLInputElement;
    expect(videoModel.value).toBe("seedance");

    // The dispatch-timeout number input sits under Advanced and is not
    // mounted while the collapsible is closed (Radix Presence default).
    expect(
      screen.queryByLabelText(/\[magnific_dispatch_timeout_minutes\]/)
    ).toBeNull();
  });

  it("Magnific tab: clicking Reveal flips the token to plaintext", async () => {
    await renderForm();
    clickTab(/^magnific$/i);

    const reveal = screen.getByRole("button", { name: /reveal token/i });
    await act(async () => {
      fireEvent.click(reveal);
    });

    const tokenInput = screen.getByLabelText(
      /\[magnific_token\]/
    ) as HTMLInputElement;
    expect(tokenInput.value).toBe("tok-mag-1");
    expect(
      screen.getByRole("button", { name: /hide token/i })
    ).toBeTruthy();
  });

  it("Magnific tab: renders the four operator-facing webhook URLs as read-only fields built from origin + token", async () => {
    await renderForm();
    clickTab(/^magnific$/i);

    // Four read-only URLs — next-task / submit-result / status /
    // queue-summary — each combining window.location.origin + the
    // current magnific_token. The artifact route is intentionally NOT
    // listed (built per-task by the next-task response).
    const expected = [
      "/api/magnific/next-task/tok-mag-1",
      "/api/magnific/submit-result/tok-mag-1",
      "/api/magnific/status/tok-mag-1",
      "/api/magnific/queue-summary/tok-mag-1",
    ];
    for (const suffix of expected) {
      const matching = screen
        .getAllByDisplayValue((v) => typeof v === "string" && v.endsWith(suffix))
        .filter((el) => (el as HTMLInputElement).readOnly);
      expect(matching.length).toBeGreaterThan(0);
    }

    // Artifact URL must not appear in the operator-pasteable list.
    expect(
      screen.queryByDisplayValue((v) =>
        typeof v === "string" && v.includes("/api/magnific/artifact/")
      )
    ).toBeNull();
  });

  it("Magnific tab: clicking Advanced reveals the dispatch-timeout number input", async () => {
    await renderForm();
    clickTab(/^magnific$/i);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /advanced/i }));
    });

    const timeout = screen.getByLabelText(
      /\[magnific_dispatch_timeout_minutes\]/
    ) as HTMLInputElement;
    expect(timeout).toBeTruthy();
    expect(timeout.value).toBe("30");
  });

  it("Magnific tab: loop seam mitigation fields sit under Advanced and surface their seeded values", async () => {
    await renderForm();
    clickTab(/^magnific$/i);

    // Both fields hidden while Advanced is closed.
    expect(
      screen.queryByLabelText(/\[music_video_loop_trim_tail_seconds\]/)
    ).toBeNull();
    expect(
      screen.queryByLabelText(/\[music_video_loop_xfade_seconds\]/)
    ).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /advanced/i }));
    });

    const trim = screen.getByLabelText(
      /\[music_video_loop_trim_tail_seconds\]/
    ) as HTMLInputElement;
    expect(trim).toBeTruthy();
    expect(trim.value).toBe("0.3");

    const xfade = screen.getByLabelText(
      /\[music_video_loop_xfade_seconds\]/
    ) as HTMLInputElement;
    expect(xfade).toBeTruthy();
    expect(xfade.value).toBe("0.2");
  });

  it("Magnific tab: editing a loop seam field marks the tab dirty and PATCHes the new value", async () => {
    await renderForm();
    clickTab(/^magnific$/i);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /advanced/i }));
    });

    fireEvent.change(
      screen.getByLabelText(/\[music_video_loop_xfade_seconds\]/),
      { target: { value: "0" } }
    );

    expect(tabByName(/^magnific$/i).getAttribute("data-dirty")).toBe("true");

    await clickSave();

    expect(settingsPatchBody()).toEqual({
      music_video_loop_xfade_seconds: 0,
    });
  });

  it("Magnific tab: PATCHes a changed magnific_image_model", async () => {
    await renderForm();
    clickTab(/^magnific$/i);

    fireEvent.change(
      screen.getByLabelText(/\[magnific_image_model\]/),
      { target: { value: "new-image-slug" } }
    );

    expect(tabByName(/^magnific$/i).getAttribute("data-dirty")).toBe("true");

    await clickSave();

    expect(settingsPatchBody()).toEqual({
      magnific_image_model: "new-image-slug",
    });
  });

  it("Magnific tab: regenerate-token POSTs to /api/magnific/regenerate-token, updates the displayed value, and does not leave the tab dirty", async () => {
    await renderForm();
    clickTab(/^magnific$/i);

    // Stage the regenerate response. Magnific tab doesn't fetch on
    // mount, so this one-shot is consumed by the Regenerate click and
    // nothing else.
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementationOnce(
      async () =>
        new Response(JSON.stringify({ token: "freshly-minted-token" }), {
          status: 200,
        })
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /regenerate/i }));
      // Allow the regenerate's `await fetch` + `await res.json()` to
      // settle before act flushes pending React state updates.
      await new Promise((r) => setTimeout(r, 0));
    });

    // The POST landed on the expected URL.
    const regenCall = [...fetchMock.mock.calls].find((c) =>
      (typeof c[0] === "string"
        ? c[0]
        : (c[0] as URL).toString()
      ).includes("/api/magnific/regenerate-token")
    );
    expect(regenCall).toBeTruthy();
    expect((regenCall![1] as RequestInit).method).toBe("POST");

    // Reveal the token and confirm the displayed value updated.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /reveal token/i }));
    });
    const tokenInput = screen.getByLabelText(
      /\[magnific_token\]/
    ) as HTMLInputElement;
    expect(tokenInput.value).toBe("freshly-minted-token");

    // Tab indicator should NOT light up — server already persisted, the
    // dirty-diff baseline was advanced by syncTokenBaseline.
    expect(tabByName(/^magnific$/i).getAttribute("data-dirty")).toBe("false");
  });

  it("renders all four ComfyUI fields on the ComfyUI tab and nothing from other tabs", async () => {
    await renderForm();
    clickTab(/comfyui/i);

    // All ComfyUI-owned fields present.
    expect(screen.getByDisplayValue("comfyui")).toBeTruthy(); // image_provider
    expect(screen.getByDisplayValue("http://127.0.0.1:8188")).toBeTruthy(); // comfyui_base_url
    expect(
      screen.getByDisplayValue("prompts/comfyui/default-workflow.json")
    ).toBeTruthy(); // comfyui_workflow_path
    expect(
      screen.getByDisplayValue(
        "prompts/comfyui/default-hook-video-workflow.json"
      )
    ).toBeTruthy(); // comfyui_hook_video_workflow_path

    // Fields owned by other tabs should not render here.
    expect(
      screen.queryByDisplayValue("anthropic/claude-sonnet-4.6")
    ).toBeNull(); // openrouter_script_model → Script
    expect(screen.queryByDisplayValue("voice-1")).toBeNull(); // voice_id → TTS
    expect(screen.queryByDisplayValue("1920")).toBeNull(); // long_edge_px → Render
    expect(screen.queryByDisplayValue("NARWHAL")).toBeNull(); // Google Flow
  });

  it("Script tab: shows length controls + Provider view dropdown; OpenRouter view active by default", async () => {
    await renderForm();
    // Script tab is the default — no clickTab needed.

    // Length controls.
    expect(screen.getByDisplayValue("90")).toBeTruthy(); // script_length_minutes
    expect(screen.getByDisplayValue("120")).toBeTruthy(); // hook_length_seconds
    expect(screen.getByDisplayValue("8")).toBeTruthy(); // hook_video_clip_seconds

    // The Provider view-filter dropdown is present — its trigger is named
    // exactly "Provider", with no [bracketed_id] suffix because it's local
    // React state, not a persisted setting.
    expect(
      screen.getByRole("combobox", { name: /^provider$/i })
    ).toBeTruthy();

    // Default view = OpenRouter, so its two model TextFields are mounted.
    expect(
      screen.getByLabelText(/\[openrouter_script_model\]/)
    ).toBeTruthy();
    expect(
      screen.getByLabelText(/\[openrouter_visual_model\]/)
    ).toBeTruthy();

    // style_prompt_default has moved to the Visual Style tab.
    expect(screen.queryByLabelText(/\[style_prompt_default\]/)).toBeNull();

    // Claude CLI fields are NOT mounted (off-view).
    expect(
      screen.queryByLabelText(/\[claude_cli_script_model\]/)
    ).toBeNull();
    expect(
      screen.queryByLabelText(/\[claude_cli_visual_model\]/)
    ).toBeNull();
  });

  it("Script tab: OpenRouter view exposes free-form TextFields seeded with the persisted values", async () => {
    await renderForm();

    // Switch away and back to actually exercise the view toggle.
    await pickSelect(/^provider$/i, /Claude CLI/i);
    await pickSelect(/^provider$/i, /OpenRouter/i);

    expect(
      (screen.getByLabelText(
        /\[openrouter_script_model\]/
      ) as HTMLInputElement).value
    ).toBe("anthropic/claude-sonnet-4.6");
    expect(
      (screen.getByLabelText(
        /\[openrouter_visual_model\]/
      ) as HTMLInputElement).value
    ).toBe("anthropic/claude-haiku-4.5");

    // Both inputs are plain free-form text (no dropdown).
    expect(
      (screen.getByLabelText(
        /\[openrouter_script_model\]/
      ) as HTMLInputElement).type
    ).toBe("text");
  });

  it("Visual Style tab renders the gallery (no settings-form fields); other tabs do not", async () => {
    await renderForm();
    clickTab(/visual style/i);

    // Old style_prompt_default textarea is gone — the gallery owns this
    // surface now and talks to /api/visual-styles directly.
    expect(screen.queryByLabelText(/\[style_prompt_default\]/)).toBeNull();
    // Gallery surfaces a "Styles" header in its left rail.
    expect(screen.getByText(/^styles$/i)).toBeTruthy();

    // Gallery should not bleed into the ComfyUI tab.
    clickTab(/comfyui/i);
    expect(screen.queryByText(/^styles$/i)).toBeNull();
  });

  it("renders the bottom Save button on the Visual Style tab (TAB_FIELDS owns the two lock textareas)", async () => {
    // Character-lock + style-lock plan added style_lock_description and
    // character_lock_negative to TAB_FIELDS["visual-style"]. The bottom
    // Save button is gated on TAB_FIELDS[activeTab].length > 0, so it
    // now appears on this tab.
    await renderForm();
    expect(
      screen.getByRole("button", { name: /^save$/i })
    ).toBeTruthy();

    clickTab(/visual style/i);

    const buttons = screen.queryAllByRole("button", { name: /^save$/i });
    const submitButtons = buttons.filter(
      (b) => (b as HTMLButtonElement).type === "submit"
    );
    expect(submitButtons.length).toBeGreaterThan(0);
  });

  it("Script tab: switching the Provider view to Claude CLI reveals the two Claude CLI model TextFields", async () => {
    await renderForm();

    await pickSelect(/^provider$/i, /Claude CLI/i);

    expect(
      screen.getByLabelText(/\[claude_cli_script_model\]/)
    ).toBeTruthy();
    expect(
      screen.getByLabelText(/\[claude_cli_visual_model\]/)
    ).toBeTruthy();

    // OpenRouter fields are no longer mounted on this view.
    expect(
      screen.queryByLabelText(/\[openrouter_script_model\]/)
    ).toBeNull();
    expect(
      screen.queryByLabelText(/\[openrouter_visual_model\]/)
    ).toBeNull();
  });

  it("TTS tab defaults to the Chatterbox view; switching the Provider pill reveals the GenAIPro / AI33 fields", async () => {
    await renderForm();
    clickTab(/^tts$/i);

    // Default view = Chatterbox. AI33/GenAIPro fields are not mounted
    // until the operator switches the Provider pill (a view filter —
    // the active provider per video lives on the workflow row).
    expect(screen.queryByDisplayValue("voice-1")).toBeNull();
    expect(screen.queryByLabelText(/\[voice_speed\]/)).toBeNull();

    // Chatterbox view shows: connection fields + tuning sliders.
    expect(screen.getByDisplayValue("http://127.0.0.1:8004")).toBeTruthy(); // chatterbox_base_url
    expect(
      screen.getByRole("combobox", { name: /chatterbox_voice_mode/i })
    ).toBeTruthy();
    expect(screen.getByLabelText(/\[chatterbox_voice_filename\]/)).toBeTruthy();
    expect(screen.getByLabelText(/\[chatterbox_speed_factor\]/)).toBeTruthy();

    // Flip the Provider pill — Chatterbox fields hide, AI33/GenAIPro
    // fields appear. The pill is a role="tablist" with two role="tab"
    // buttons, activated on plain click (not the mouseDown gesture Radix
    // Tabs requires for the outer settings tab strip).
    await act(async () => {
      fireEvent.click(
        screen.getByRole("tab", { name: /GenAIPro \/ AI33/i })
      );
    });

    expect(screen.queryByLabelText(/\[chatterbox_voice_filename\]/)).toBeNull();
    expect(screen.getByDisplayValue("voice-1")).toBeTruthy(); // voice_id
    expect(screen.getByDisplayValue("eleven_multilingual_v2")).toBeTruthy(); // voiceover_model_id
    expect(
      (screen.getByLabelText(/\[voice_stability\]/) as HTMLInputElement).value
    ).toBe("0.75");
    expect(
      (screen.getByLabelText(/\[voice_similarity\]/) as HTMLInputElement).value
    ).toBe("0.5");
    expect(
      (screen.getByLabelText(/\[voice_style\]/) as HTMLInputElement).value
    ).toBe("0");
    expect(
      (screen.getByLabelText(/\[voice_speed\]/) as HTMLInputElement).value
    ).toBe("1");

    const boostCheckbox = screen.getByRole("checkbox", {
      name: /voice_use_speaker_boost/i,
    });
    expect(boostCheckbox.getAttribute("aria-checked")).toBe("true");
  });

  it("Chatterbox voice_mode dropdown shows both labels (Predefined voice / Clone reference)", async () => {
    await renderForm();
    clickTab(/^tts$/i);

    const trigger = screen.getByRole("combobox", {
      name: /chatterbox_voice_mode/i,
    });
    expect(trigger.textContent).toMatch(/Predefined voice/);

    await act(async () => {
      trigger.focus();
      fireEvent.keyDown(trigger, { key: "Enter", code: "Enter" });
    });

    expect(
      await screen.findByRole("option", { name: /Predefined voice/ })
    ).toBeTruthy();
    expect(
      screen.getByRole("option", { name: /Clone reference/ })
    ).toBeTruthy();
  });

  it("renders helper text under chatterbox_voice_filename explaining voices/ vs reference_audio/", async () => {
    await renderForm();
    clickTab(/^tts$/i);

    // Helper text wraps `voices/` and `reference_audio/` in <code> tags,
    // so the literal text spans nested elements. Match on the <p>'s
    // collapsed textContent rather than a single text-node.
    const helper = screen
      .getAllByText((_content, el) =>
        /voices\/.*reference_audio\//i.test(
          el?.textContent?.replace(/\s+/g, " ") ?? ""
        )
      )
      .find((el) => el.tagName === "P");
    expect(helper).toBeTruthy();
  });

  it("renders four Chatterbox tuning sliders with the seeded default values", async () => {
    await renderForm();
    clickTab(/^tts$/i);

    const tempSlider = screen.getByLabelText(
      /\[chatterbox_temperature\]/
    ) as HTMLInputElement;
    expect(tempSlider.type).toBe("range");
    expect(tempSlider.value).toBe("0.8");
    expect(tempSlider.min).toBe("0");
    expect(tempSlider.max).toBe("1.5");
    expect(tempSlider.step).toBe("0.01");

    const exagSlider = screen.getByLabelText(
      /\[chatterbox_exaggeration\]/
    ) as HTMLInputElement;
    expect(exagSlider.type).toBe("range");
    expect(exagSlider.value).toBe("0.5");
    expect(exagSlider.min).toBe("0");
    expect(exagSlider.max).toBe("2");
    expect(exagSlider.step).toBe("0.01");

    const cfgSlider = screen.getByLabelText(
      /\[chatterbox_cfg_weight\]/
    ) as HTMLInputElement;
    expect(cfgSlider.type).toBe("range");
    expect(cfgSlider.value).toBe("0.5");
    expect(cfgSlider.min).toBe("0");
    expect(cfgSlider.max).toBe("2");
    expect(cfgSlider.step).toBe("0.01");

    const speedSlider = screen.getByLabelText(
      /\[chatterbox_speed_factor\]/
    ) as HTMLInputElement;
    expect(speedSlider.type).toBe("range");
    expect(speedSlider.value).toBe("1");
    expect(speedSlider.min).toBe("0.25");
    expect(speedSlider.max).toBe("4");
    expect(speedSlider.step).toBe("0.05");
  });

  it("flags the TTS tab dirty when a Chatterbox tuning slider changes", async () => {
    await renderForm();
    clickTab(/^tts$/i);

    fireEvent.change(screen.getByLabelText(/\[chatterbox_temperature\]/), {
      target: { value: "1.2" },
    });

    expect(tabByName(/^tts$/i).getAttribute("data-dirty")).toBe("true");
  });

  it("PATCHes the changed Chatterbox tuning slider value", async () => {
    await renderForm();
    clickTab(/^tts$/i);

    fireEvent.change(screen.getByLabelText(/\[chatterbox_exaggeration\]/), {
      target: { value: "0.75" },
    });

    await clickSave();

    expect(settingsPatchBody()).toEqual({ chatterbox_exaggeration: 0.75 });
  });

  it("renders the Render fields when the Render tab is active", async () => {
    await renderForm();
    clickTab(/render/i);

    expect(screen.getByDisplayValue("16:9")).toBeTruthy(); // aspect_ratio
    expect(screen.getByDisplayValue("1920")).toBeTruthy(); // long_edge_px
    expect(screen.getByDisplayValue("30")).toBeTruthy(); // framerate
  });

  it("renders the Script length fields by default", async () => {
    await renderForm();
    // Script is the default tab.

    expect(screen.getByDisplayValue("90")).toBeTruthy(); // script_length_minutes
    expect(screen.getByDisplayValue("120")).toBeTruthy(); // hook_length_seconds
    expect(screen.getByDisplayValue("8")).toBeTruthy(); // hook_video_clip_seconds
  });

  it("renders the image_model dropdown with display labels for all three models", async () => {
    await renderForm();
    clickTab(/google flow/i);

    // Trigger shows the display label for the seeded NARWHAL value.
    const trigger = screen.getByRole("combobox", {
      name: /google_flow_image_model/i,
    });
    expect(trigger.textContent).toMatch(/Nano Banana 2/);

    // Open the popover and assert all three labels are present.
    await act(async () => {
      trigger.focus();
      fireEvent.keyDown(trigger, { key: "Enter", code: "Enter" });
    });
    expect(
      await screen.findByRole("option", { name: /Nano Banana 2/ })
    ).toBeTruthy();
    expect(
      screen.getByRole("option", { name: /Nano Banana Pro/ })
    ).toBeTruthy();
    expect(screen.getByRole("option", { name: /Imagen 4/ })).toBeTruthy();
  });

  it("renders the video_model dropdown with display labels for all four Veo variants", async () => {
    await renderForm();
    clickTab(/google flow/i);

    const trigger = screen.getByRole("combobox", {
      name: /google_flow_video_model/i,
    });
    // Default is veo_3_1_t2v_lite_low_priority → "Veo 3.1 - Lite [Lower Priority]"
    expect(trigger.textContent).toMatch(/Veo 3\.1 - Lite \[Lower Priority\]/);

    await act(async () => {
      trigger.focus();
      fireEvent.keyDown(trigger, { key: "Enter", code: "Enter" });
    });
    // findByRole waits for the popover to render after the open transition.
    expect(
      await screen.findByRole("option", { name: /^Veo 3\.1 - Lite$/ })
    ).toBeTruthy();
    expect(
      screen.getByRole("option", { name: /^Veo 3\.1 - Fast$/ })
    ).toBeTruthy();
    expect(
      screen.getByRole("option", { name: /^Veo 3\.1 - Quality$/ })
    ).toBeTruthy();
    expect(
      screen.getByRole("option", {
        name: /^Veo 3\.1 - Lite \[Lower Priority\]$/,
      })
    ).toBeTruthy();
  });

  it("PATCHes the storage value (not the display label) when picking an image model", async () => {
    await renderForm();
    clickTab(/google flow/i);

    await pickSelect(/google_flow_image_model/i, /Nano Banana Pro/);
    await clickSave();

    expect(settingsPatchBody()).toEqual({
      google_flow_image_model: "GEM_PIX_2",
    });
  });

  it("PATCHes the storage key when picking a video model", async () => {
    await renderForm();
    clickTab(/google flow/i);

    await pickSelect(/google_flow_video_model/i, /^Veo 3\.1 - Fast$/);
    await clickSave();

    expect(settingsPatchBody()).toEqual({
      google_flow_video_model: "veo_3_1_t2v_fast_ultra",
    });
  });

  it("renders the google_flow_hook_clip_seconds dropdown with default '8' and the 4/6/8 options", async () => {
    await renderForm();
    clickTab(/google flow/i);

    const trigger = screen.getByRole("combobox", {
      name: /google_flow_hook_clip_seconds/i,
    });
    // Default storage value "8" doubles as its own display label (no
    // label override registered for this enum).
    expect(trigger.textContent).toMatch(/^8$/);

    await act(async () => {
      trigger.focus();
      fireEvent.keyDown(trigger, { key: "Enter", code: "Enter" });
    });
    expect(await screen.findByRole("option", { name: /^4$/ })).toBeTruthy();
    expect(screen.getByRole("option", { name: /^6$/ })).toBeTruthy();
    expect(screen.getByRole("option", { name: /^8$/ })).toBeTruthy();
  });

  it("PATCHes the storage value when picking a different hook clip seconds", async () => {
    await renderForm();
    clickTab(/google flow/i);

    await pickSelect(/google_flow_hook_clip_seconds/i, /^4$/);
    await clickSave();

    expect(settingsPatchBody()).toEqual({
      google_flow_hook_clip_seconds: "4",
    });
  });

  it("no longer renders the legacy google_flow_video_quality dropdown", async () => {
    await renderForm();
    clickTab(/google flow/i);

    expect(
      screen.queryByRole("combobox", { name: /google_flow_video_quality/i })
    ).toBeNull();
  });

  it("hides the four ops-tuning fields under a collapsed Advanced section by default", async () => {
    await renderForm();
    clickTab(/google flow/i);

    // The Advanced trigger is visible; its content is unmounted while
    // collapsed (Radix Presence default), so the four advanced fields
    // are absent from the DOM until the user expands the section.
    expect(
      screen.getByRole("button", { name: /advanced/i })
    ).toBeTruthy();
    expect(
      screen.queryByLabelText(/\[google_flow_relogin_needed\]/)
    ).toBeNull();
    expect(
      screen.queryByLabelText(/\[google_flow_account_cooldown_hours\]/)
    ).toBeNull();
    expect(
      screen.queryByLabelText(/\[google_flow_max_retries\]/)
    ).toBeNull();
    expect(
      screen.queryByLabelText(/\[google_flow_dispatch_timeout_minutes\]/)
    ).toBeNull();
  });

  it("clicking Advanced reveals the four ops-tuning fields with relogin_needed read-only", async () => {
    await renderForm();
    clickTab(/google flow/i);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /advanced/i }));
    });

    expect(
      screen.getByLabelText(/\[google_flow_account_cooldown_hours\]/)
    ).toBeTruthy();
    expect(
      screen.getByLabelText(/\[google_flow_max_retries\]/)
    ).toBeTruthy();
    expect(
      screen.getByLabelText(/\[google_flow_dispatch_timeout_minutes\]/)
    ).toBeTruthy();

    const indicator = screen.getByLabelText(
      /\[google_flow_relogin_needed\]/
    ) as HTMLInputElement;
    expect(indicator.readOnly).toBe(true);
  });

  it("flags the Google Flow tab dirty when an Advanced field changes (TAB_FIELDS still tracks them)", async () => {
    await renderForm();
    clickTab(/google flow/i);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /advanced/i }));
    });

    fireEvent.change(
      screen.getByLabelText(/\[google_flow_max_retries\]/),
      { target: { value: "5" } }
    );

    expect(tabByName(/google flow/i).getAttribute("data-dirty")).toBe("true");
  });

  it("preserves an unsaved change on one tab after switching to another and back", async () => {
    await renderForm();
    // Script is the default tab — OpenRouter view is active, so
    // openrouter_script_model is already mounted.
    fireEvent.change(
      screen.getByLabelText(/\[openrouter_script_model\]/),
      { target: { value: "anthropic/claude-haiku-4.5" } }
    );

    clickTab(/render/i);
    clickTab(/^script$/i);

    expect(
      (screen.getByLabelText(
        /\[openrouter_script_model\]/
      ) as HTMLInputElement).value
    ).toBe("anthropic/claude-haiku-4.5");
  });
});

describe("SettingsForm dirty-diff PATCH", () => {
  it("PATCHes only the changed field on the active tab", async () => {
    await renderForm();
    // Script is the default tab; OpenRouter view is mounted by default.
    fireEvent.change(
      screen.getByLabelText(/\[openrouter_script_model\]/),
      { target: { value: "anthropic/claude-haiku-4.5" } }
    );

    await clickSave();

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/settings");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({
      openrouter_script_model: "anthropic/claude-haiku-4.5",
    });
  });

  it("skips the PATCH entirely when nothing has changed", async () => {
    await renderForm();
    await clickSave();

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("PATCHes dirty fields from multiple tabs in a single request", async () => {
    await renderForm();

    // Script tab (default) — change openrouter_script_model.
    fireEvent.change(
      screen.getByLabelText(/\[openrouter_script_model\]/),
      { target: { value: "anthropic/claude-haiku-4.5" } }
    );

    clickTab(/render/i);
    fireEvent.change(screen.getByDisplayValue("1920"), {
      target: { value: "2560" },
    });

    await clickSave();

    const body = settingsPatchBody() as Record<string, unknown>;
    expect(body).toMatchObject({
      openrouter_script_model: "anthropic/claude-haiku-4.5",
      long_edge_px: 2560,
    });
  });

  it("PATCHes a changed claude_cli_script_model on the Script tab's Claude CLI view", async () => {
    await renderForm();
    // Script is the default tab; switch the Provider view to Claude CLI.
    await pickSelect(/^provider$/i, /Claude CLI/i);

    fireEvent.change(
      screen.getByLabelText(/\[claude_cli_script_model\]/),
      { target: { value: "claude-sonnet-4.6" } }
    );
    await clickSave();

    expect(settingsPatchBody()).toEqual({
      claude_cli_script_model: "claude-sonnet-4.6",
    });
  });

  it("PATCHes a changed comfyui_base_url on the ComfyUI tab", async () => {
    await renderForm();
    clickTab(/comfyui/i);

    fireEvent.change(screen.getByDisplayValue("http://127.0.0.1:8188"), {
      target: { value: "http://192.168.1.50:8188" },
    });

    await clickSave();

    expect(settingsPatchBody()).toEqual({
      comfyui_base_url: "http://192.168.1.50:8188",
    });
  });
});

describe("SettingsForm dirty indicator", () => {
  it("marks only the tab that owns a changed field as dirty", async () => {
    await renderForm();
    // Script is the default tab; OpenRouter view is mounted by default.
    fireEvent.change(
      screen.getByLabelText(/\[openrouter_script_model\]/),
      { target: { value: "anthropic/claude-haiku-4.5" } }
    );

    expect(tabByName(/^script$/i).getAttribute("data-dirty")).toBe("true");
    expect(tabByName(/^tts$/i).getAttribute("data-dirty")).toBe("false");
    expect(tabByName(/render/i).getAttribute("data-dirty")).toBe("false");
    expect(tabByName(/comfyui/i).getAttribute("data-dirty")).toBe("false");
    expect(tabByName(/visual style/i).getAttribute("data-dirty")).toBe(
      "false"
    );
  });

  it("clears the dirty indicator after a successful save", async () => {
    await renderForm();

    fireEvent.change(
      screen.getByLabelText(/\[openrouter_script_model\]/),
      { target: { value: "anthropic/claude-haiku-4.5" } }
    );
    expect(tabByName(/^script$/i).getAttribute("data-dirty")).toBe("true");

    await clickSave();

    expect(tabByName(/^script$/i).getAttribute("data-dirty")).toBe("false");
  });

  it("flags the Script tab dirty when a Claude CLI model field changes (TAB_FIELDS tracks both providers under Script)", async () => {
    await renderForm();

    await pickSelect(/^provider$/i, /Claude CLI/i);
    fireEvent.change(
      screen.getByLabelText(/\[claude_cli_script_model\]/),
      { target: { value: "claude-sonnet-4.6" } }
    );

    expect(tabByName(/^script$/i).getAttribute("data-dirty")).toBe("true");
  });
});
