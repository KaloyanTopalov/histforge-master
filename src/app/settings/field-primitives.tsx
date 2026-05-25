"use client";

import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

// ─── Layout helpers ────────────────────────────────────────────────────
//
// Panel is the inner "well" inside the outer Settings card. Light: slate
// wash. Dark: sunken substrate at L≈3–5% sitting distinctly below the
// surrounding Card (L≈9–14%), so each grouped region reads as a clearly
// bounded surface. Warm-graphite hue family (225–228°, low saturation),
// faint inner top highlight + bottom drop-shadow for tactile depth.
// Temperature-matched to the TTS tab's section panels so accents
// (typically emerald) sit on a substrate from their own hue family rather
// than fighting the slate they used to land on.

export function Panel({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <div
      className={cn(
        "rounded-xl border border-slate-200 bg-slate-100 p-5",
        "dark:border-[hsl(225_22%_14%)] dark:bg-gradient-to-b dark:from-[hsl(225_25%_5%)] dark:to-[hsl(228_25%_3%)]",
        "dark:shadow-[inset_0_1px_0_hsl(222_25%_20%/0.4),0_1px_0_hsl(0_0%_0%/0.55)]",
        className
      )}
    >
      {children}
    </div>
  );
}

export function FieldGroup({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <section
      className={cn(
        "space-y-3 rounded-xl border border-slate-200 bg-slate-100 p-5",
        "dark:border-[hsl(225_22%_14%)] dark:bg-gradient-to-b dark:from-[hsl(225_25%_5%)] dark:to-[hsl(228_25%_3%)]",
        "dark:shadow-[inset_0_1px_0_hsl(222_25%_20%/0.4),0_1px_0_hsl(0_0%_0%/0.55)]"
      )}
    >
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className="inline-block h-5 w-1 rounded-full bg-gradient-to-b from-emerald-300 to-emerald-600 shadow-[0_0_8px_-1px_rgba(16,185,129,0.45)] dark:from-emerald-300 dark:to-emerald-500 dark:shadow-[0_0_12px_-1px_hsl(160_70%_45%/0.6)]"
        />
        <h4 className="text-[11px] font-bold uppercase tracking-[0.18em] text-emerald-900/85 dark:text-emerald-100/90">
          {title}
        </h4>
        <span
          aria-hidden="true"
          className="h-px flex-1 bg-gradient-to-r from-border to-transparent dark:from-[hsl(222_20%_22%)]"
        />
      </div>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

export function FieldGrid({
  children,
}: {
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="grid items-end gap-4 sm:grid-cols-2">{children}</div>
  );
}

// ─── Field primitives ──────────────────────────────────────────────────
//
// Thin wrappers around shadcn primitives that preserve the Label+field+hint
// shape and the controlled-value API the rest of this file calls with. Call
// sites pass `id` (the setting key, used as DOM id and shown in [brackets]),
// `label` (the human-readable display name), value, onChange (+ optional
// hint/step/options), and the wrapper handles accessibility wiring and
// the proper-name + monospace-id label rendering.

export function FieldLabel({
  id,
  label,
}: {
  id: string;
  label: string;
}): JSX.Element {
  return (
    <Label htmlFor={id} className="flex flex-wrap items-baseline gap-x-2">
      <span className="text-sm font-medium text-foreground/85">
        {label}
      </span>
      <span className="font-mono text-[11px] font-normal text-muted-foreground/70">
        [{id}]
      </span>
    </Label>
  );
}

export function ReadOnlyField({
  id,
  label,
  value,
}: {
  id: string;
  label: string;
  value: string;
}): JSX.Element {
  return (
    <div className="space-y-1.5">
      <FieldLabel id={id} label={label} />
      <Input id={id} type="text" value={value} readOnly aria-readonly="true" />
    </div>
  );
}

export function TextField({
  id,
  label,
  value,
  onChange,
  hint,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
}): JSX.Element {
  return (
    <div className="space-y-1.5">
      <FieldLabel id={id} label={label} />
      <Input
        id={id}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function TextArea({
  id,
  label,
  value,
  onChange,
  hint,
  rows,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
  rows?: number;
}): JSX.Element {
  return (
    <div className="space-y-1.5">
      <FieldLabel id={id} label={label} />
      <Textarea
        id={id}
        rows={rows ?? 3}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function NumberField({
  id,
  label,
  value,
  onChange,
  step,
  min,
  hint,
}: {
  id: string;
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  hint?: string;
}): JSX.Element {
  return (
    <div className="space-y-1.5">
      <FieldLabel id={id} label={label} />
      <Input
        id={id}
        type="number"
        step={step ?? 1}
        min={min}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

type SelectOption = string | { readonly label: string; readonly value: string };

export function SelectField({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: ReadonlyArray<SelectOption>;
  onChange: (v: string) => void;
}): JSX.Element {
  const normalized = options.map((o) =>
    typeof o === "string" ? { label: o, value: o } : o
  );
  return (
    <div className="space-y-1.5">
      <FieldLabel id={id} label={label} />
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {normalized.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export function BoolField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}): JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <Checkbox
        id={id}
        checked={value}
        onCheckedChange={(c) => onChange(c === true)}
      />
      <FieldLabel id={id} label={label} />
    </div>
  );
}
