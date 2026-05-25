"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ConfirmDialog } from "@/app/videos/confirm-dialog";
import { cn } from "@/lib/utils";
import type { VisualStyle } from "@/types";
import { FieldLabel, Panel } from "./field-primitives";

/**
 * Master-detail gallery for the `visual_styles` table. Owns its own REST
 * round-trips against /api/visual-styles — does not participate in the
 * SettingsForm bulk PATCH model. Reports a single `isDirty` boolean
 * upward via `onDirtyChange` so the parent's per-tab dirty dot and the
 * cross-tab warn intercept reflect unsaved pane edits.
 *
 * Discard intercepts (sync `window.confirm`): row switch, "Add new",
 * tab switch (driven by the `registerConfirmDiscard` callback), and page
 * close (`beforeunload`). Delete uses an in-DOM `ConfirmDialog` because
 * it's a more destructive action and benefits from the heavier surface.
 */

const DISCARD_MESSAGE =
  "Discard unsaved changes to the selected visual style?";

const NEW_FORM_ID = "__new__";

interface VisualStyleGalleryProps {
  onDirtyChange?: (dirty: boolean) => void;
  registerConfirmDiscard?: (fn: (() => boolean) | null) => void;
}

interface FormState {
  title: string;
  prompt: string;
}

const EMPTY_FORM: FormState = { title: "", prompt: "" };

export function VisualStyleGallery({
  onDirtyChange,
  registerConfirmDiscard,
}: VisualStyleGalleryProps): JSX.Element {
  const [styles, setStyles] = useState<VisualStyle[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // null until first load. NEW_FORM_ID denotes a draft for create.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [snapshot, setSnapshot] = useState<FormState>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<VisualStyle | null>(null);

  const isDirty =
    form.title !== snapshot.title || form.prompt !== snapshot.prompt;

  // Sorted alphabetically (NOCASE) — server already sorts this way but
  // re-sort defensively in case a future API change weakens the contract.
  const sorted = useMemo(() => {
    if (!styles) return [];
    return [...styles].sort((a, b) =>
      a.title.toLowerCase().localeCompare(b.title.toLowerCase())
    );
  }, [styles]);

  const loadStyles = useCallback(async (): Promise<VisualStyle[] | null> => {
    try {
      const res = await fetch("/api/visual-styles");
      if (!res.ok) {
        setLoadError(`Failed to load (${res.status})`);
        return null;
      }
      const body = (await res.json()) as { visual_styles: VisualStyle[] };
      setStyles(body.visual_styles);
      setLoadError(null);
      return body.visual_styles;
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Network error");
      return null;
    }
  }, []);

  // Initial fetch.
  useEffect(() => {
    void loadStyles().then((list) => {
      if (!list) return;
      if (list.length > 0) {
        applySelection(list[0]);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Surface dirt to the parent — drives the per-tab dot and tab-switch
  // intercept. Coalesce duplicate values via the dependency check.
  useEffect(() => {
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange]);

  // Register a sync confirm-discard callback so SettingsForm can ask
  // before navigating away from this tab. Reads the latest `isDirty`
  // via a ref so the callback doesn't capture a stale value.
  const dirtyRef = useRef(isDirty);
  dirtyRef.current = isDirty;
  useEffect(() => {
    if (!registerConfirmDiscard) return;
    registerConfirmDiscard(() => {
      if (!dirtyRef.current) return true;
      return window.confirm(DISCARD_MESSAGE);
    });
    return () => registerConfirmDiscard(null);
  }, [registerConfirmDiscard]);

  // beforeunload intercept while dirty.
  useEffect(() => {
    if (!isDirty) return;
    function onBeforeUnload(e: BeforeUnloadEvent): void {
      e.preventDefault();
      // Chrome ignores the message but still shows its generic prompt
      // when returnValue is set.
      e.returnValue = "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [isDirty]);

  function applySelection(style: VisualStyle): void {
    setSelectedId(style.id);
    setForm({ title: style.title, prompt: style.prompt });
    setSnapshot({ title: style.title, prompt: style.prompt });
    setSaveError(null);
  }

  function startNewDraft(): void {
    setSelectedId(NEW_FORM_ID);
    setForm(EMPTY_FORM);
    setSnapshot(EMPTY_FORM);
    setSaveError(null);
  }

  function clearSelection(): void {
    setSelectedId(null);
    setForm(EMPTY_FORM);
    setSnapshot(EMPTY_FORM);
    setSaveError(null);
  }

  function confirmDiscardIfDirty(): boolean {
    if (!isDirty) return true;
    return window.confirm(DISCARD_MESSAGE);
  }

  function handleSelectRow(style: VisualStyle): void {
    if (style.id === selectedId) return;
    if (!confirmDiscardIfDirty()) return;
    applySelection(style);
  }

  function handleAddNew(): void {
    if (selectedId === NEW_FORM_ID && !isDirty) return;
    if (!confirmDiscardIfDirty()) return;
    startNewDraft();
  }

  async function handleSave(): Promise<void> {
    // Trim before submit so the client and server agree on what counts
    // as a non-empty title (API only enforces z.string().min(1), which
    // would otherwise accept whitespace-only).
    const title = form.title.trim();
    const prompt = form.prompt;
    if (title === "") {
      setSaveError("Title is required.");
      return;
    }
    setBusy(true);
    setSaveError(null);
    try {
      let res: Response;
      let savedId: string;
      if (selectedId === NEW_FORM_ID || selectedId === null) {
        res = await fetch("/api/visual-styles", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title, prompt }),
        });
        if (!res.ok) {
          setSaveError(`Save failed (${res.status})`);
          return;
        }
        const body = (await res.json()) as { visual_style: VisualStyle };
        savedId = body.visual_style.id;
      } else {
        res = await fetch(`/api/visual-styles/${selectedId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title, prompt }),
        });
        if (!res.ok) {
          setSaveError(`Save failed (${res.status})`);
          return;
        }
        savedId = selectedId;
      }
      const list = await loadStyles();
      const fresh = list?.find((s) => s.id === savedId);
      if (fresh) applySelection(fresh);
      else clearSelection();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Network error");
    } finally {
      setBusy(false);
    }
  }

  function requestDelete(): void {
    if (selectedId === null || selectedId === NEW_FORM_ID) return;
    const target = sorted.find((s) => s.id === selectedId);
    if (!target) return;
    setDeleteTarget(target);
  }

  async function performDelete(): Promise<void> {
    if (!deleteTarget) return;
    setBusy(true);
    try {
      await fetch(`/api/visual-styles/${deleteTarget.id}`, {
        method: "DELETE",
      });
      const list = await loadStyles();
      const remaining = list ?? [];
      if (remaining.length === 0) {
        clearSelection();
      } else {
        // Fall back to the row that took the deleted row's slot — same
        // position in the sorted list, or the new last row if the
        // deleted row was at the tail.
        const sortedRemaining = [...remaining].sort((a, b) =>
          a.title.toLowerCase().localeCompare(b.title.toLowerCase())
        );
        const priorIndex = sorted.findIndex((s) => s.id === deleteTarget.id);
        const nextIndex = Math.min(priorIndex, sortedRemaining.length - 1);
        applySelection(sortedRemaining[Math.max(nextIndex, 0)]);
      }
    } finally {
      setBusy(false);
      setDeleteTarget(null);
    }
  }

  return (
    <Panel className="space-y-0 p-0">
      <div className="grid grid-cols-1 gap-0 md:grid-cols-[260px_1fr]">
        {/* Left rail */}
        <div className="border-b border-slate-200 dark:border-[hsl(225_22%_14%)] md:border-b-0 md:border-r">
          <div className="flex items-center justify-between gap-2 p-3">
            <h3 className="text-[11px] font-bold uppercase tracking-[0.18em] text-emerald-900/85 dark:text-emerald-100/90">
              Styles
            </h3>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleAddNew}
              className="h-7 gap-1.5 px-2 text-xs"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              Add new
            </Button>
          </div>
          <ul role="listbox" aria-label="Visual styles" className="max-h-[420px] overflow-y-auto pb-2">
            {styles === null && (
              <li className="px-4 py-3 text-xs text-muted-foreground">
                Loading…
              </li>
            )}
            {styles !== null && sorted.length === 0 && selectedId !== NEW_FORM_ID && (
              <li className="px-4 py-3 text-xs text-muted-foreground">
                No styles yet. Use “Add new” to create one.
              </li>
            )}
            {sorted.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={s.id === selectedId}
                  onClick={() => handleSelectRow(s)}
                  className={cn(
                    "block w-full truncate px-4 py-2 text-left text-sm",
                    s.id === selectedId
                      ? "bg-emerald-50 font-semibold text-emerald-900 dark:bg-emerald-900/30 dark:text-emerald-100"
                      : "text-foreground/85 hover:bg-slate-200/60 dark:hover:bg-[hsl(225_22%_11%)]"
                  )}
                >
                  {s.title}
                </button>
              </li>
            ))}
            {selectedId === NEW_FORM_ID && (
              <li
                role="option"
                aria-selected
                className="block w-full truncate px-4 py-2 text-left text-sm italic bg-emerald-50 text-emerald-900 dark:bg-emerald-900/30 dark:text-emerald-100"
              >
                New style…
              </li>
            )}
          </ul>
          {loadError && (
            <p className="px-4 pb-3 text-xs text-red-700 dark:text-red-300">
              {loadError}
            </p>
          )}
        </div>

        {/* Right pane */}
        <div className="p-5">
          {selectedId === null ? (
            <div className="flex h-full min-h-[200px] items-center justify-center text-sm text-muted-foreground">
              Select a style on the left, or use “Add new”.
            </div>
          ) : (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <FieldLabel id="visual_style_title" label="Title" />
                <Input
                  id="visual_style_title"
                  type="text"
                  value={form.title}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, title: e.target.value }))
                  }
                  placeholder="e.g. Cinematic noir"
                />
              </div>
              <div className="space-y-1.5">
                <FieldLabel id="visual_style_prompt" label="Prompt" />
                <Textarea
                  id="visual_style_prompt"
                  rows={8}
                  value={form.prompt}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, prompt: e.target.value }))
                  }
                  placeholder="Visual style prompt prefix (e.g. 'cinematic, moody lighting, grain')."
                />
              </div>
              {saveError && (
                <p className="rounded-lg border border-red-200 bg-red-50 p-2 text-xs text-red-900 dark:border-red-500/30 dark:bg-red-950 dark:text-red-100">
                  {saveError}
                </p>
              )}
              <div className="flex items-center justify-between gap-3 border-t pt-4">
                <Button
                  type="button"
                  onClick={handleSave}
                  disabled={busy || !isDirty}
                >
                  {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Save
                </Button>
                {selectedId !== NEW_FORM_ID && (
                  <Button
                    type="button"
                    variant="destructive"
                    onClick={requestDelete}
                    disabled={busy}
                  >
                    <Trash2 className="mr-2 h-4 w-4" aria-hidden="true" />
                    Delete
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {deleteTarget && (
        <ConfirmDialog
          title="Delete visual style?"
          message={`This permanently removes “${deleteTarget.title}”. Any in-flight videos keep their pinned snapshot.`}
          confirmLabel="Delete"
          destructive
          busy={busy}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={performDelete}
        />
      )}
    </Panel>
  );
}
