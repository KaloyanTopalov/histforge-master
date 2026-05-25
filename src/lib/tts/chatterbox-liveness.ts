/**
 * Reason string passed to `controller.abort()` when the watcher decides
 * the Chatterbox server is unreachable. The synthesize caller checks
 * for this on the internal controller's `signal.reason` to distinguish
 * a liveness-driven abort from a user-driven abort and translate the
 * AbortError into a clearer "server stopped responding" Error.
 */
export const LIVENESS_FAILURE_REASON = "chatterbox_unreachable";

/**
 * Tagged failure shape captured per probe so the watcher can log a
 * specific reason and route the result correctly in `schedule()`.
 * `timeout` means the watcher's own probeTimeoutMs fired — the server
 * didn't respond. Per Option A semantics this does NOT count toward
 * abort (chatterbox-devnen's GIL-blocked /tts makes timeouts ambiguous).
 * `fetch_error` means undici / Node refused to even establish the
 * request — typically ECONNREFUSED (server crashed or never started),
 * ECONNRESET, or DNS failure. Only fetch_error reaches the abort path.
 * Internal — nothing outside this module needs the discriminator.
 */
type ProbeFailureKind = "timeout" | "fetch_error";

interface ProbeFailure {
  kind: ProbeFailureKind;
  /** Pre-formatted reason snippet for the per-probe log line. */
  detail: string;
  /**
   * For `fetch_error` failures, the underlying syscall/dns code if undici
   * surfaced one (`ECONNREFUSED`, `ECONNRESET`, `EHOSTUNREACH`, ...). Used
   * by the summarizer to collapse N identical failures into one phrase.
   */
  code?: string;
}

export interface ChatterboxLivenessOpts {
  /** Base URL of the Chatterbox server. Probe target is `<baseUrl>/health`. */
  baseUrl: string;
  /**
   * Internal AbortController owned by the synthesize caller. The watcher
   * calls `.abort()` on it after `maxConsecutiveFailures` consecutive
   * probe failures so any in-flight fetch using its signal short-circuits.
   * The caller is responsible for forwarding the user's signal into this
   * controller (so the same signal carries either kind of cancellation).
   */
  controller: AbortController;
  /**
   * The user's cancellation signal. The watcher stops cleanly when this
   * fires — user-driven cancel never masquerades as a liveness failure.
   * If omitted, only controller-driven aborts tear the watcher down.
   */
  userSignal?: AbortSignal;
  /** Per-iteration log sink. Defaults to no logging. */
  log?: (message: string) => void;
  /** Interval between probes. Default 15_000 ms. */
  intervalMs?: number;
  /** Wait this long after start before the first probe. Default 10_000 ms. */
  graceMs?: number;
  /** Single-probe timeout. Default 5_000 ms. */
  probeTimeoutMs?: number;
  /** Failures in a row that trigger abort. Default 3. */
  maxConsecutiveFailures?: number;
  /**
   * Test injection for fetch. Defaults to global fetch. The watcher
   * intentionally uses the default dispatcher (not the chatterbox
   * provider's timeouts-disabled dispatcher) so the probe times out
   * fast — the whole point is to detect a stuck server.
   */
  fetch?: typeof fetch;
}

export interface ChatterboxLivenessHandle {
  /** Stop the watcher. Idempotent. Safe to call in `finally`. */
  stop: () => void;
  /**
   * One-line summary of why the watcher aborted, set just before
   * `controller.abort(LIVENESS_FAILURE_REASON)`. Returns `undefined`
   * when the watcher stopped for any other reason (user cancel, normal
   * synthesize completion). Synthesize callers read this in their
   * AbortError catch to build a clearer thrown Error than the static
   * "server stopped responding" text — operators see the dominant
   * failure mode (all timeouts vs all ECONNREFUSED vs mixed) without
   * tailing pipeline.log.
   */
  getFailureSummary: () => string | undefined;
}

const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_GRACE_MS = 10_000;
const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_FAILURES = 3;

/**
 * Background liveness watcher for the Chatterbox server. Periodically
 * GETs `<baseUrl>/health`; if `maxConsecutiveFailures` consecutive
 * probes fail with a definite "server is gone" signal (fetch error
 * with a syscall code like ECONNREFUSED), aborts `controller` so any
 * in-flight `synthesize` fetch using its signal fails fast instead of
 * hanging on a half-open TCP connection.
 *
 * Why this exists: Chatterbox's synthesize endpoints can legitimately
 * take many minutes (long script, slow GPU). The providers therefore
 * disable undici's headersTimeout and bodyTimeout — without that, a
 * 30-minute generation would falsely time out from the client side.
 * The trade-off is that fetch has no way to notice when the server
 * crashes mid-request: on Windows in particular, the OS may keep a
 * half-open TCP socket alive for a long time before surfacing the
 * failure. An application-level liveness probe is the only reliable
 * signal.
 *
 * What counts as alive: any HTTP response (200, 404, 500). The probe
 * tests reachability, not endpoint correctness — even if `/health` is
 * not implemented, a 404 still proves the server is up.
 *
 * Why probe timeouts do NOT count toward the abort threshold:
 * chatterbox-devnen runs as a single uvicorn worker with a sync `/tts`
 * handler that calls `model.generate()`. PyTorch holds the GIL during
 * inference, which blocks every other HTTP handler — including
 * `/health`. A probe timeout therefore proves nothing: the server may
 * be GIL-locked on a multi-minute synthesis, or it may genuinely be
 * wedged. We log timeouts for visibility but treat them as ambiguous.
 * Real crashes still surface as fetch errors on the next probe (kernel
 * closes the listener → ECONNREFUSED on the next connect attempt), so
 * the original "detect a crashed server" use case is preserved without
 * the false positives that killed in-progress turbo-model runs.
 *
 * Composes with the user signal: when `userSignal` aborts, the watcher
 * tears itself down without aborting the controller. The synthesize
 * caller's user-cancel path already covers that — having the watcher
 * also abort would just race two reasons onto the same signal.
 */
export function startChatterboxLivenessWatcher(
  opts: ChatterboxLivenessOpts
): ChatterboxLivenessHandle {
  const {
    baseUrl,
    controller,
    userSignal,
    log,
    intervalMs = DEFAULT_INTERVAL_MS,
    graceMs = DEFAULT_GRACE_MS,
    probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
    maxConsecutiveFailures = DEFAULT_MAX_FAILURES,
    fetch: fetchImpl = fetch,
  } = opts;

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let consecutiveFailures = 0;
  // Per-iteration history of the current failure streak. Reset to []
  // every time a probe succeeds (paired with `consecutiveFailures = 0`).
  // Used to build the abort-time summary and exposed via the handle.
  const recentFailures: ProbeFailure[] = [];
  let failureSummary: string | undefined;

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    userSignal?.removeEventListener("abort", stop);
    controller.signal.removeEventListener("abort", stop);
  };

  if (controller.signal.aborted || userSignal?.aborted) {
    stopped = true;
    return { stop, getFailureSummary: () => failureSummary };
  }

  userSignal?.addEventListener("abort", stop, { once: true });
  controller.signal.addEventListener("abort", stop, { once: true });

  async function probe(): Promise<{ ok: true } | { ok: false; failure: ProbeFailure }> {
    const probeController = new AbortController();
    const probeTimer = setTimeout(
      () => probeController.abort("probe_timeout"),
      probeTimeoutMs
    );
    const userForwarder = () => probeController.abort("user_cancel");
    userSignal?.addEventListener("abort", userForwarder, { once: true });

    try {
      const response = await fetchImpl(`${baseUrl}/health`, {
        method: "GET",
        signal: probeController.signal,
      });
      // Drain the body so undici can free the connection. Failures here
      // are unrelated to liveness (we already have a status code).
      try {
        await response.text();
      } catch {
        // ignore
      }
      return { ok: true };
    } catch (err) {
      // User cancel isn't a server failure — the watcher will tear down
      // via the userSignal listener that fires alongside this rejection.
      if (userSignal?.aborted) {
        return { ok: true };
      }
      // Probe-internal timeout: our own setTimeout fired and called
      // `probeController.abort("probe_timeout")`. The shape of what
      // fetch throws here is *unreliable* — in Node 20+, calling
      // `abort(reasonString)` makes fetch reject with the bare reason
      // string (not an Error), so the previous `isAbortError(err)` guard
      // never fired and timeouts got mislabelled as "fetch failed".
      // Reading `probeController.signal.reason` is the only signal that
      // survives every shape the runtime might pick.
      if (probeController.signal.reason === "probe_timeout") {
        return {
          ok: false,
          failure: {
            kind: "timeout",
            detail: `timed out after ${probeTimeoutMs}ms (server didn't respond — may be blocked generating)`,
          },
        };
      }
      return { ok: false, failure: describeFetchError(err) };
    } finally {
      clearTimeout(probeTimer);
      userSignal?.removeEventListener("abort", userForwarder);
    }
  }

  function schedule(delayMs: number): void {
    if (stopped) return;
    timer = setTimeout(async () => {
      if (stopped) return;
      const result = await probe();
      if (stopped) return;

      if (result.ok) {
        if (consecutiveFailures > 0) {
          log?.(
            `Chatterbox /health probe recovered after ${consecutiveFailures} failure(s)`
          );
        }
        consecutiveFailures = 0;
        recentFailures.length = 0;
      } else if (result.failure.kind === "timeout") {
        // Timeout = ambiguous (server may be GIL-locked during PyTorch
        // inference). Log for operator visibility, but don't touch the
        // failure counter — only fetch-level errors (next branch) prove
        // the server is gone and earn an abort. The streak of connection
        // errors, if any, is preserved through the timeout.
        log?.(
          `Chatterbox /health probe ${result.failure.detail} — server busy on /tts (likely GIL-locked during inference); not counted toward unreachable threshold`
        );
      } else {
        consecutiveFailures++;
        recentFailures.push(result.failure);
        log?.(
          `Chatterbox /health probe failed (${consecutiveFailures}/${maxConsecutiveFailures}): ${result.failure.detail}`
        );
        if (consecutiveFailures >= maxConsecutiveFailures) {
          failureSummary = summarizeFailures(recentFailures);
          log?.(
            `Chatterbox server appears unreachable at ${baseUrl} — ${failureSummary} (aborting in-flight TTS request)`
          );
          controller.abort(LIVENESS_FAILURE_REASON);
          return;
        }
      }
      schedule(intervalMs);
    }, delayMs);

    if (timer && typeof timer.unref === "function") {
      timer.unref();
    }
  }

  schedule(graceMs);
  return { stop, getFailureSummary: () => failureSummary };
}

/**
 * Translate a fetch rejection into a ProbeFailure. undici wraps the
 * underlying syscall error in `err.cause` and that's almost always
 * where the actionable code lives (ECONNREFUSED, ECONNRESET,
 * EHOSTUNREACH, ENOTFOUND, ETIMEDOUT). We surface the code separately
 * (used by the summarizer) and include it in `detail` for the per-probe
 * log line. The bare message is the fallback when undici didn't attach
 * a typed cause (or the test mock used a plain Error).
 */
function describeFetchError(err: unknown): ProbeFailure {
  const message = err instanceof Error ? err.message : String(err);
  const cause =
    err instanceof Error && typeof err.cause === "object" && err.cause !== null
      ? (err.cause as { code?: unknown; message?: unknown })
      : null;
  const code =
    cause && typeof cause.code === "string" && cause.code.length > 0
      ? cause.code
      : undefined;
  const causeMessage =
    cause && typeof cause.message === "string" ? cause.message : "";

  if (code) {
    const extra =
      causeMessage && causeMessage !== message ? `: ${causeMessage}` : "";
    return {
      kind: "fetch_error",
      code,
      detail: `fetch failed (${code}${extra})`,
    };
  }
  // No syscall code — fall back to whichever message is informative.
  // The bare-Error case in tests ("ECONNREFUSED" as message) lands here.
  return { kind: "fetch_error", detail: `fetch failed (${message})` };
}

/**
 * Collapse a run of consecutive fetch-error failures into one summary
 * phrase for the terminal abort log and the synthesize-caller's thrown
 * Error. Timeouts don't reach here (they no longer count toward abort
 * — see the watcher docstring), so we only need to describe connection
 * errors. When every failure in the streak shares one syscall code
 * (the common case — server crashed → every probe gets ECONNREFUSED),
 * we name it; otherwise we keep the phrase generic.
 */
function summarizeFailures(failures: ProbeFailure[]): string {
  const n = failures.length;
  const codes = new Set(
    failures.map((f) => f.code).filter((c): c is string => Boolean(c))
  );
  if (codes.size === 1) {
    const [code] = [...codes];
    return `${n} connection error${n === 1 ? "" : "s"} in a row (${code}) — server appears to have stopped or never started`;
  }
  return `${n} connection error${n === 1 ? "" : "s"} in a row — server appears to have stopped or never started`;
}
