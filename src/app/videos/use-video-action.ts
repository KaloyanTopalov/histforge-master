"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

export type ActionOnSuccess = "router-refresh" | (() => void);

export type ActionErrorToast = false | string | { fallback: string };

export type ActionTimeoutToast = false | string;

export interface BusyHandle {
  isBusy: boolean;
  setBusy: (busy: boolean) => void;
}

export interface WaitFor {
  pollNow: () => Promise<void>;
  predicate: () => boolean;
}

export interface ActionOptions {
  url: string;
  onSuccess: ActionOnSuccess;
  errorToast: ActionErrorToast;
  timeoutToast?: ActionTimeoutToast;
  busy: BusyHandle;
  waitFor?: WaitFor;
}

const WAIT_FOR_TIMEOUT_MS = 8000;
const WAIT_FOR_POLL_MS = 250;
const WAIT_FOR_TIMEOUT_MESSAGE =
  "Action submitted but state hasn't updated yet — try again if needed.";

/**
 * Centralises the fetch + busy-flag + error-toast loop the videos list
 * page reuses for its five mutation handlers. Each call site declares two
 * choices the audit (Finding #2) called out as too implicit:
 *
 *   onSuccess:    "router-refresh" (server is source of truth — wait for next
 *                                   refresh to surface the change)
 *                 () => void       (optimistic local-state setter for instant
 *                                   feedback)
 *
 *   errorToast:   false            (silent on POST-failure — the route returns
 *                                   no actionable info; the next poll will
 *                                   surface state)
 *                 string           (constant message on POST-failure)
 *                 { fallback }     (POST-failure: parse `body.message`, fall
 *                                   back if missing)
 *
 *   timeoutToast: undefined        (default — generic message fires on the 8 s
 *                                   wait-for timeout)
 *                 false            (silent on timeout)
 *                 string           (custom message on timeout)
 *
 *   waitFor:      undefined        (busy clears when the POST resolves — today's
 *                                   default; spinner duration tracks fetch time)
 *                 { pollNow,       (busy stays true after a 2xx until predicate()
 *                    predicate }    turns true or 8 s elapses; pollNow is invoked
 *                                   once up front to shorten the wait. The
 *                                   `timeoutToast` knob alone controls the
 *                                   timeout-branch toast; `errorToast` does not.)
 *
 * `errorToast` and `timeoutToast` are independent: a caller can pick any
 * combination of POST-failure-policy × timeout-policy.
 *
 * `busy` stays at the call site because the two shapes differ — scalar
 * handlers own a boolean; row handlers write through `RowInflight`.
 */
export function useVideoAction(): (opts: ActionOptions) => Promise<void> {
  const router = useRouter();
  const activeIntervalsRef = useRef<Set<ReturnType<typeof setInterval>>>(
    new Set()
  );

  useEffect(() => {
    const intervals = activeIntervalsRef.current;
    return () => {
      for (const id of intervals) clearInterval(id);
      intervals.clear();
    };
  }, []);

  return async function run({
    url,
    onSuccess,
    errorToast,
    timeoutToast,
    busy,
    waitFor,
  }: ActionOptions): Promise<void> {
    if (busy.isBusy) return;
    busy.setBusy(true);
    try {
      let res: Response;
      try {
        res = await fetch(url, { method: "POST" });
      } catch {
        // Network-layer failure (TypeError: Failed to fetch). The route
        // never ran, so `body.message` is unavailable — fall back to the
        // configured constant/`fallback` string. Letting the throw escape
        // surfaces as an unhandled rejection in the dev overlay; routing
        // it through the same `errorToast` policy as a non-2xx response
        // gives the user the toast they'd expect and keeps the busy
        // flag's `finally` cleanup the only state change.
        if (errorToast === false) return;
        toast.error(
          typeof errorToast === "string" ? errorToast : errorToast.fallback
        );
        return;
      }
      if (res.ok) {
        if (onSuccess === "router-refresh") {
          router.refresh();
        } else {
          onSuccess();
        }
        if (waitFor) {
          await waitFor.pollNow().catch(() => undefined);
          if (waitFor.predicate()) return;
          await waitForPredicate(
            waitFor.predicate,
            timeoutToast,
            activeIntervalsRef.current
          );
        }
        return;
      }

      if (errorToast === false) return;
      if (typeof errorToast === "string") {
        toast.error(errorToast);
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      toast.error(body.message ?? errorToast.fallback);
    } finally {
      busy.setBusy(false);
    }
  };
}

function waitForPredicate(
  predicate: () => boolean,
  timeoutToast: ActionTimeoutToast | undefined,
  activeIntervals: Set<ReturnType<typeof setInterval>>
): Promise<void> {
  return new Promise<void>((resolve) => {
    const startedAt = Date.now();
    const intervalId = setInterval(() => {
      if (predicate()) {
        clearInterval(intervalId);
        activeIntervals.delete(intervalId);
        resolve();
        return;
      }
      if (Date.now() - startedAt >= WAIT_FOR_TIMEOUT_MS) {
        clearInterval(intervalId);
        activeIntervals.delete(intervalId);
        if (timeoutToast !== false) {
          toast.error(
            typeof timeoutToast === "string"
              ? timeoutToast
              : WAIT_FOR_TIMEOUT_MESSAGE
          );
        }
        resolve();
      }
    }, WAIT_FOR_POLL_MS);
    activeIntervals.add(intervalId);
  });
}
