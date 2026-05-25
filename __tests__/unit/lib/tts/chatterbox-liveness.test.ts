import { describe, it, expect, vi, afterEach } from "vitest";
import {
  LIVENESS_FAILURE_REASON,
  startChatterboxLivenessWatcher,
} from "@/lib/tts/chatterbox-liveness";

/**
 * Liveness-watcher unit tests. Drives the watcher with a fake `fetch`
 * and zero-ish timers (`graceMs: 0`, `intervalMs: 0`, `probeTimeoutMs:
 * 1`) so tests resolve in macrotasks rather than wall-clock waits.
 *
 * Determinism trick: instead of `setTimeout(...)` waits, tests `await
 * whenAborted(controller.signal)` so the assertion runs immediately
 * after the watcher actually decides to abort. For "alive" cases we
 * count probe calls inside the fetch mock and resolve a marker
 * promise after N calls — same idea, just driven by the probe count.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

function whenAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

describe("startChatterboxLivenessWatcher", () => {
  it("aborts the controller after N consecutive probe failures with LIVENESS_FAILURE_REASON", async () => {
    const controller = new AbortController();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("ECONNREFUSED"));

    const handle = startChatterboxLivenessWatcher({
      baseUrl: "http://127.0.0.1:9999",
      controller,
      fetch: fetchMock,
      graceMs: 0,
      intervalMs: 0,
      probeTimeoutMs: 50,
      maxConsecutiveFailures: 3,
    });

    await whenAborted(controller.signal);
    handle.stop();

    expect(controller.signal.reason).toBe(LIVENESS_FAILURE_REASON);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // URL is the configured base + /health.
    expect(fetchMock.mock.calls[0][0]).toBe("http://127.0.0.1:9999/health");
  });

  it("any HTTP response (including 404 / 500) counts as alive — only fetch errors fail", async () => {
    const controller = new AbortController();
    let calls = 0;
    let resolveFifth!: () => void;
    const fifthCall = new Promise<void>((r) => (resolveFifth = r));

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => {
        calls++;
        if (calls === 5) resolveFifth();
        // Alternate 404 and 500 — the probe must treat both as "server alive".
        return new Response("nope", { status: calls % 2 ? 404 : 500 });
      });

    const handle = startChatterboxLivenessWatcher({
      baseUrl: "http://test",
      controller,
      fetch: fetchMock,
      graceMs: 0,
      intervalMs: 0,
      probeTimeoutMs: 50,
      maxConsecutiveFailures: 3,
    });

    await fifthCall;
    handle.stop();

    expect(controller.signal.aborted).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(calls);
    expect(calls).toBeGreaterThanOrEqual(5);
  });

  it("resets the consecutive-failure counter after a successful probe", async () => {
    const controller = new AbortController();
    // Pattern: fail, fail, success, fail, fail, success, fail, fail, success...
    // With maxConsecutiveFailures=3, we'd never reach 3 in a row, so no abort.
    let call = 0;
    let resolveSeventh!: () => void;
    const seventhCall = new Promise<void>((r) => (resolveSeventh = r));

    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => {
      call++;
      if (call === 7) resolveSeventh();
      // Every 3rd call succeeds — counter never reaches 3 consecutive.
      if (call % 3 === 0) {
        return new Response("ok", { status: 200 });
      }
      throw new Error("transient");
    });

    const handle = startChatterboxLivenessWatcher({
      baseUrl: "http://test",
      controller,
      fetch: fetchMock,
      graceMs: 0,
      intervalMs: 0,
      probeTimeoutMs: 50,
      maxConsecutiveFailures: 3,
    });

    await seventhCall;
    handle.stop();

    expect(controller.signal.aborted).toBe(false);
  });

  it("stops cleanly on userSignal abort without aborting the controller", async () => {
    const controller = new AbortController();
    const userController = new AbortController();
    let callCount = 0;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => {
        callCount++;
        throw new Error("ECONNREFUSED");
      });

    const handle = startChatterboxLivenessWatcher({
      baseUrl: "http://test",
      controller,
      userSignal: userController.signal,
      fetch: fetchMock,
      graceMs: 0,
      intervalMs: 0,
      probeTimeoutMs: 50,
      maxConsecutiveFailures: 3,
    });

    // Abort user signal before any probe gets a chance to fire enough
    // times to trigger the controller. Allow the event loop to run a
    // couple of ticks first so we exercise the listener path rather
    // than the early-return short-circuit.
    await Promise.resolve();
    userController.abort("user-cancel");

    // Wait a tick to allow any in-flight scheduled callback to settle.
    await new Promise((r) => setTimeout(r, 20));
    handle.stop();

    expect(controller.signal.aborted).toBe(false);
    // Even if a probe was in flight when user-cancel landed, we should
    // never have aborted the controller ourselves.
    expect(controller.signal.reason).not.toBe(LIVENESS_FAILURE_REASON);
    // Probes may have run a couple of times before user-cancel landed;
    // not asserting an exact count would be flaky. Just bound it above.
    expect(callCount).toBeLessThan(10);
  });

  it("does not start probing if the controller is already aborted", async () => {
    const controller = new AbortController();
    controller.abort("pre-aborted");
    const fetchMock = vi.fn<typeof fetch>();

    const handle = startChatterboxLivenessWatcher({
      baseUrl: "http://test",
      controller,
      fetch: fetchMock,
      graceMs: 0,
      intervalMs: 0,
      probeTimeoutMs: 50,
      maxConsecutiveFailures: 1,
    });

    await new Promise((r) => setTimeout(r, 20));
    handle.stop();

    expect(fetchMock).not.toHaveBeenCalled();
    // Reason was set by the test, not by the watcher.
    expect(controller.signal.reason).toBe("pre-aborted");
  });

  it("stop() is idempotent and safe in finally", () => {
    const controller = new AbortController();
    const fetchMock = vi.fn<typeof fetch>();

    const handle = startChatterboxLivenessWatcher({
      baseUrl: "http://test",
      controller,
      fetch: fetchMock,
      graceMs: 1_000,
      intervalMs: 1_000,
      probeTimeoutMs: 50,
      maxConsecutiveFailures: 3,
    });

    expect(() => {
      handle.stop();
      handle.stop();
      handle.stop();
    }).not.toThrow();
    expect(controller.signal.aborted).toBe(false);
  });

  it("emits a recovery log when probes succeed after consecutive failures", async () => {
    const controller = new AbortController();
    const log = vi.fn();

    let call = 0;
    let resolveAfterRecovery!: () => void;
    const afterRecovery = new Promise<void>((r) => (resolveAfterRecovery = r));

    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => {
      call++;
      if (call <= 2) throw new Error("ECONNREFUSED");
      // Resolve once we've seen the recovery log fire — the probe
      // immediately after the recovering call.
      if (call === 4) resolveAfterRecovery();
      return new Response("ok", { status: 200 });
    });

    const handle = startChatterboxLivenessWatcher({
      baseUrl: "http://test",
      controller,
      fetch: fetchMock,
      log,
      graceMs: 0,
      intervalMs: 0,
      probeTimeoutMs: 50,
      maxConsecutiveFailures: 5,
    });

    await afterRecovery;
    handle.stop();

    const messages = log.mock.calls.map((c) => c[0] as string).join("\n");
    expect(messages).toMatch(/recovered after 2 failure/i);
    expect(controller.signal.aborted).toBe(false);
  });

  it("probe timeouts are logged but do NOT trigger abort — server may be busy on /tts", async () => {
    // chatterbox-devnen is a single uvicorn worker; PyTorch holds the
    // GIL during model.generate() so /health can't respond while /tts
    // is running. A probe timeout therefore proves nothing — only
    // definite "server is gone" signals (fetch errors like
    // ECONNREFUSED) should earn an abort. Lock that the watcher keeps
    // probing through any number of consecutive timeouts.
    const controller = new AbortController();
    const log = vi.fn();
    let calls = 0;
    let resolveFifth!: () => void;
    const fifthCall = new Promise<void>((r) => (resolveFifth = r));

    const fetchMock = vi.fn<typeof fetch>().mockImplementation((_url, init) => {
      return new Promise((_resolve, reject) => {
        const sig = (init as RequestInit | undefined)?.signal;
        sig?.addEventListener("abort", () => {
          calls++;
          if (calls === 5) resolveFifth();
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });

    const handle = startChatterboxLivenessWatcher({
      baseUrl: "http://test",
      controller,
      fetch: fetchMock,
      log,
      graceMs: 0,
      intervalMs: 0,
      probeTimeoutMs: 5,
      maxConsecutiveFailures: 2,
    });

    await fifthCall;
    handle.stop();

    expect(controller.signal.aborted).toBe(false);
    expect(handle.getFailureSummary()).toBeUndefined();
    const lines = log.mock.calls.map((c) => c[0] as string);
    // Per-probe line names the timeout and explains the "not counted" rule.
    expect(
      lines.some((l) =>
        /timed out.*not counted toward unreachable threshold/i.test(l)
      )
    ).toBe(true);
    // No "unreachable" abort log fired.
    expect(lines.some((l) => /appears unreachable/i.test(l))).toBe(false);
  });

  it("classifies a probe timeout correctly when fetch rejects with the bare string reason (Node 20+ shape)", async () => {
    // Regression: Node's fetch, when aborted via `controller.abort(reason)`
    // with a *string* reason, rejects with the bare string — not an
    // AbortError. The watcher must still call this a timeout (not a
    // generic "fetch failed (probe_timeout)") so the new "timeouts
    // don't count" rule actually kicks in. Signal-reason check (not
    // error-shape) is what makes this reliable.
    const controller = new AbortController();
    const log = vi.fn();
    let calls = 0;
    let resolveThird!: () => void;
    const thirdCall = new Promise<void>((r) => (resolveThird = r));

    const fetchMock = vi.fn<typeof fetch>().mockImplementation((_url, init) => {
      return new Promise((_resolve, reject) => {
        const sig = (init as RequestInit | undefined)?.signal;
        sig?.addEventListener("abort", () => {
          calls++;
          if (calls === 3) resolveThird();
          // Mirror what Node's real fetch does: reject with the bare
          // reason string when abort was called with a string reason.
          reject(sig.reason);
        });
      });
    });

    const handle = startChatterboxLivenessWatcher({
      baseUrl: "http://test",
      controller,
      fetch: fetchMock,
      log,
      graceMs: 0,
      intervalMs: 0,
      probeTimeoutMs: 5,
      maxConsecutiveFailures: 2,
    });

    await thirdCall;
    handle.stop();

    expect(controller.signal.aborted).toBe(false);
    const lines = log.mock.calls.map((c) => c[0] as string);
    // Must be labelled as a timeout, not "fetch failed (probe_timeout)".
    expect(lines.some((l) => /timed out/i.test(l))).toBe(true);
    expect(lines.some((l) => /fetch failed/i.test(l))).toBe(false);
  });

  it("mixed streak: timeouts interleaved with ECONNREFUSED — only the connection errors count", async () => {
    // Locks the rule: timeouts don't reset the failure counter, but
    // they also don't increment it. ECONNREFUSED, timeout, ECONNREFUSED
    // = 2 counted connection errors → abort at threshold 2.
    const controller = new AbortController();
    const log = vi.fn();
    let call = 0;

    const fetchMock = vi.fn<typeof fetch>().mockImplementation((_url, init) => {
      call++;
      // Calls 1 and 3 → ECONNREFUSED. Call 2 → timeout (hang until probe aborts).
      if (call === 2) {
        return new Promise((_resolve, reject) => {
          const sig = (init as RequestInit | undefined)?.signal;
          sig?.addEventListener("abort", () => reject(sig.reason));
        });
      }
      const err = new TypeError("fetch failed");
      (err as Error & { cause?: unknown }).cause = {
        code: "ECONNREFUSED",
        message: "connect ECONNREFUSED 127.0.0.1:8004",
      };
      return Promise.reject(err);
    });

    const handle = startChatterboxLivenessWatcher({
      baseUrl: "http://127.0.0.1:8004",
      controller,
      fetch: fetchMock,
      log,
      graceMs: 0,
      intervalMs: 0,
      probeTimeoutMs: 5,
      maxConsecutiveFailures: 2,
    });

    await whenAborted(controller.signal);
    handle.stop();

    expect(controller.signal.reason).toBe(LIVENESS_FAILURE_REASON);
    // The counter logs are 1/2 for the first ECONNREFUSED and 2/2 for
    // the second — the timeout between them is not counted.
    const lines = log.mock.calls.map((c) => c[0] as string);
    expect(lines.some((l) => /probe failed \(1\/2\).*ECONNREFUSED/i.test(l))).toBe(
      true
    );
    expect(lines.some((l) => /timed out.*not counted/i.test(l))).toBe(true);
    expect(lines.some((l) => /probe failed \(2\/2\).*ECONNREFUSED/i.test(l))).toBe(
      true
    );
    // Summary names only the connection errors — the timeout is invisible
    // to the failure summary.
    expect(handle.getFailureSummary()).toMatch(
      /2 connection errors.*ECONNREFUSED/i
    );
    expect(handle.getFailureSummary()).not.toMatch(/timed out/i);
  });

  it("per-probe log surfaces the undici cause code (ECONNREFUSED) and summary names it", async () => {
    // When undici / Node refuse to even establish a connection, the
    // syscall code lives on err.cause.code. Surfacing it in the log
    // (and the summary) gives the operator a direct "the server is
    // down" signal — the alternative is reading the cause off the
    // stack trace in the failed-step row.
    const controller = new AbortController();
    const log = vi.fn();

    // Mirror undici's TypeError shape: top-level "fetch failed" with
    // the actionable syscall code under `cause`.
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => {
      const err = new TypeError("fetch failed");
      (err as Error & { cause?: unknown }).cause = {
        code: "ECONNREFUSED",
        message: "connect ECONNREFUSED 127.0.0.1:9999",
      };
      throw err;
    });

    const handle = startChatterboxLivenessWatcher({
      baseUrl: "http://127.0.0.1:9999",
      controller,
      fetch: fetchMock,
      log,
      graceMs: 0,
      intervalMs: 0,
      probeTimeoutMs: 50,
      maxConsecutiveFailures: 3,
    });

    await whenAborted(controller.signal);
    handle.stop();

    const lines = log.mock.calls.map((c) => c[0] as string);
    expect(lines.some((l) => /probe failed.*ECONNREFUSED/i.test(l))).toBe(
      true
    );
    expect(
      lines.some((l) =>
        /server appears unreachable.*3 connection errors.*ECONNREFUSED.*stopped or never started/i.test(
          l
        )
      )
    ).toBe(true);
    expect(handle.getFailureSummary()).toMatch(/ECONNREFUSED/);
  });

  it("getFailureSummary returns undefined when the watcher stops without aborting", () => {
    const controller = new AbortController();
    const fetchMock = vi.fn<typeof fetch>();
    const handle = startChatterboxLivenessWatcher({
      baseUrl: "http://test",
      controller,
      fetch: fetchMock,
      graceMs: 60_000,
      intervalMs: 60_000,
      probeTimeoutMs: 50,
      maxConsecutiveFailures: 3,
    });

    handle.stop();
    expect(handle.getFailureSummary()).toBeUndefined();
  });

  it("falls back to a generic message when undici did not attach a cause code", async () => {
    // The test mocks in chatterbox-liveness.test.ts often throw bare
    // Error("ECONNREFUSED") with no `.cause` — same path as a plain JS
    // rejection. The summary must still be informative.
    const controller = new AbortController();
    const log = vi.fn();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("ECONNREFUSED"));

    const handle = startChatterboxLivenessWatcher({
      baseUrl: "http://test",
      controller,
      fetch: fetchMock,
      log,
      graceMs: 0,
      intervalMs: 0,
      probeTimeoutMs: 50,
      maxConsecutiveFailures: 2,
    });

    await whenAborted(controller.signal);
    handle.stop();

    const lines = log.mock.calls.map((c) => c[0] as string);
    expect(lines.some((l) => /probe failed.*fetch failed.*ECONNREFUSED/i.test(l))).toBe(
      true
    );
    // Without a code, the summary doesn't name a specific syscall but
    // still classifies the streak as a connection-error streak.
    expect(handle.getFailureSummary()).toMatch(
      /2 connection errors.*stopped or never started/i
    );
  });
});
