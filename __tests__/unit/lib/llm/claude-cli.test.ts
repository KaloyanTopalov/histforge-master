import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { EventEmitter } from "node:events";

/**
 * Mock `child_process.spawn` at the module boundary — that's the system
 * boundary (the local `claude` binary). Provider is a pure transport:
 * callers pass `opts.model` explicitly; binary is hardcoded to `claude`.
 * No DB/settings dependency.
 */
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    default: { ...actual, spawn: spawnMock },
    spawn: spawnMock,
  };
});

const { chat } = await import("@/lib/llm/claude-cli");

type FakeChild = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { end: ReturnType<typeof vi.fn> };
  kill: ReturnType<typeof vi.fn>;
};

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  // .end(chunk, encoding) is how we pipe the prompt — tests assert on its args.
  child.stdin = { end: vi.fn() };
  child.kill = vi.fn();
  return child;
}

function emitClose(child: FakeChild, code: number, stdout = "", stderr = "") {
  // Defer so the awaiting Promise has wired up its listeners.
  setImmediate(() => {
    if (stdout) child.stdout.emit("data", Buffer.from(stdout));
    if (stderr) child.stderr.emit("data", Buffer.from(stderr));
    child.emit("close", code);
  });
}

beforeEach(() => {
  spawnMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("claudeCliProvider.chat", () => {
  it("spawns the claude binary with -p and --model; pipes prompt over stdin; returns trimmed stdout", async () => {
    const child = fakeChild();
    spawnMock.mockReturnValueOnce(child);
    emitClose(child, 0, "  the answer  \n");

    const result = await chat([{ role: "user", content: "hi" }], {
      model: "claude-opus-4-7",
    });

    expect(result).toBe("the answer");
    expect(spawnMock).toHaveBeenCalledOnce();
    const [cliPath, args] = spawnMock.mock.calls[0];
    // Binary is hardcoded — no claude_cli_path setting to override.
    expect(cliPath).toBe("claude");
    expect(args).toEqual(["-p", "--model", "claude-opus-4-7"]);
    // Prompt goes over stdin, not argv — Windows CreateProcess caps argv
    // at ~32K and large embedded files (write_hook, write_chapter)
    // otherwise trip ENAMETOOLONG.
    expect(child.stdin.end).toHaveBeenCalledWith("hi", "utf8");
  });

  it("joins multiple messages with double newlines as the stdin prompt", async () => {
    const child = fakeChild();
    spawnMock.mockReturnValueOnce(child);
    emitClose(child, 0, "ok");

    await chat(
      [
        { role: "system", content: "be terse" },
        { role: "user", content: "hello" },
      ],
      { model: "claude-opus-4-7" }
    );

    expect(child.stdin.end).toHaveBeenCalledWith("be terse\n\nhello", "utf8");
  });

  it("does not put the prompt on argv — even a 100K prompt must spawn without ENAMETOOLONG-risk argv", async () => {
    const child = fakeChild();
    spawnMock.mockReturnValueOnce(child);
    emitClose(child, 0, "ok");

    const huge = "x".repeat(100_000);
    await chat([{ role: "user", content: huge }], {
      model: "claude-opus-4-7",
    });

    const [, args] = spawnMock.mock.calls[0];
    for (const a of args) {
      expect(a.length).toBeLessThan(1_000);
    }
    expect(child.stdin.end).toHaveBeenCalledWith(huge, "utf8");
  });

  it("uses opts.model on the --model flag", async () => {
    const child = fakeChild();
    spawnMock.mockReturnValueOnce(child);
    emitClose(child, 0, "ok");

    await chat([{ role: "user", content: "hi" }], {
      model: "claude-3-5-sonnet",
    });

    const [, args] = spawnMock.mock.calls[0];
    const modelIdx = args.indexOf("--model");
    expect(args[modelIdx + 1]).toBe("claude-3-5-sonnet");
  });

  it("throws when opts.model is missing — provider is a pure transport", async () => {
    // Per-purpose model resolution moved to the pipeline boundary; the
    // provider no longer reads `claude_cli_model` from settings.
    await expect(
      chat([{ role: "user", content: "hi" }], {})
    ).rejects.toThrow(/opts\.model is required/);

    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("throws when opts.model is the empty string", async () => {
    await expect(
      chat([{ role: "user", content: "hi" }], { model: "" })
    ).rejects.toThrow(/opts\.model is required/);

    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("argv is exactly [-p, --model, model] — no extra-args splice", async () => {
    // claude_cli_extra_args was removed when the path/extra-args knobs
    // were dropped. Argv must stay minimal so a stale setting (or future
    // edit) can't sneak extra flags into the spawn.
    const child = fakeChild();
    spawnMock.mockReturnValueOnce(child);
    emitClose(child, 0, "ok");

    await chat([{ role: "user", content: "hi" }], {
      model: "claude-opus-4-7",
    });

    const [, args] = spawnMock.mock.calls[0];
    expect(args).toHaveLength(3);
  });

  it("rejects with stderr-tagged error on non-zero exit", async () => {
    const child = fakeChild();
    spawnMock.mockReturnValueOnce(child);
    emitClose(child, 1, "", "boom: bad input");

    await expect(
      chat([{ role: "user", content: "hi" }], { model: "claude-opus-4-7" })
    ).rejects.toThrow(/exited with code 1.*boom: bad input/);
  });

  it("ends stdin after writing the prompt so the CLI sees EOF and exits", async () => {
    const child = fakeChild();
    spawnMock.mockReturnValueOnce(child);
    emitClose(child, 0, "ok");

    await chat([{ role: "user", content: "hi" }], {
      model: "claude-opus-4-7",
    });

    expect(child.stdin.end).toHaveBeenCalledOnce();
    expect(child.stdin.end).toHaveBeenCalledWith("hi", "utf8");
  });

  it("includes stdout in the error when stderr is empty (CLI writes some failures to stdout)", async () => {
    const child = fakeChild();
    spawnMock.mockReturnValueOnce(child);
    emitClose(child, 1, "There's an issue with the selected model", "");

    await expect(
      chat([{ role: "user", content: "hi" }], { model: "claude-opus-4-7" })
    ).rejects.toThrow(
      /exited with code 1.*There's an issue with the selected model/
    );
  });

  it("rejects when spawn emits an error event (e.g. ENOENT)", async () => {
    const child = fakeChild();
    spawnMock.mockReturnValueOnce(child);
    setImmediate(() => child.emit("error", new Error("ENOENT: no claude")));

    await expect(
      chat([{ role: "user", content: "hi" }], { model: "claude-opus-4-7" })
    ).rejects.toThrow(/ENOENT: no claude/);
  });

  it("rejects AbortError without spawning when signal is pre-aborted", async () => {
    const controller = new AbortController();
    controller.abort("delete_requested");

    await expect(
      chat([{ role: "user", content: "hi" }], {
        model: "claude-opus-4-7",
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("aborts in-flight spawn — kills child and rejects with AbortError shape, not 'exited with code'", async () => {
    const child = fakeChild();
    spawnMock.mockReturnValueOnce(child);

    const controller = new AbortController();
    const promise = chat([{ role: "user", content: "hi" }], {
      model: "claude-opus-4-7",
      signal: controller.signal,
    });

    await Promise.resolve();
    await Promise.resolve();
    controller.abort("delete_requested");

    setImmediate(() => child.emit("close", 143));

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(child.kill).toHaveBeenCalled();
  });

  it("removes abort listener after normal close — later abort does not call child.kill", async () => {
    const child = fakeChild();
    spawnMock.mockReturnValueOnce(child);
    emitClose(child, 0, "ok");

    const controller = new AbortController();
    const result = await chat([{ role: "user", content: "hi" }], {
      model: "claude-opus-4-7",
      signal: controller.signal,
    });
    expect(result).toBe("ok");
    expect(child.kill).not.toHaveBeenCalled();

    controller.abort();
    await Promise.resolve();
    expect(child.kill).not.toHaveBeenCalled();
  });
});
