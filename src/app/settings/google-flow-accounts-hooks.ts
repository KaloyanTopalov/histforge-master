"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { AccountListItem } from "@/lib/flow-account-status";

export interface MintedAccount {
  id: string;
  name: string;
  token: string;
  pollUrl: string;
  resultUrl: string;
  statusUrl: string;
  projectUrl: string;
}

export interface UseFlowAccountsResult {
  accounts: AccountListItem[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  patchAccount: (id: string, body: Record<string, unknown>) => Promise<void>;
  addAccount: (name: string) => Promise<MintedAccount | null>;
  deleteAccount: (id: string) => Promise<boolean>;
}

/**
 * Owns the Google Flow accounts list and its server mutators. Every
 * mutation re-fetches rather than optimistically patching — the server
 * is the source of truth for auto-reset fields like `paused_until` that
 * reset on resume.
 */
export function useFlowAccounts(): UseFlowAccountsResult {
  const router = useRouter();
  const [accounts, setAccounts] = useState<AccountListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const res = await fetch("/api/flow/accounts");
      if (!res.ok) {
        setError(`Failed to load accounts (${res.status})`);
        return;
      }
      const body = (await res.json()) as { accounts: AccountListItem[] };
      setAccounts(body.accounts);
      setError(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const patchAccount = useCallback(
    async (id: string, body: Record<string, unknown>) => {
      const res = await fetch(`/api/flow/accounts/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setError(`Update failed (${res.status})`);
        return;
      }
      await reload();
      router.refresh();
    },
    [reload, router]
  );

  const addAccount = useCallback(
    async (name: string): Promise<MintedAccount | null> => {
      setError(null);
      const res = await fetch("/api/flow/accounts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        setError(`Failed to create account (${res.status})`);
        return null;
      }
      const body = (await res.json()) as MintedAccount;
      await reload();
      router.refresh();
      return body;
    },
    [reload, router]
  );

  const deleteAccount = useCallback(
    async (id: string): Promise<boolean> => {
      const res = await fetch(`/api/flow/accounts/${id}`, { method: "DELETE" });
      if (!res.ok) {
        setError(`Delete failed (${res.status})`);
        return false;
      }
      await reload();
      router.refresh();
      return true;
    },
    [reload, router]
  );

  return {
    accounts,
    loading,
    error,
    reload,
    patchAccount,
    addAccount,
    deleteAccount,
  };
}

export interface UseEditableNameResult {
  editing: { id: string; draft: string } | null;
  startEdit: (id: string, currentName: string) => void;
  updateDraft: (draft: string) => void;
  cancelEdit: () => void;
  commitEdit: () => Promise<void>;
}

/**
 * Inline-edit state machine for the per-row name field. The committer
 * receives `(id, trimmedName)` only when the user actually changed the
 * name to something non-empty; identical / empty drafts close the
 * editor without firing the mutation.
 *
 * `getCurrentName` is invoked at commit time so a concurrent reload
 * that landed mid-edit is honoured.
 */
export function useEditableName(
  commit: (id: string, name: string) => Promise<void>,
  getCurrentName: (id: string) => string | undefined
): UseEditableNameResult {
  const [editing, setEditing] = useState<{ id: string; draft: string } | null>(
    null
  );

  const startEdit = useCallback((id: string, currentName: string) => {
    setEditing({ id, draft: currentName });
  }, []);

  const updateDraft = useCallback((draft: string) => {
    setEditing((prev) => (prev ? { ...prev, draft } : null));
  }, []);

  const cancelEdit = useCallback(() => {
    setEditing(null);
  }, []);

  const commitEdit = useCallback(async () => {
    if (!editing) return;
    const trimmed = editing.draft.trim();
    const current = getCurrentName(editing.id);
    if (
      trimmed.length === 0 ||
      current === undefined ||
      trimmed === current
    ) {
      setEditing(null);
      return;
    }
    const id = editing.id;
    setEditing(null);
    await commit(id, trimmed);
  }, [editing, commit, getCurrentName]);

  return { editing, startEdit, updateDraft, cancelEdit, commitEdit };
}
