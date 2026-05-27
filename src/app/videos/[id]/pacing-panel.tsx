"use client";

import { useState } from "react";
import { Loader2, RotateCcw, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface PacingPanelProps {
  videoId: string;
  initialPacing: {
    image_chunk_target_seconds: number | null;
    image_chunk_min_seconds: number | null;
    image_chunk_max_seconds: number | null;
  };
  globalPacing: { target: number; min: number; max: number };
  /**
   * Word count of the script the operator is pacing against. Source
   * preference in `page.tsx`: ready-script `provided_script` first,
   * then the assembled `script/full_script.md` on disk. `null` when
   * neither is available — the hint degrades to `—`.
   */
  scriptWordCount: number | null;
}

type ColumnState = number | null;

interface PanelState {
  target: ColumnState;
  min: ColumnState;
  max: ColumnState;
}

const WPM = 150;

/**
 * Per-video image-chunk pacing widget. Each input is bound to a
 * `number | null` cell; `null` clears the column so the chunker
 * falls through to the global setting at step entry. The placeholder
 * shows the global so the operator can see what they would land on
 * when the field is blank.
 *
 * The "≈ N images" hint is purely informational — final chunk count
 * comes out of step 08's forward-merge + backward-tidy passes, which
 * the min/max constraints can shift in either direction. The hint
 * spells this out instead of pretending precision.
 */
export function PacingPanel({
  videoId,
  initialPacing,
  globalPacing,
  scriptWordCount,
}: PacingPanelProps): JSX.Element {
  const [state, setState] = useState<PanelState>({
    target: initialPacing.image_chunk_target_seconds,
    min: initialPacing.image_chunk_min_seconds,
    max: initialPacing.image_chunk_max_seconds,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const effectiveTarget = state.target ?? globalPacing.target;
  const hint =
    scriptWordCount === null
      ? "—"
      : `≈ ${Math.max(
          1,
          Math.round((scriptWordCount * 60) / (effectiveTarget * WPM))
        )} images for this script at ${WPM} WPM. Min/max constraints will change this number.`;

  function update(key: keyof PanelState, raw: string): void {
    setError(null);
    setSuccess(null);
    if (raw === "") {
      setState((s) => ({ ...s, [key]: null }));
      return;
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) return;
    setState((s) => ({ ...s, [key]: n }));
  }

  function clear(key: keyof PanelState): void {
    setError(null);
    setSuccess(null);
    setState((s) => ({ ...s, [key]: null }));
  }

  async function save(): Promise<void> {
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch(`/api/videos/${videoId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          image_chunk_target_seconds: state.target,
          image_chunk_min_seconds: state.min,
          image_chunk_max_seconds: state.max,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
      };
      if (!res.ok) {
        setError(
          data.message || data.error || `Save failed (HTTP ${res.status}).`
        );
        return;
      }
      setSuccess("Saved. Reloading…");
      setTimeout(() => {
        window.location.reload();
      }, 800);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <h2 className="text-sm font-semibold">Image pacing</h2>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Per-video overrides for the images-only chunker. Leave a field
          blank to fall through to the global setting (shown as
          placeholder). Step 08 enforces <code>min ≤ target ≤ max</code>
          on the resolved triple.
        </p>
        <PacingRow
          id={`pacing-target-${videoId}`}
          label="Target seconds"
          value={state.target}
          placeholder={String(globalPacing.target)}
          onChange={(raw) => update("target", raw)}
          onClear={() => clear("target")}
          disabled={busy}
        />
        <p className="text-xs text-muted-foreground">{hint}</p>
        <PacingRow
          id={`pacing-min-${videoId}`}
          label="Min seconds (floor)"
          value={state.min}
          placeholder={String(globalPacing.min)}
          onChange={(raw) => update("min", raw)}
          onClear={() => clear("min")}
          disabled={busy}
        />
        <PacingRow
          id={`pacing-max-${videoId}`}
          label="Max seconds (ceiling)"
          value={state.max}
          placeholder={String(globalPacing.max)}
          onChange={(raw) => update("max", raw)}
          onClear={() => clear("max")}
          disabled={busy}
        />
        <div className="flex items-center gap-2 pt-1">
          <Button
            type="button"
            size="sm"
            onClick={() => void save()}
            disabled={busy}
          >
            {busy ? (
              <Loader2 aria-hidden="true" className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Save aria-hidden="true" className="mr-2 h-4 w-4" />
            )}
            Save pacing
          </Button>
        </div>
        {error && (
          <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
        )}
        {success && (
          <p className="text-xs text-green-700 dark:text-green-400">{success}</p>
        )}
      </CardContent>
    </Card>
  );
}

interface PacingRowProps {
  id: string;
  label: string;
  value: number | null;
  placeholder: string;
  onChange: (raw: string) => void;
  onClear: () => void;
  disabled: boolean;
}

function PacingRow({
  id,
  label,
  value,
  placeholder,
  onChange,
  onClear,
  disabled,
}: PacingRowProps): JSX.Element {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs font-medium">
        {label}
      </Label>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          type="number"
          inputMode="numeric"
          step={1}
          min={2}
          value={value ?? ""}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          className="max-w-[10rem]"
        />
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={onClear}
          disabled={disabled || value === null}
          title="Clear to global setting"
        >
          <RotateCcw aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
          Use global
        </Button>
      </div>
    </div>
  );
}
