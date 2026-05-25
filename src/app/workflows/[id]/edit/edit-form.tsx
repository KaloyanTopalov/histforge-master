"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { ValidationWarning } from "@/lib/workflows-validator";
import {
  LLM_PROVIDER_NAMES,
  LLM_PROVIDER_LABELS,
} from "@/lib/llm/names";

// ─── Public types (also imported by the server page shell) ─────────────

export interface WorkflowEditRow {
  id: string;
  label: string;
  short_label: string;
  description: string | null;
  // Plan 1 Phase 1.1: nullable to mirror the relaxed schema. The narrative
  // editor is the only consumer of this form; narrative rows always carry
  // non-null values for these two columns, but the type matches the row
  // shape so server→client serialization round-trips.
  script_llm_provider: string | null;
  tts_provider: string | null;
  image_provider: string | null;
  video_provider: string | null;
  chunker_step: string | null;
  enabled: boolean;
  version: number;
  is_builtin: boolean;
}

export interface ScriptStepMeta {
  name: string;
  label: string;
  description: string;
  for_each: "chapters" | "chunks" | null;
}

interface EditFormProps {
  initialRow: WorkflowEditRow;
  initialSteps: { step_name: string }[];
  scriptCatalog: readonly ScriptStepMeta[];
}

// Radix Select rejects empty-string item values, so we use a sentinel for
// nullable provider columns and translate at the Select boundary.
const NONE = "__none__";

// Fields that map 1:1 to a `workflows` table column. `id`, `version`, and
// `is_builtin` are derived/server-controlled and excluded from the dirty
// diff. `steps` is tracked separately because deep-equality is needed.
type ColumnKey =
  | "label"
  | "short_label"
  | "description"
  | "script_llm_provider"
  | "tts_provider"
  | "image_provider"
  | "video_provider"
  | "chunker_step"
  | "enabled";

const COLUMN_KEYS: readonly ColumnKey[] = [
  "label",
  "short_label",
  "description",
  "script_llm_provider",
  "tts_provider",
  "image_provider",
  "video_provider",
  "chunker_step",
  "enabled",
];

const CHUNKER_STEP_SLUGS = [
  "chunk_clips_then_images",
  "chunk_images_only",
  "chunk_clips_only",
] as const;

const CHUNKER_STEP_OPTIONS: readonly { value: string; label: string }[] = [
  { value: "chunk_clips_then_images", label: "Clips + images (workflow 1)" },
  { value: "chunk_images_only", label: "Images only" },
  { value: "chunk_clips_only", label: "Clips only" },
];

interface ZodIssue {
  message?: string;
  path?: (string | number)[];
}

interface PatchBody {
  expected_version: number;
  label?: string;
  short_label?: string;
  description?: string | null;
  script_llm_provider?: string;
  tts_provider?: string | null;
  image_provider?: string | null;
  video_provider?: string | null;
  chunker_step?: string;
  enabled?: boolean;
  steps?: { step_name: string }[];
}

interface FormValues {
  label: string;
  short_label: string;
  description: string | null;
  script_llm_provider: string | null;
  tts_provider: string | null;
  image_provider: string | null;
  video_provider: string | null;
  chunker_step: string | null;
  enabled: boolean;
}

function valuesFromRow(row: WorkflowEditRow): FormValues {
  return {
    label: row.label,
    short_label: row.short_label,
    description: row.description,
    script_llm_provider: row.script_llm_provider,
    tts_provider: row.tts_provider,
    image_provider: row.image_provider,
    video_provider: row.video_provider,
    chunker_step: row.chunker_step,
    enabled: row.enabled,
  };
}

export function EditForm({
  initialRow,
  initialSteps,
  scriptCatalog,
}: EditFormProps): JSX.Element {
  const router = useRouter();
  const [values, setValues] = useState<FormValues>(() =>
    valuesFromRow(initialRow)
  );
  // Snapshot of what the server last told us — the dirty-diff baseline.
  // Reset on a successful save so subsequent edits measure from the new
  // ground truth (matches `settings-form.tsx`).
  const [snapshot, setSnapshot] = useState<FormValues>(() =>
    valuesFromRow(initialRow)
  );
  const [steps, setSteps] = useState<{ step_name: string }[]>(() => [
    ...initialSteps,
  ]);
  const [snapshotSteps, setSnapshotSteps] = useState<
    { step_name: string }[]
  >(() => [...initialSteps]);
  // Tracks the latest version known to the client. Initialized from the
  // server-rendered prop and replaced with the response version on every
  // successful PATCH so a second save in the same session doesn't 409.
  const [currentVersion, setCurrentVersion] = useState(initialRow.version);
  const [busy, setBusy] = useState(false);
  const [pickerStepName, setPickerStepName] = useState<string>("");
  // Warnings from the most recent Save or Validate-now response. A 409
  // conflict deliberately leaves these untouched — the user reloads to
  // recover, so previous warnings stay visible until then.
  const [warnings, setWarnings] = useState<ValidationWarning[]>([]);

  function update<K extends keyof FormValues>(key: K, value: FormValues[K]): void {
    setValues((v) => ({ ...v, [key]: value }));
  }

  function isDirty(): boolean {
    if (stepsAreDirty()) return true;
    return COLUMN_KEYS.some((k) => values[k] !== snapshot[k]);
  }

  function stepsAreDirty(): boolean {
    return JSON.stringify(steps) !== JSON.stringify(snapshotSteps);
  }

  function moveStepUp(idx: number): void {
    if (idx <= 0) return;
    setSteps((s) => {
      const next = [...s];
      const tmp = next[idx - 1];
      next[idx - 1] = next[idx];
      next[idx] = tmp;
      return next;
    });
  }

  function moveStepDown(idx: number): void {
    setSteps((s) => {
      if (idx >= s.length - 1) return s;
      const next = [...s];
      const tmp = next[idx + 1];
      next[idx + 1] = next[idx];
      next[idx] = tmp;
      return next;
    });
  }

  function removeStep(idx: number): void {
    setSteps((s) => s.filter((_, i) => i !== idx));
  }

  function addStep(): void {
    if (!pickerStepName) return;
    setSteps((s) => [...s, { step_name: pickerStepName }]);
    setPickerStepName("");
  }

  function buildPatchBody(): PatchBody {
    const body: PatchBody = { expected_version: currentVersion };
    for (const key of COLUMN_KEYS) {
      if (values[key] === snapshot[key]) continue;
      // TS can't narrow the union by key here; assignment is safe because
      // each key is destructured from the same source shape.
      (body as unknown as Record<string, unknown>)[key] = values[key];
    }
    if (stepsAreDirty()) {
      body.steps = steps;
    }
    return body;
  }

  async function save(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (busy || !isDirty()) return;
    setBusy(true);
    try {
      const body = buildPatchBody();
      const res = await fetch(`/api/workflows/${initialRow.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status === 409) {
        toast.error("Workflow was modified elsewhere", {
          action: {
            label: "Reload",
            onClick: () => location.reload(),
          },
        });
        return;
      }
      if (res.status === 400) {
        const errBody = (await res.json().catch(() => ({}))) as {
          error?: string;
          issues?: ZodIssue[];
        };
        const msg = errBody.issues?.[0]?.message ?? "Invalid input";
        toast.error(msg);
        return;
      }
      if (!res.ok) {
        toast.error(`Save failed (${res.status})`);
        return;
      }
      const responseBody = (await res.json()) as {
        workflow: { version: number };
        warnings?: ValidationWarning[];
      };
      setSnapshot(values);
      setSnapshotSteps(steps);
      setCurrentVersion(responseBody.workflow.version);
      setWarnings(responseBody.warnings ?? []);
      toast.success("Saved");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function validateNow(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      const body = {
        script_llm_provider: values.script_llm_provider,
        tts_provider: values.tts_provider,
        image_provider: values.image_provider,
        video_provider: values.video_provider,
        chunker_step: values.chunker_step,
        steps,
      };
      const res = await fetch("/api/workflows/validate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status === 400) {
        const errBody = (await res.json().catch(() => ({}))) as {
          error?: string;
          issues?: ZodIssue[];
        };
        const msg = errBody.issues?.[0]?.message ?? "Invalid input";
        toast.error(msg);
        return;
      }
      if (!res.ok) {
        toast.error(`Validate failed (${res.status})`);
        return;
      }
      const responseBody = (await res.json()) as {
        warnings: ValidationWarning[];
      };
      setWarnings(responseBody.warnings);
      const count = responseBody.warnings.length;
      toast.success(
        count === 0
          ? "Validation passed"
          : `Validation found ${count} warning${count === 1 ? "" : "s"}`
      );
    } finally {
      setBusy(false);
    }
  }

  // Build the lookup table for the catalog so the step rows can show
  // labels / descriptions / for_each badges by slug.
  const catalogByName = new Map<string, ScriptStepMeta>(
    scriptCatalog.map((s) => [s.name, s])
  );

  // Consistency-rule warnings emit step_name equal to a chunker slug
  // (per validateChunkerStepConsistency), which never appears in the
  // editor's script-step list — surface them under the chunker selector.
  const chunkerWarnings = warnings.filter((w) =>
    (CHUNKER_STEP_SLUGS as readonly string[]).includes(w.step_name)
  );

  return (
    <>
      <header className="mb-6 border-b pb-4">
        <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
          <Link href="/workflows" className="hover:underline">
            Workflows
          </Link>
          <span className="mx-2 opacity-50">/</span>
          Edit
        </p>
        <div className="mt-1 flex flex-wrap items-baseline gap-3">
          <h1 className="font-display text-4xl font-medium tracking-tight">
            {initialRow.label}
          </h1>
          {initialRow.is_builtin ? (
            <Badge variant="secondary">Built-in</Badge>
          ) : (
            <Badge variant="outline">Custom</Badge>
          )}
        </div>
      </header>

      <form onSubmit={save} className="space-y-6">
        <FieldGroup title="General">
          <FieldGrid>
            <ReadOnlyField id="id" label="ID" value={initialRow.id} />
            <TextField
              id="label"
              label="Label"
              maxLength={120}
              value={values.label}
              onChange={(v) => update("label", v)}
            />
            <TextField
              id="short_label"
              label="Short label"
              maxLength={40}
              value={values.short_label}
              onChange={(v) => update("short_label", v)}
              hint="Compact label shown in the queue table."
            />
            <CheckboxField
              id="enabled"
              label="Enabled"
              checked={values.enabled}
              onChange={(v) => update("enabled", v)}
              hint="Disabled workflows are hidden from the Add Video picker."
            />
          </FieldGrid>
          <TextAreaField
            id="description"
            label="Description"
            maxLength={500}
            value={values.description ?? ""}
            onChange={(v) => update("description", v === "" ? null : v)}
          />
        </FieldGroup>

        <FieldGroup title="Providers">
          <FieldGrid>
            <SelectField
              id="script_llm_provider"
              label="Script LLM provider"
              value={values.script_llm_provider ?? NONE}
              options={LLM_PROVIDER_NAMES.map((value) => ({
                value,
                label: LLM_PROVIDER_LABELS[value],
              }))}
              onChange={(v) => update("script_llm_provider", v)}
            />
            <SelectField
              id="tts_provider"
              label="TTS provider"
              value={values.tts_provider ?? NONE}
              options={[
                { value: "ai33", label: "AI33" },
                { value: "genaipro", label: "GenAIPro" },
                { value: "chatterbox", label: "Chatterbox" },
                { value: "chatterbox-fast", label: "Chatterbox (fast)" },
                { value: NONE, label: "(none)" },
              ]}
              onChange={(v) =>
                update("tts_provider", v === NONE ? null : v)
              }
            />
            <SelectField
              id="image_provider"
              label="Image provider"
              value={values.image_provider ?? NONE}
              options={[
                { value: "comfyui", label: "ComfyUI" },
                { value: "google_flow", label: "Google Flow" },
                { value: NONE, label: "(none)" },
              ]}
              onChange={(v) =>
                update("image_provider", v === NONE ? null : v)
              }
            />
            <SelectField
              id="video_provider"
              label="Video provider"
              value={values.video_provider ?? NONE}
              options={[
                { value: "comfyui", label: "ComfyUI" },
                { value: "google_flow", label: "Google Flow" },
                { value: NONE, label: "(none)" },
              ]}
              onChange={(v) =>
                update("video_provider", v === NONE ? null : v)
              }
            />
            <SelectField
              id="chunker_step"
              label="Chunker"
              value={values.chunker_step ?? NONE}
              options={CHUNKER_STEP_OPTIONS}
              onChange={(v) => update("chunker_step", v)}
            />
          </FieldGrid>
          {chunkerWarnings.map((w, wi) => (
            <p
              key={`${w.missing_input}-${wi}`}
              className="text-xs text-amber-700"
            >
              {w.message}
            </p>
          ))}
          <p className="text-xs text-muted-foreground">
            Each chunker emits chunks of specific asset types — picking
            one gates which provider columns above must be set. Clips +
            images needs both image and video providers; images only
            needs image only; clips only needs video only.
          </p>
          <p className="text-xs text-muted-foreground">
            Note: every LLM-driven step in a run (script writing, chunk
            enrichment, Google Flow moderation) uses this workflow&rsquo;s{" "}
            <code className="font-mono">script_llm_provider</code>, pinned
            to the run via the workflow snapshot.
          </p>
        </FieldGroup>

        <FieldGroup title="Script steps">
          {steps.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No script steps. Add one below.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12 text-right">#</TableHead>
                  <TableHead>Step</TableHead>
                  <TableHead>Tags</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {steps.map((s, idx) => {
                  const meta = catalogByName.get(s.step_name);
                  const label = meta?.label ?? s.step_name;
                  const description = meta?.description ?? "";
                  const forEach = meta?.for_each ?? null;
                  const stepWarnings = warnings.filter(
                    (w) => w.step_name === s.step_name
                  );
                  return (
                    <TableRow key={`${s.step_name}-${idx}`}>
                      <TableCell className="text-right tabular-nums text-muted-foreground align-top">
                        {idx + 1}
                      </TableCell>
                      <TableCell>
                        <div title={description}>
                          <div className="font-medium">{label}</div>
                          <div className="font-mono text-[11px] text-muted-foreground">
                            {s.step_name}
                          </div>
                          {stepWarnings.map((w, wi) => (
                            <p
                              key={`${w.missing_input}-${wi}`}
                              className="text-xs text-amber-700 mt-1"
                            >
                              {w.message}
                            </p>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell className="align-top">
                        {forEach && (
                          <Badge variant="secondary">
                            multi-output: {forEach}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="align-top">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={idx === 0}
                            onClick={() => moveStepUp(idx)}
                            aria-label={`Move ${label} up`}
                          >
                            <ArrowUp aria-hidden="true" />
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={idx === steps.length - 1}
                            onClick={() => moveStepDown(idx)}
                            aria-label={`Move ${label} down`}
                          >
                            <ArrowDown aria-hidden="true" />
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="destructiveSoft"
                            onClick={() => removeStep(idx)}
                            aria-label={`Remove ${label}`}
                          >
                            <Trash2 aria-hidden="true" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}

          <div className="flex items-end gap-2">
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="add-step">Add step</Label>
              <Select
                value={pickerStepName}
                onValueChange={setPickerStepName}
              >
                <SelectTrigger id="add-step">
                  <SelectValue placeholder="Pick a script step…" />
                </SelectTrigger>
                <SelectContent>
                  {scriptCatalog.map((s) => (
                    <SelectItem key={s.name} value={s.name}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={addStep}
              disabled={!pickerStepName}
            >
              <Plus aria-hidden="true" />
              Add
            </Button>
          </div>
        </FieldGroup>

        <div className="flex items-center gap-3 border-t pt-4">
          <Button type="submit" disabled={busy || !isDirty()}>
            {busy ? "Saving…" : "Save"}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={validateNow}
            disabled={busy}
          >
            Validate now
          </Button>
          <Button asChild type="button" variant="outline">
            <Link href="/workflows">Cancel</Link>
          </Button>
        </div>
      </form>
    </>
  );
}

// ─── Layout helpers (mirrors settings-form) ────────────────────────────

function FieldGroup({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <section className="space-y-3 rounded-lg border bg-muted/30 p-4">
      <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h4>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

function FieldGrid({
  children,
}: {
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="grid items-end gap-4 sm:grid-cols-2">{children}</div>
  );
}

function FieldLabel({
  id,
  label,
}: {
  id: string;
  label: string;
}): JSX.Element {
  return (
    <Label htmlFor={id} className="flex flex-wrap items-baseline gap-x-2">
      <span className="text-sm font-medium text-muted-foreground">{label}</span>
      <span className="font-mono text-[11px] font-normal text-muted-foreground/70">
        [{id}]
      </span>
    </Label>
  );
}

function ReadOnlyField({
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

function TextField({
  id,
  label,
  value,
  onChange,
  maxLength,
  hint,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  maxLength?: number;
  hint?: string;
}): JSX.Element {
  return (
    <div className="space-y-1.5">
      <FieldLabel id={id} label={label} />
      <Input
        id={id}
        type="text"
        maxLength={maxLength}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function TextAreaField({
  id,
  label,
  value,
  onChange,
  maxLength,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  maxLength?: number;
}): JSX.Element {
  return (
    <div className="space-y-1.5">
      <FieldLabel id={id} label={label} />
      <Textarea
        id={id}
        rows={3}
        maxLength={maxLength}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

function CheckboxField({
  id,
  label,
  checked,
  onChange,
  hint,
}: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  hint?: string;
}): JSX.Element {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <Checkbox
          id={id}
          checked={checked}
          onCheckedChange={(v) => onChange(v === true)}
        />
        <FieldLabel id={id} label={label} />
      </div>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

interface SelectOption {
  value: string;
  label: string;
}

function SelectField({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: readonly SelectOption[];
  onChange: (v: string) => void;
}): JSX.Element {
  return (
    <div className="space-y-1.5">
      <FieldLabel id={id} label={label} />
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
