"use client";

/**
 * Shared "POST → 409 → confirm overwrite → re-POST with ?overwrite=1"
 * dance for both workflow-import surfaces on /workflows:
 *   - file-picker upload (`POST /api/workflows/import`)
 *   - drafts import      (`POST /api/workflows/drafts/[filename]/import`)
 *
 * `runImport` sequences the two POSTs; `useOverwriteConfirm` owns the
 * ConfirmDialog state + JSX so the two surfaces cannot drift on dialog
 * wording, styling, or the busy-retain-through-retry-POST lifecycle.
 */

import { useCallback, useRef, useState } from "react";
import { ConfirmDialog } from "@/app/videos/confirm-dialog";

export interface ImportAttempt {
  status: number;
  ok: boolean;
  body: unknown;
  /** True iff the user cancelled at the overwrite-confirm step. */
  cancelled: boolean;
}

export interface RunImportOptions {
  /**
   * Issue the POST. Called with `false` first; on 409, called again with
   * `true` after the user confirms overwrite.
   */
  post: (overwrite: boolean) => Promise<Response>;
  /** Open the overwrite-confirm dialog. Resolve `true` to retry, `false` to cancel. */
  onConflict: () => Promise<boolean>;
}

export interface ZodIssue {
  message?: string;
  path?: (string | number)[];
}

export interface ImportErrorBody {
  error?: string;
  issues?: ZodIssue[];
}

export interface ImportErrorContext {
  /**
   * Surface-specific side-effect for the `draft_not_found` arm. Drafts
   * surface passes its `loadDrafts`; file-picker omits it (it never hits
   * `draft_not_found` because that code is route-specific).
   */
  reloadDrafts?: () => Promise<void>;
}

export interface DecodedImportError {
  kind: "toast";
  level: "error" | "warning";
  message: string;
  /** Caller awaits this after firing the toast. */
  sideEffect?: () => Promise<void>;
}

/**
 * Map a non-ok import response to a toast description plus an optional
 * side-effect. Pure: caller invokes both `toast` and `sideEffect`. Covers
 * every error code either import surface produces today —
 * `IMPORT_ERROR_STATUS` from `@/lib/workflows-import` (`invalid_input`,
 * `workflow_id_exists`, `invalid_filename`) plus the drafts route's
 * `draft_not_found` and `invalid_json`. Anything else falls through to a
 * generic `Import failed (${status})` message.
 */
export function decodeImportError(
  body: ImportErrorBody | null,
  status: number,
  ctx: ImportErrorContext,
): DecodedImportError {
  const code = body?.error;
  if (code === "invalid_input") {
    const msg = body?.issues?.[0]?.message ?? "schema mismatch";
    return {
      kind: "toast",
      level: "error",
      message: `Invalid workflow JSON: ${msg}`,
    };
  }
  if (code === "invalid_json") {
    return {
      kind: "toast",
      level: "error",
      message: "Draft file is not valid JSON",
    };
  }
  if (code === "invalid_filename") {
    return {
      kind: "toast",
      level: "error",
      message: "Invalid draft filename",
    };
  }
  if (code === "draft_not_found") {
    return {
      kind: "toast",
      level: "error",
      message: "Draft file no longer exists",
      sideEffect: ctx.reloadDrafts,
    };
  }
  if (code === "workflow_id_exists") {
    // Only reachable post-cancel: runImport's first POST hits 409 → user
    // cancels → runImport returns ok=false. A second 409 here means a
    // concurrent insert raced us; surface as a generic conflict.
    return {
      kind: "toast",
      level: "error",
      message: "Workflow id collision — refresh and try again",
    };
  }
  return {
    kind: "toast",
    level: "error",
    message: `Import failed (${status})`,
  };
}

export async function runImport({
  post,
  onConflict,
}: RunImportOptions): Promise<ImportAttempt> {
  let res = await post(false);
  if (res.status === 409) {
    const body = await res.json().catch(() => null);
    const proceed = await onConflict();
    if (!proceed) {
      return { status: res.status, ok: false, body, cancelled: true };
    }
    res = await post(true);
  }
  const body = await res.json().catch(() => null);
  return { status: res.status, ok: res.ok, body, cancelled: false };
}

interface OverwriteState {
  slug: string;
  resolve: (ok: boolean) => void;
  busy: boolean;
}

export interface UseOverwriteConfirm {
  /**
   * Plug into `runImport`'s `onConflict`. Resolves true → user confirmed
   * overwrite; resolves false → user cancelled. On false the dialog has
   * already unmounted; on true the dialog stays mounted with busy=true so
   * the user sees a spinner while the caller issues the retry POST.
   */
  requestConfirm: (slug: string) => Promise<boolean>;
  /**
   * Caller signals the import flow is done; the hook unmounts the dialog.
   * Idempotent — safe to call when no dialog is open.
   */
  endRequest: () => void;
  /** Render this where the dialog should appear in the tree. */
  dialog: JSX.Element | null;
}

/**
 * Owns the OverwriteConfirm dialog state for the import surfaces on
 * `/workflows`. Lifecycle invariants:
 *   1. On user-cancel: dialog unmounts immediately, promise resolves false.
 *   2. On user-confirm: dialog stays mounted with busy=true through the
 *      caller's retry POST; promise resolves true immediately.
 *   3. After the caller calls endRequest(), the dialog is unmounted exactly
 *      once. No path leaves the dialog mounted.
 */
export function useOverwriteConfirm(): UseOverwriteConfirm {
  const [state, setState] = useState<OverwriteState | null>(null);
  // Tracks busy synchronously so AlertDialogAction's auto-close (which
  // fires onOpenChange→onCancel after the click handler runs) can be
  // suppressed during the retry POST. Reading busy from `state` would see
  // the pre-update value because React has not re-rendered yet.
  const busyRef = useRef(false);

  const requestConfirm = useCallback(
    (slug: string): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        busyRef.current = false;
        setState({ slug, resolve, busy: false });
      }),
    [],
  );

  const endRequest = useCallback((): void => {
    busyRef.current = false;
    setState(null);
  }, []);

  const dialog = state ? (
    <ConfirmDialog
      title="Overwrite existing workflow?"
      message={`A workflow with id "${state.slug}" already exists. Overwrite it?`}
      confirmLabel="Overwrite"
      destructive
      busy={state.busy}
      onCancel={() => {
        // Radix fires onOpenChange(false) after AlertDialogAction's click,
        // which routes here. Suppress when busy so the dialog stays mounted
        // with the spinner through the retry POST.
        if (busyRef.current) return;
        state.resolve(false);
        setState(null);
      }}
      onConfirm={() => {
        if (busyRef.current) return;
        busyRef.current = true;
        setState({ ...state, busy: true });
        state.resolve(true);
      }}
    />
  ) : null;

  return { requestConfirm, endRequest, dialog };
}
