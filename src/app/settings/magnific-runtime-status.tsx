"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface RuntimeStatus {
  running: boolean;
  connected: boolean;
  session_valid: boolean;
  last_error: string | null;
}

interface MagnificRuntimeStatusProps {
  enabled: boolean;
  onAction: (action: "start" | "connect") => void;
}

const POLL_INTERVAL_MS = 5000;

// Four mutually-exclusive UI states derived from `enabled` + the polled
// RuntimeStatus. Centralized here so the JSX below can stay a flat lookup.
type PillState =
  | { kind: "disabled" }
  | { kind: "stopped" }
  | { kind: "expired" }
  | { kind: "connected" };

function deriveState(
  enabled: boolean,
  status: RuntimeStatus | null,
): PillState {
  if (!enabled) return { kind: "disabled" };
  if (!status || !status.running) return { kind: "stopped" };
  if (!status.session_valid) return { kind: "expired" };
  return { kind: "connected" };
}

export function MagnificRuntimeStatus({
  enabled,
  onAction,
}: MagnificRuntimeStatusProps): JSX.Element {
  const [status, setStatus] = useState<RuntimeStatus | null>(null);

  // Hold the latest fetcher in a ref so the interval callback and the
  // visibilitychange handler share one source of truth without restarting
  // the interval on every render.
  const fetcherRef = useRef<() => Promise<void>>(async () => {});
  fetcherRef.current = useCallback(async () => {
    try {
      const res = await fetch("/api/magnific/runtime/status");
      if (!res.ok) return;
      setStatus((await res.json()) as RuntimeStatus);
    } catch {
      // Network blips are non-fatal — the next tick retries. Keeping the
      // last-known status on screen beats flashing the pill to Stopped
      // every time a request races a reload.
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      setStatus(null);
      return;
    }

    let mounted = true;
    const tick = async (): Promise<void> => {
      if (!mounted) return;
      if (document.visibilityState === "hidden") return;
      await fetcherRef.current();
    };

    // Immediate first fetch so the pill catches up without waiting for the
    // first interval tick.
    void tick();
    const id = setInterval(() => void tick(), POLL_INTERVAL_MS);

    const onVisibility = (): void => {
      if (document.visibilityState === "visible") void tick();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      mounted = false;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled]);

  const state = deriveState(enabled, status);

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-3"
    >
      <Pill state={state} />
      {state.kind === "stopped" && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onAction("start")}
        >
          Start
        </Button>
      )}
      {state.kind === "expired" && (
        <Button
          type="button"
          variant="success"
          size="sm"
          onClick={() => onAction("connect")}
        >
          Reconnect
        </Button>
      )}
    </div>
  );
}

function Pill({ state }: { state: PillState }): JSX.Element {
  const label =
    state.kind === "disabled"
      ? "Disabled"
      : state.kind === "stopped"
        ? "Stopped"
        : state.kind === "expired"
          ? "Session expired"
          : "Connected";
  // Color follows the spec's traffic-light scheme: green / amber / red /
  // muted. Dark-mode variants match the rest of the settings surface.
  const color =
    state.kind === "connected"
      ? "bg-emerald-500/15 text-emerald-900 dark:text-emerald-200 ring-emerald-500/40"
      : state.kind === "expired"
        ? "bg-amber-500/15 text-amber-900 dark:text-amber-200 ring-amber-500/40"
        : state.kind === "stopped"
          ? "bg-red-500/15 text-red-900 dark:text-red-200 ring-red-500/40"
          : "bg-slate-500/15 text-slate-700 dark:text-slate-300 ring-slate-500/30";

  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset",
        color,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "h-2 w-2 rounded-full",
          state.kind === "connected"
            ? "bg-emerald-500"
            : state.kind === "expired"
              ? "bg-amber-500"
              : state.kind === "stopped"
                ? "bg-red-500"
                : "bg-slate-400",
        )}
      />
      {label}
    </span>
  );
}
