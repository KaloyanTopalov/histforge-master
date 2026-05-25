"use client";

import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { AccountListItem } from "@/lib/flow-account-status";
import {
  useEditableName,
  useFlowAccounts,
  type MintedAccount,
} from "./google-flow-accounts-hooks";
import { GoogleFlowAccountsTable } from "./google-flow-accounts-table";
import { FlowAccountMintedDialog } from "./google-flow-account-minted-dialog";
import { FlowAccountDeleteConfirm } from "./google-flow-account-delete-confirm";

/**
 * Google Flow accounts management. Lives inside the Settings → Google
 * Flow tab. Composes the data hook (useFlowAccounts), the inline-edit
 * hook (useEditableName), the table, and the two dialogs. The settings
 * page is a server component that only serves initial-scalar settings
 * — this client subtree owns the per-account list and its mutations.
 */
export function GoogleFlowAccounts(): JSX.Element {
  const {
    accounts,
    loading,
    error,
    patchAccount,
    addAccount,
    deleteAccount,
  } = useFlowAccounts();
  const [newName, setNewName] = useState("");
  const [adding, setAdding] = useState(false);
  const [minted, setMinted] = useState<MintedAccount | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<AccountListItem | null>(
    null
  );

  const commitName = useCallback(
    (id: string, name: string) => patchAccount(id, { name }),
    [patchAccount]
  );
  const getCurrentName = useCallback(
    (id: string) => accounts.find((a) => a.id === id)?.name,
    [accounts]
  );
  const editable = useEditableName(commitName, getCurrentName);

  async function onAdd(): Promise<void> {
    const name = newName.trim();
    if (name.length === 0) return;
    setAdding(true);
    try {
      const result = await addAccount(name);
      if (result) {
        setMinted(result);
        setNewName("");
      }
    } finally {
      setAdding(false);
    }
  }

  const [togglingId, setTogglingId] = useState<string | null>(null);

  function pauseFor(id: string, hours: number): void {
    const iso = new Date(Date.now() + hours * 3600 * 1000).toISOString();
    void patchAccount(id, { paused_until_iso: iso });
  }

  function resume(id: string): void {
    void patchAccount(id, { paused_until_iso: null });
  }

  async function toggleEnabled(row: AccountListItem): Promise<void> {
    if (togglingId !== null) return;
    setTogglingId(row.id);
    try {
      await patchAccount(row.id, { enabled: row.enabled === 0 });
    } finally {
      setTogglingId(null);
    }
  }

  async function onConfirmDelete(): Promise<void> {
    if (!confirmDelete) return;
    const ok = await deleteAccount(confirmDelete.id);
    if (ok) setConfirmDelete(null);
  }

  return (
    <div className="space-y-4">
      <section>
        <div className="flex items-center gap-3">
          <span
            aria-hidden="true"
            className="inline-block h-5 w-1 rounded-full bg-gradient-to-b from-emerald-300 to-emerald-600 shadow-[0_0_8px_-1px_rgba(16,185,129,0.45)] dark:from-emerald-300 dark:to-emerald-500 dark:shadow-[0_0_12px_-1px_hsl(160_70%_45%/0.6)]"
          />
          <h3 className="text-sm font-bold uppercase tracking-wider text-emerald-900/85 dark:text-emerald-100/90">
            Accounts
          </h3>
          {!loading && accounts.length > 0 && (
            <span className="rounded-full bg-muted px-2 py-0.5 font-mono text-xs font-medium tabular-nums text-muted-foreground">
              {accounts.length}
            </span>
          )}
        </div>
        {error && (
          <p className="mt-2 rounded-lg border border-red-200 bg-red-50 p-2 text-xs text-red-900 dark:border-red-500/30 dark:bg-red-950 dark:text-red-100">
            {error}
          </p>
        )}
        {loading ? (
          <p className="mt-2 text-sm text-muted-foreground">Loading…</p>
        ) : accounts.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">
            No accounts yet. Add your first account below.
          </p>
        ) : (
          <GoogleFlowAccountsTable
            accounts={accounts}
            editing={editable.editing}
            onStartEdit={editable.startEdit}
            onUpdateDraft={editable.updateDraft}
            onCommitEdit={() => void editable.commitEdit()}
            onCancelEdit={editable.cancelEdit}
            onPauseFor={pauseFor}
            onResume={resume}
            onToggleEnabled={(row) => void toggleEnabled(row)}
            togglingId={togglingId}
            onRequestDelete={setConfirmDelete}
          />
        )}
      </section>

      {/* Not a <form>: this component is rendered inside the settings
          <form>, and nested forms are invalid HTML — the browser strips
          the inner tag, which re-routes submit-button clicks to the outer
          form and loses the ?tab= query on the resulting GET submit. */}
      <div className="flex items-end gap-2">
        <div className="flex-1 space-y-1.5">
          <Label
            htmlFor="google-flow-add-account-name"
            className="text-sm font-medium"
          >
            Account name
          </Label>
          <Input
            id="google-flow-add-account-name"
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void onAdd();
              }
            }}
            placeholder="e.g. primary-account"
          />
        </div>
        <Button
          type="button"
          variant="success"
          disabled={adding || newName.trim().length === 0}
          onClick={() => void onAdd()}
        >
          Add account
        </Button>
      </div>

      {minted && (
        <FlowAccountMintedDialog
          minted={minted}
          onClose={() => setMinted(null)}
        />
      )}

      {confirmDelete && (
        <FlowAccountDeleteConfirm
          account={confirmDelete}
          onConfirm={() => void onConfirmDelete()}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}
