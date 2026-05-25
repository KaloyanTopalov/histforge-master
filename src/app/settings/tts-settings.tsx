"use client";

import { useState } from "react";
import type { AllSettings } from "@/lib/settings";
import { enumOptions } from "@/lib/settings-enums";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AudioLines,
  Mic,
  Server,
  SlidersHorizontal,
  Waves,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface TtsSettingsProps {
  values: AllSettings;
  update: <K extends keyof AllSettings>(key: K, value: AllSettings[K]) => void;
}

type ProviderView = "chatterbox" | "elevenlabs";

const PROVIDER_VIEW_OPTIONS: ReadonlyArray<{
  value: ProviderView;
  label: string;
}> = [
  { value: "chatterbox", label: "Chatterbox" },
  { value: "elevenlabs", label: "GenAIPro / AI33" },
];

// Field chrome for the TTS tab. Light: emerald hairline on white.
// Dark: sunken warm-graphite well — darker than the surrounding panel
// (depth via L-value, not just border), with a near-neutral hairline
// that lets emerald arrive only at focus. Faint green undertone keeps
// the substrate from fighting the accent, without flooding the surface.
const EMERALD_FIELD =
  "border-emerald-300/60 focus:ring-emerald-500/45 focus-visible:ring-emerald-500/45 " +
  "dark:border-[hsl(225_22%_18%)] dark:bg-[hsl(228_25%_6%)] " +
  "dark:text-[hsl(220_8%_92%)] dark:placeholder:text-[hsl(220_8%_45%)] " +
  "dark:focus:border-emerald-400/55 dark:focus-visible:ring-emerald-400/35 " +
  "dark:hover:border-[hsl(225_22%_24%)]";

/**
 * TTS settings panel — "Stillwater" emerald theme. The top-of-panel
 * Provider control is a view filter (the active provider per video is
 * set on the workflow row, `workflows.tts_provider`); switching here
 * just toggles which tuning surface is shown. Chatterbox drives the
 * local synchronous sidecar; the GenAIPro / AI33 view drives the two
 * ElevenLabs-shaped HTTP providers (they share every tuning key, so
 * they collapse into one form).
 */
export function TtsSettings({
  values,
  update,
}: TtsSettingsProps): JSX.Element {
  const [view, setView] = useState<ProviderView>("chatterbox");

  return (
    <div className="relative">
      {/* Eyebrow band — Waves icon, "Voice Synthesis" eyebrow, hairline
          divider that fades into a faint emerald rim on dark. */}
      <header className="mb-7">
        <div className="flex items-center gap-3">
          <span
            aria-hidden="true"
            className="grid h-7 w-7 place-items-center rounded-full border border-emerald-300/55 bg-white shadow-sm dark:border-emerald-500/30 dark:bg-[hsl(228_22%_9%)] dark:shadow-[inset_0_1px_0_hsl(222_25%_26%/0.4),0_0_18px_-6px_hsl(160_70%_45%/0.35)]"
          >
            <Waves className="h-3.5 w-3.5 text-emerald-700 dark:text-emerald-300" />
          </span>
          <span className="text-[11px] font-semibold uppercase tracking-[0.24em] text-emerald-800/85 dark:text-emerald-200/90">
            Voice Synthesis
          </span>
          <span
            aria-hidden="true"
            className="h-px flex-1 bg-gradient-to-r from-border via-emerald-500/15 to-transparent dark:from-[hsl(222_20%_22%)] dark:via-emerald-400/15"
          />
        </div>
        <p className="ml-10 mt-2 max-w-prose text-[13px] leading-relaxed text-muted-foreground dark:text-[hsl(220_8%_68%)]">
          Tune the cadence, breath, and timbre of the narrator. Each provider
          carries its own tuning surface — switch below to view its controls.
        </p>
      </header>

      {/* Pill segmented provider view filter. Replaces a dropdown — the
          two-state choice deserves a single, calm gesture, not a menu. */}
      <div className="flex flex-wrap items-center gap-3">
        <Label
          id="tts_provider_view_label"
          className="text-[11px] font-semibold uppercase tracking-[0.18em] text-foreground/85 dark:text-[hsl(220_8%_80%)]"
        >
          Provider
        </Label>
        <ProviderSwitch value={view} onChange={setView} />
      </div>

      <div className="mt-8 space-y-8">
        {view === "chatterbox" ? (
          <ChatterboxView values={values} update={update} />
        ) : (
          <ElevenLabsView values={values} update={update} />
        )}
      </div>
    </div>
  );
}

// ─── Provider pill switch ──────────────────────────────────────────────

function ProviderSwitch({
  value,
  onChange,
}: {
  value: ProviderView;
  onChange: (v: ProviderView) => void;
}): JSX.Element {
  return (
    <div
      role="tablist"
      aria-labelledby="tts_provider_view_label"
      className={cn(
        "inline-flex rounded-full p-1 transition-colors",
        "border border-emerald-200/70 bg-gradient-to-br from-emerald-50/80 via-white/60 to-emerald-100/40 shadow-[inset_0_1px_0_rgba(255,255,255,0.7)]",
        "dark:border-[hsl(225_22%_18%)] dark:bg-gradient-to-br dark:from-[hsl(228_22%_9%)] dark:via-[hsl(228_22%_7%)] dark:to-[hsl(228_22%_8%)] dark:shadow-[inset_0_1px_0_hsl(222_25%_24%/0.35)]"
      )}
    >
      {PROVIDER_VIEW_OPTIONS.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(o.value)}
            className={cn(
              "rounded-full px-5 py-1.5 text-[13px] font-medium tracking-wide transition-all duration-300",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
              active
                ? "bg-gradient-to-br from-emerald-500 to-emerald-600 text-white shadow-[0_6px_16px_-6px_rgba(16,185,129,0.55),inset_0_1px_0_rgba(255,255,255,0.25)] dark:from-emerald-400 dark:to-emerald-600 dark:text-[hsl(160_30%_8%)] dark:shadow-[0_8px_20px_-8px_hsl(160_70%_45%/0.5),inset_0_1px_0_hsl(160_60%_75%/0.45)]"
                : "text-foreground/55 hover:text-emerald-900/85 dark:text-[hsl(220_8%_60%)] dark:hover:text-emerald-200"
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// ─── Chatterbox view ───────────────────────────────────────────────────

function ChatterboxView({
  values,
  update,
}: TtsSettingsProps): JSX.Element {
  return (
    <div className="space-y-8">
      <EmeraldSection title="Chatterbox" accent={<Server className="h-3.5 w-3.5" />}>
        <div className="grid gap-5 sm:grid-cols-2">
          <FieldShell
            id="chatterbox_base_url"
            label="Base URL"
            hint={
              <>
                Devnen sidecar (default port <code className="font-mono">8004</code>),
                used by the <code className="font-mono">chatterbox</code> workflow provider.
              </>
            }
          >
            <Input
              id="chatterbox_base_url"
              value={values.chatterbox_base_url}
              onChange={(e) => update("chatterbox_base_url", e.target.value)}
              placeholder="http://127.0.0.1:8004"
              className={cn(EMERALD_FIELD, "font-mono text-sm")}
            />
          </FieldShell>
          <FieldShell
            id="chatterbox_fast_base_url"
            label="Fast Base URL"
            hint={
              <>
                Parallel sidecar (default port <code className="font-mono">8005</code>),
                used by the <code className="font-mono">chatterbox-fast</code> workflow provider.
                Both sidecars can run side-by-side.
              </>
            }
          >
            <Input
              id="chatterbox_fast_base_url"
              value={values.chatterbox_fast_base_url}
              onChange={(e) =>
                update("chatterbox_fast_base_url", e.target.value)
              }
              placeholder="http://127.0.0.1:8005"
              className={cn(EMERALD_FIELD, "font-mono text-sm")}
            />
          </FieldShell>
          <FieldShell id="chatterbox_voice_mode" label="Voice Mode">
            <Select
              value={values.chatterbox_voice_mode}
              onValueChange={(v) =>
                update(
                  "chatterbox_voice_mode",
                  v as AllSettings["chatterbox_voice_mode"]
                )
              }
            >
              <SelectTrigger
                id="chatterbox_voice_mode"
                className={cn(EMERALD_FIELD, "font-mono text-sm")}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {enumOptions("chatterbox_voice_mode").map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FieldShell>
          <div className="sm:col-span-2">
            <FieldShell
              id="chatterbox_voice_filename"
              label="Voice Filename"
              hint={
                <>
                  Filename in the Chatterbox server&apos;s{" "}
                  <code className="font-mono">voices/</code> (predefined) or{" "}
                  <code className="font-mono">reference_audio/</code> (clone)
                  directory.
                </>
              }
            >
              <Input
                id="chatterbox_voice_filename"
                value={values.chatterbox_voice_filename}
                onChange={(e) =>
                  update("chatterbox_voice_filename", e.target.value)
                }
                placeholder="e.g. Abigail.wav"
                className={cn(EMERALD_FIELD, "font-mono text-sm")}
              />
            </FieldShell>
          </div>
        </div>
      </EmeraldSection>

      <EmeraldSection
        title="Chatterbox Tuning"
        accent={<SlidersHorizontal className="h-3.5 w-3.5" />}
      >
        <div className="space-y-6">
          <VoiceSlider
            id="chatterbox_temperature"
            label="Temperature"
            description="Sampling randomness. Higher = more variation."
            min={0}
            max={1.5}
            step={0.01}
            value={values.chatterbox_temperature}
            onChange={(v) => update("chatterbox_temperature", v)}
          />
          <VoiceSlider
            id="chatterbox_exaggeration"
            label="Exaggeration"
            description="Emotion intensity. Higher = more theatrical."
            min={0}
            max={2}
            step={0.01}
            value={values.chatterbox_exaggeration}
            onChange={(v) => update("chatterbox_exaggeration", v)}
          />
          <VoiceSlider
            id="chatterbox_cfg_weight"
            label="CFG Weight"
            description="Pace control. Higher = tighter adherence to the reference."
            min={0}
            max={2}
            step={0.01}
            value={values.chatterbox_cfg_weight}
            onChange={(v) => update("chatterbox_cfg_weight", v)}
          />
          <VoiceSlider
            id="chatterbox_speed_factor"
            label="Speed Factor"
            description="Playback rate. 1.0 is natural pace. Honored by both Chatterbox providers — devnen applies it server-side, the fast sidecar leaves it to ffmpeg atempo in the WAV→MP3 transcode."
            min={0.25}
            max={4}
            step={0.05}
            value={values.chatterbox_speed_factor}
            onChange={(v) => update("chatterbox_speed_factor", v)}
            ticks={[0.25, 1.0, 4]}
          />
        </div>
      </EmeraldSection>

      <EmeraldSection
        title="Chatterbox Fast — Parallelism & Chunking"
        accent={<SlidersHorizontal className="h-3.5 w-3.5" />}
      >
        <div className="space-y-6">
          <VoiceSlider
            id="chatterbox_fast_workers"
            label="Workers"
            description="Per-request parallelism on the fast sidecar. No restart needed — sent on every /tts/batch call. Clamped to 1–4 server-side."
            min={1}
            max={4}
            step={1}
            value={values.chatterbox_fast_workers}
            onChange={(v) => update("chatterbox_fast_workers", v)}
            ticks={[1, 2, 4]}
          />
          <VoiceSlider
            id="chatterbox_fast_silence_ms"
            label="Silence (ms)"
            description="Digital silence inserted between chunks at concatenation. Masks sentence-boundary seams; 150 ms is a safe default."
            min={0}
            max={1000}
            step={10}
            value={values.chatterbox_fast_silence_ms}
            onChange={(v) => update("chatterbox_fast_silence_ms", v)}
            ticks={[0, 150, 1000]}
          />
          <VoiceSlider
            id="chatterbox_fast_max_chunk_chars"
            label="Max Chunk Chars"
            description="Sentence-grouping budget. Smaller = more parallelism but more joins. 300 is the recommended starting point."
            min={100}
            max={2000}
            step={10}
            value={values.chatterbox_fast_max_chunk_chars}
            onChange={(v) => update("chatterbox_fast_max_chunk_chars", v)}
            ticks={[100, 300, 2000]}
          />
        </div>
      </EmeraldSection>
    </div>
  );
}

// ─── GenAIPro / AI33 view ──────────────────────────────────────────────

function ElevenLabsView({
  values,
  update,
}: TtsSettingsProps): JSX.Element {
  return (
    <div className="space-y-8">
      <EmeraldSection title="Voice & Model" accent={<Mic className="h-3.5 w-3.5" />}>
        <div className="grid gap-5 sm:grid-cols-2">
          <FieldShell id="voice_id" label="Voice ID">
            <Input
              id="voice_id"
              value={values.voice_id}
              onChange={(e) => update("voice_id", e.target.value)}
              placeholder="ElevenLabs-compatible voice ID"
              className={cn(EMERALD_FIELD, "font-mono text-sm")}
            />
          </FieldShell>
          <FieldShell id="voiceover_model_id" label="Voiceover Model">
            <Select
              value={values.voiceover_model_id}
              onValueChange={(v) =>
                update(
                  "voiceover_model_id",
                  v as AllSettings["voiceover_model_id"]
                )
              }
            >
              <SelectTrigger
                id="voiceover_model_id"
                className={cn(EMERALD_FIELD, "font-mono text-sm")}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {enumOptions("voiceover_model_id").map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FieldShell>
        </div>
      </EmeraldSection>

      <EmeraldSection
        title="Voice Tuning"
        accent={<SlidersHorizontal className="h-3.5 w-3.5" />}
      >
        <div className="space-y-6">
          <VoiceSlider
            id="voice_stability"
            label="Stability"
            description="Higher = consistent. Lower = expressive."
            min={0}
            max={1}
            step={0.01}
            value={values.voice_stability}
            onChange={(v) => update("voice_stability", v)}
          />
          <VoiceSlider
            id="voice_similarity"
            label="Similarity"
            description="Closeness to the source voice clone."
            min={0}
            max={1}
            step={0.01}
            value={values.voice_similarity}
            onChange={(v) => update("voice_similarity", v)}
          />
          <VoiceSlider
            id="voice_style"
            label="Style"
            description="Preserve speaker style and intonation."
            min={0}
            max={1}
            step={0.01}
            value={values.voice_style}
            onChange={(v) => update("voice_style", v)}
          />
          <VoiceSlider
            id="voice_speed"
            label="Speed"
            description="Playback rate. Centre is natural."
            min={0.7}
            max={1.2}
            step={0.01}
            value={values.voice_speed}
            onChange={(v) => update("voice_speed", v)}
            ticks={[0.7, 1.0, 1.2]}
          />
        </div>
      </EmeraldSection>

      <EmeraldSection title="Mix" accent={<AudioLines className="h-3.5 w-3.5" />}>
        <BoostRow
          value={values.voice_use_speaker_boost}
          onChange={(v) => update("voice_use_speaker_boost", v)}
        />
      </EmeraldSection>
    </div>
  );
}

// ─── Section primitive (emerald-tinted, local to the TTS tab) ──────────

function EmeraldSection({
  title,
  accent,
  children,
}: {
  title: string;
  accent: React.ReactNode;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className="inline-block h-5 w-1 rounded-full bg-gradient-to-b from-emerald-300 to-emerald-600 shadow-[0_0_8px_-1px_rgba(16,185,129,0.45)] dark:from-emerald-300 dark:to-emerald-500 dark:shadow-[0_0_12px_-1px_hsl(160_70%_45%/0.6)]"
        />
        <h3 className="text-[11px] font-bold uppercase tracking-[0.18em] text-emerald-900/85 dark:text-emerald-100/90">
          {title}
        </h3>
        <span className="text-emerald-700/70 dark:text-emerald-300/80">
          {accent}
        </span>
        <span
          aria-hidden="true"
          className="h-px flex-1 bg-gradient-to-r from-border to-transparent dark:from-[hsl(222_20%_22%)]"
        />
      </div>
      <EmeraldPanel>{children}</EmeraldPanel>
    </section>
  );
}

// Warm-graphite well. Light: unchanged slate. Dark: sunken substrate sitting
// distinctly below the outer Card (Card runs L≈9–14%; this well runs L≈3–5%),
// so each section reads as a clearly bounded region rather than blending into
// the panel above. Warm-graphite hue family (225–228°, low saturation) and a
// soft inner top highlight preserve tactile depth without fighting the
// emerald accents that live on its surface.
function EmeraldPanel({
  children,
}: {
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div
      className={cn(
        "rounded-xl border bg-slate-100 p-5 border-slate-200",
        "dark:border-[hsl(225_22%_14%)] dark:bg-gradient-to-b dark:from-[hsl(225_25%_5%)] dark:to-[hsl(228_25%_3%)]",
        "dark:shadow-[inset_0_1px_0_hsl(222_25%_20%/0.4),0_1px_0_hsl(0_0%_0%/0.55)]"
      )}
    >
      {children}
    </div>
  );
}

// ─── Field shell ───────────────────────────────────────────────────────

function FieldShell({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-sm font-medium text-foreground/85 dark:text-[hsl(220_8%_88%)]">
          {label}
        </span>
        <span className="font-mono text-[11px] font-normal text-muted-foreground/70 dark:text-[hsl(220_8%_50%)]">
          [{id}]
        </span>
      </Label>
      {children}
      {hint !== undefined && (
        <p className="text-xs text-muted-foreground dark:text-[hsl(220_8%_62%)]">
          {hint}
        </p>
      )}
    </div>
  );
}

// ─── Voice slider ──────────────────────────────────────────────────────

function VoiceSlider({
  id,
  label,
  description,
  min,
  max,
  step,
  value,
  onChange,
  ticks,
}: {
  id: string;
  label: string;
  description: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (value: number) => void;
  ticks?: readonly number[];
}): JSX.Element {
  const range = max - min || 1;
  const pct = Math.max(0, Math.min(100, ((value - min) / range) * 100));
  const tickList = ticks ?? [min, (min + max) / 2, max];
  const decimals = step < 1 ? 2 : 0;

  // Filled portion: jade-200 → emerald-500 horizontal gradient. Unfilled
  // tone comes from `--tts-track-empty`, defined on the input element via
  // Tailwind arbitrary properties — a light wash on light theme, a dark
  // mossy channel on dark, so the rail reads correctly against either
  // panel substrate without inline theme detection.
  const trackBg =
    `linear-gradient(to right, ` +
    `hsl(158 64% 58%) 0%, ` +
    `hsl(160 75% 42%) ${pct}%, ` +
    `var(--tts-track-empty) ${pct}%, ` +
    `var(--tts-track-empty) 100%)`;

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <Label
          htmlFor={id}
          className="flex flex-wrap items-baseline gap-x-2 cursor-pointer"
        >
          <span className="text-sm font-medium dark:text-[hsl(220_8%_88%)]">
            {label}
          </span>
          <span className="font-mono text-[10px] font-normal text-muted-foreground/70 dark:text-[hsl(220_8%_50%)]">
            [{id}]
          </span>
        </Label>
        <p className="hidden text-xs text-muted-foreground sm:block dark:text-[hsl(220_8%_62%)]">
          {description}
        </p>
      </div>
      <div className="flex items-center gap-3">
        <div className="relative flex-1 pb-4">
          <input
            id={id}
            type="range"
            min={min}
            max={max}
            step={step}
            value={value}
            onChange={(e) => onChange(parseFloat(e.target.value))}
            style={{ background: trackBg }}
            className={cn(
              "h-1.5 w-full cursor-pointer appearance-none rounded-full",
              "[--tts-track-empty:hsl(160_30%_88%/0.55)] dark:[--tts-track-empty:hsl(228_20%_18%)]",
              "dark:shadow-[inset_0_1px_2px_hsl(0_0%_0%/0.4)]",
              "focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/45 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
              "[&::-webkit-slider-thumb]:appearance-none",
              "[&::-webkit-slider-thumb]:h-4",
              "[&::-webkit-slider-thumb]:w-4",
              "[&::-webkit-slider-thumb]:rounded-full",
              "[&::-webkit-slider-thumb]:bg-white",
              "[&::-webkit-slider-thumb]:border-2",
              "[&::-webkit-slider-thumb]:border-emerald-600",
              "[&::-webkit-slider-thumb]:shadow-[0_2px_8px_-2px_rgba(16,185,129,0.5)]",
              "[&::-webkit-slider-thumb]:transition-transform",
              "[&::-webkit-slider-thumb]:hover:scale-110",
              "[&::-webkit-slider-thumb]:active:scale-95",
              "dark:[&::-webkit-slider-thumb]:bg-[hsl(220_8%_95%)]",
              "dark:[&::-webkit-slider-thumb]:border-emerald-400",
              "dark:[&::-webkit-slider-thumb]:shadow-[0_0_0_1px_hsl(228_22%_8%),0_2px_12px_-2px_hsl(160_75%_45%/0.6)]",
              "[&::-moz-range-thumb]:h-4",
              "[&::-moz-range-thumb]:w-4",
              "[&::-moz-range-thumb]:rounded-full",
              "[&::-moz-range-thumb]:bg-white",
              "[&::-moz-range-thumb]:border-2",
              "[&::-moz-range-thumb]:border-emerald-600",
              "[&::-moz-range-thumb]:shadow-[0_2px_8px_-2px_rgba(16,185,129,0.5)]",
              "[&::-moz-range-thumb]:cursor-pointer",
              "dark:[&::-moz-range-thumb]:bg-[hsl(220_8%_95%)]",
              "dark:[&::-moz-range-thumb]:border-emerald-400",
              "dark:[&::-moz-range-thumb]:shadow-[0_0_0_1px_hsl(228_22%_8%),0_2px_12px_-2px_hsl(160_75%_45%/0.6)]"
            )}
          />
          <div className="pointer-events-none absolute inset-x-1 bottom-0 flex justify-between font-mono text-[9px] text-muted-foreground/50 dark:text-[hsl(220_8%_42%)]">
            {tickList.map((t) => (
              <span key={t}>{t.toFixed(decimals)}</span>
            ))}
          </div>
        </div>
        <output
          htmlFor={id}
          className={cn(
            "min-w-[3.25rem] rounded-md border px-2 py-1 text-center font-mono text-sm font-medium tabular-nums",
            "border-border/70 bg-background shadow-sm",
            "dark:border-[hsl(225_22%_18%)] dark:bg-[hsl(228_25%_6%)] dark:text-emerald-100",
            "dark:shadow-[inset_0_1px_0_hsl(222_25%_24%/0.4),0_1px_0_hsl(0_0%_0%/0.4)]"
          )}
        >
          {value.toFixed(decimals)}
        </output>
      </div>
      <p className="text-xs text-muted-foreground sm:hidden dark:text-[hsl(220_8%_62%)]">
        {description}
      </p>
    </div>
  );
}

// ─── Speaker-boost row ─────────────────────────────────────────────────

function BoostRow({
  value,
  onChange,
}: {
  value: boolean;
  onChange: (value: boolean) => void;
}): JSX.Element {
  return (
    <label
      htmlFor="voice_use_speaker_boost"
      className={cn(
        "flex cursor-pointer items-center gap-4 rounded-xl border bg-background p-4 transition-colors",
        "hover:border-foreground/30",
        "dark:bg-[hsl(228_25%_6%)] dark:border-[hsl(225_22%_18%)] dark:hover:border-[hsl(225_22%_28%)]",
        value && "border-primary/40 bg-primary/[0.04]",
        value && "dark:border-emerald-500/40 dark:bg-[hsl(160_25%_10%)] dark:shadow-[inset_0_1px_0_hsl(160_25%_25%/0.3),0_0_22px_-10px_hsl(160_70%_45%/0.35)]"
      )}
    >
      <Checkbox
        id="voice_use_speaker_boost"
        checked={value}
        onCheckedChange={(c) => onChange(c === true)}
      />
      <div className="flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-medium dark:text-[hsl(220_8%_90%)]">
            Speaker Boost
          </span>
          <span className="font-mono text-[10px] text-muted-foreground/70 dark:text-[hsl(220_8%_50%)]">
            [voice_use_speaker_boost]
          </span>
        </div>
        <p className="text-xs text-muted-foreground dark:text-[hsl(220_8%_62%)]">
          Sharpen similarity at the cost of a small latency increase.
        </p>
      </div>
      <span
        className={cn(
          "rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-widest transition-colors",
          value
            ? "bg-foreground/10 text-foreground dark:bg-emerald-400/15 dark:text-emerald-200"
            : "bg-muted text-muted-foreground dark:bg-[hsl(225_22%_12%)] dark:text-[hsl(220_8%_55%)]"
        )}
      >
        {value ? "On" : "Off"}
      </span>
    </label>
  );
}
