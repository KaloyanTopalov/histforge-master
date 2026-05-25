import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import type { DraftRow } from "@/lib/workflows-api";

export interface UseDraftsList {
  drafts: DraftRow[];
  loading: boolean;
  refreshing: boolean;
  reload: () => Promise<void>;
}

export function useDraftsList(): UseDraftsList {
  const [drafts, setDrafts] = useState<DraftRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadDrafts = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch("/api/workflows/drafts");
      if (!res.ok) {
        toast.error(`Failed to load drafts (${res.status})`);
        return;
      }
      const list = (await res.json()) as DraftRow[];
      setDrafts(list);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to load drafts",
      );
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await loadDrafts();
      setLoading(false);
    })();
  }, [loadDrafts]);

  const reload = useCallback(async (): Promise<void> => {
    setRefreshing(true);
    try {
      await loadDrafts();
    } finally {
      setRefreshing(false);
    }
  }, [loadDrafts]);

  return { drafts, loading, refreshing, reload };
}
