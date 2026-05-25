"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import type { AllSettings } from "@/lib/settings";
import {
  type TabId,
  TABS,
  TAB_FIELDS,
  isTabId,
} from "@/lib/settings-tabs";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import {
  Film,
  ImagePlus,
  Mic,
  Palette,
  ScrollText,
  Wand2,
  Workflow,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { TtsSettings } from "./tts-settings";
import { ComfyuiTab } from "./comfyui-tab";
import { GoogleFlowTab } from "./google-flow-tab";
import { MagnificTab } from "./magnific-tab";
import { RenderTab } from "./render-tab";
import { ScriptTab } from "./script-tab";
import { VisualStyleTab } from "./visual-style-tab";

const TAB_ICONS: Record<TabId, LucideIcon> = {
  script: ScrollText,
  "visual-style": Palette,
  tts: Mic,
  "google-flow": Workflow,
  magnific: ImagePlus,
  comfyui: Wand2,
  render: Film,
};

interface SettingsFormProps {
  initial: AllSettings;
}

/**
 * Compute the set of keys whose current form value differs from the
 * baseline snapshot. Only dirty keys are included in the PATCH body.
 */
function dirtyDiff(
  current: AllSettings,
  snapshot: AllSettings
): Partial<AllSettings> {
  const out: Partial<AllSettings> = {};
  for (const key of Object.keys(current) as Array<keyof AllSettings>) {
    if (current[key] !== snapshot[key]) {
      (out as Record<string, unknown>)[key] = current[key];
    }
  }
  return out;
}

/**
 * Settings form. Plain controlled inputs over AllSettings; the submit
 * handler computes a dirty-diff from the initial snapshot and PATCHes
 * only changed fields. All per-field validation lives in the route —
 * this form surfaces the API's error message on failure.
 */
export function SettingsForm({
  initial,
}: SettingsFormProps): JSX.Element {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const initialTab: TabId = isTabId(searchParams?.get("tab") ?? null)
    ? (searchParams!.get("tab") as TabId)
    : "script";
  const [activeTab, setActiveTab] = useState<TabId>(initialTab);
  const [values, setValues] = useState<AllSettings>(initial);
  // Snapshot of what the server last told us; the dirty-diff baseline.
  // Updated to `values` on successful save so subsequent edits are
  // measured from the new ground truth.
  const [snapshot, setSnapshot] = useState<AllSettings>(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  // Tabs whose child component reports external dirt (state outside the
  // settings PATCH model — e.g. the visual-styles gallery, which owns its
  // own REST round-trips). Drives only the per-tab dot and the cross-tab
  // warn intercept; never merged into the settings PATCH body.
  const [externalDirtyTabs, setExternalDirtyTabs] = useState<Set<TabId>>(
    () => new Set()
  );
  // Per-tab confirm callbacks registered by tab-owned components. When the
  // user navigates away from a tab whose external dirt is set, the form
  // asks the registered callback whether to proceed.
  const confirmDiscardRef = useRef<Map<TabId, () => boolean>>(new Map());

  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), 3000);
    return () => clearTimeout(timer);
  }, [saved]);

  const handleDirtyChange = useCallback(
    (tabId: TabId, dirty: boolean): void => {
      setExternalDirtyTabs((prev) => {
        const has = prev.has(tabId);
        if (dirty === has) return prev;
        const next = new Set(prev);
        if (dirty) next.add(tabId);
        else next.delete(tabId);
        return next;
      });
    },
    []
  );

  const registerConfirmDiscard = useCallback(
    (tabId: TabId, fn: (() => boolean) | null): void => {
      if (fn) confirmDiscardRef.current.set(tabId, fn);
      else confirmDiscardRef.current.delete(tabId);
    },
    []
  );

  // Per-tab stable wrappers — child components mount useEffects that
  // depend on these callbacks; if we pass inline arrows the effect tears
  // down and re-mounts on every parent render, briefly losing the
  // confirm-discard registration. useCallback pins the references.
  const onVisualStyleDirtyChange = useCallback(
    (dirty: boolean) => handleDirtyChange("visual-style", dirty),
    [handleDirtyChange]
  );
  const registerVisualStyleConfirmDiscard = useCallback(
    (fn: (() => boolean) | null) =>
      registerConfirmDiscard("visual-style", fn),
    [registerConfirmDiscard]
  );

  function selectTab(id: TabId): void {
    if (externalDirtyTabs.has(activeTab)) {
      const confirmFn = confirmDiscardRef.current.get(activeTab);
      if (confirmFn && !confirmFn()) return;
    }
    setActiveTab(id);
    setSaved(false);
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    params.set("tab", id);
    const basePath = pathname ?? "";
    router.replace(`${basePath}?${params.toString()}`);
  }

  function tabIsDirty(id: TabId): boolean {
    if (externalDirtyTabs.has(id)) return true;
    return TAB_FIELDS[id].some((key) => values[key] !== snapshot[key]);
  }

  function update<K extends keyof AllSettings>(
    key: K,
    value: AllSettings[K]
  ): void {
    setValues((v) => ({ ...v, [key]: value }));
    setSaved(false);
  }

  // Used by tab-owned mutations that bypass the normal form save (e.g.
  // the Magnific token rotate, which writes server-side and returns the
  // new value). Advances both the current value and the dirty-diff
  // baseline so the tab indicator doesn't pop after a successful
  // server-driven update.
  function syncBaseline<K extends keyof AllSettings>(
    key: K,
    value: AllSettings[K]
  ): void {
    setValues((v) => ({ ...v, [key]: value }));
    setSnapshot((s) => ({ ...s, [key]: value }));
  }

  const syncMagnificToken = useCallback(
    (token: string) => syncBaseline("magnific_token", token),
    []
  );

  async function save(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const diff = dirtyDiff(values, snapshot);
      if (Object.keys(diff).length === 0) {
        // Nothing to save — show the success flash so the user gets
        // feedback and avoid a no-op PATCH.
        setSaved(true);
        return;
      }
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(diff),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.message ?? `Save failed (${res.status})`);
        return;
      }
      setSnapshot(values);
      setSaved(true);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="space-y-6">
      <Tabs
        value={activeTab}
        onValueChange={(v) => selectTab(v as TabId)}
        className="mt-2"
      >
        <TabsList className="flex h-auto w-full flex-wrap items-stretch justify-start gap-1.5 rounded-xl border border-slate-200 bg-slate-100 p-1.5 dark:border-[hsl(225_20%_18%)] dark:bg-[hsl(228_22%_8%)] dark:shadow-[inset_0_1px_0_hsl(0_0%_0%/0.4)]">
          {TABS.map((t) => {
            const dirty = tabIsDirty(t.id);
            const Icon = TAB_ICONS[t.id];
            return (
              <TabsTrigger
                key={t.id}
                value={t.id}
                data-dirty={dirty}
                className="group relative h-10 gap-2 rounded-lg px-3.5 text-sm font-semibold transition-all
                  data-[state=inactive]:text-muted-foreground
                  data-[state=inactive]:hover:bg-card data-[state=inactive]:hover:text-foreground
                  data-[state=inactive]:dark:hover:bg-[hsl(225_22%_11%)] data-[state=inactive]:dark:hover:text-foreground
                  data-[state=active]:bg-card data-[state=active]:text-foreground
                  data-[state=active]:shadow-[0_2px_8px_-3px_rgba(0,0,0,0.12),0_0_0_1px_hsl(var(--border))]
                  data-[state=active]:dark:bg-[hsl(222_22%_15%)]
                  data-[state=active]:dark:shadow-[0_2px_10px_-3px_rgba(0,0,0,0.5),0_0_0_1px_hsl(225_22%_24%),inset_0_1px_0_hsl(222_25%_26%/0.5)]"
              >
                <Icon
                  aria-hidden="true"
                  className="h-4 w-4 transition-colors group-data-[state=active]:text-emerald-700 group-data-[state=active]:dark:text-emerald-300"
                />
                <span>{t.label}</span>
                {dirty && (
                  <span
                    aria-hidden="true"
                    className="-ml-0.5 inline-block h-1.5 w-1.5 rounded-full bg-orange-500 dark:bg-orange-400"
                  />
                )}
              </TabsTrigger>
            );
          })}
        </TabsList>

        <TabsContent value="script" className="mt-8">
          <ScriptTab values={values} update={update} />
        </TabsContent>

        <TabsContent value="visual-style" className="mt-8">
          <VisualStyleTab
            onDirtyChange={onVisualStyleDirtyChange}
            registerConfirmDiscard={registerVisualStyleConfirmDiscard}
          />
        </TabsContent>

        <TabsContent value="tts" className="mt-8">
          <TtsSettings values={values} update={update} />
        </TabsContent>

        <TabsContent value="google-flow" className="mt-8">
          <GoogleFlowTab values={values} update={update} />
        </TabsContent>

        <TabsContent value="magnific" className="mt-8">
          <MagnificTab
            values={values}
            update={update}
            syncTokenBaseline={syncMagnificToken}
          />
        </TabsContent>

        <TabsContent value="comfyui" className="mt-8">
          <ComfyuiTab values={values} update={update} />
        </TabsContent>

        <TabsContent value="render" className="mt-8">
          <RenderTab values={values} update={update} />
        </TabsContent>
      </Tabs>

      {TAB_FIELDS[activeTab].length > 0 && (
        <>
          {error && (
            <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-500/30 dark:bg-red-950 dark:text-red-100">
              {error}
            </p>
          )}
          {saved && (
            <p className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-500/30 dark:bg-emerald-950 dark:text-emerald-100">
              Saved.
            </p>
          )}

          <div className="flex items-center gap-3 border-t pt-4">
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </div>
        </>
      )}
    </form>
  );
}

