"use client";

import { useState } from "react";
import { ChevronRight } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import type { VideosClientVisualStyle } from "./videos-client";

/**
 * Visual-style selector + collapsed prompt preview shared by both
 * topic-creation modals. The empty string maps to `visual_style_id:
 * null` on submit (the "Default (no style)" branch); a non-empty value
 * is the gallery row id. Disclosure is collapsed by default and hidden
 * entirely when no style is selected — there's nothing to preview.
 */
interface VisualStylePickerProps {
  id: string;
  visualStyles: readonly VideosClientVisualStyle[];
  value: string;
  onChange: (value: string) => void;
}

// Sentinel option value for "Default (no style)". Radix Select rejects
// empty-string item values, so we route the default branch through a
// non-empty sentinel and translate at the boundary.
const DEFAULT_VALUE = "__default__";

export function VisualStylePicker({
  id,
  visualStyles,
  value,
  onChange,
}: VisualStylePickerProps): JSX.Element {
  const [showPrompt, setShowPrompt] = useState(false);
  const selected =
    value === "" ? null : visualStyles.find((s) => s.id === value) ?? null;

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>Visual style</Label>
      <Select
        value={value === "" ? DEFAULT_VALUE : value}
        onValueChange={(v) => onChange(v === DEFAULT_VALUE ? "" : v)}
      >
        <SelectTrigger id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={DEFAULT_VALUE}>Default (no style)</SelectItem>
          {visualStyles.map((s) => (
            <SelectItem key={s.id} value={s.id} title={s.title}>
              {s.title}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {selected && (
        <div className="text-sm">
          <button
            type="button"
            onClick={() => setShowPrompt((v) => !v)}
            className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
            aria-expanded={showPrompt}
          >
            <ChevronRight
              aria-hidden="true"
              className={`h-3.5 w-3.5 transition-transform ${
                showPrompt ? "rotate-90" : ""
              }`}
            />
            Show prompt
          </button>
          {showPrompt && (
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded border bg-muted/40 p-2 text-xs text-muted-foreground">
              {selected.prompt}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
