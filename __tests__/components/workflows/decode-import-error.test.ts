import { describe, it, expect, vi } from "vitest";
import {
  decodeImportError,
  type ImportErrorBody,
} from "@/app/workflows/use-import-with-overwrite";

describe("decodeImportError", () => {
  it("invalid_input with issues surfaces the first issue message", () => {
    const body: ImportErrorBody = {
      error: "invalid_input",
      issues: [{ message: "id required", path: ["id"] }],
    };
    const decoded = decodeImportError(body, 400, {});
    expect(decoded.kind).toBe("toast");
    expect(decoded.level).toBe("error");
    expect(decoded.message).toBe("Invalid workflow JSON: id required");
    expect(decoded.sideEffect).toBeUndefined();
  });

  it("invalid_input with no issues falls back to schema mismatch wording", () => {
    const decoded = decodeImportError({ error: "invalid_input" }, 400, {});
    expect(decoded.message).toBe("Invalid workflow JSON: schema mismatch");
  });

  it("invalid_input with empty issues array falls back to schema mismatch", () => {
    const decoded = decodeImportError(
      { error: "invalid_input", issues: [] },
      400,
      {},
    );
    expect(decoded.message).toBe("Invalid workflow JSON: schema mismatch");
  });

  it("invalid_json surfaces the not-valid-JSON wording", () => {
    const decoded = decodeImportError({ error: "invalid_json" }, 400, {});
    expect(decoded.message).toBe("Draft file is not valid JSON");
    expect(decoded.sideEffect).toBeUndefined();
  });

  it("invalid_filename surfaces the invalid-filename wording", () => {
    const decoded = decodeImportError({ error: "invalid_filename" }, 400, {});
    expect(decoded.message).toBe("Invalid draft filename");
  });

  it("draft_not_found wires reloadDrafts as the sideEffect when ctx supplies it", () => {
    const reloadDrafts = vi.fn(async () => {});
    const decoded = decodeImportError(
      { error: "draft_not_found" },
      404,
      { reloadDrafts },
    );
    expect(decoded.message).toBe("Draft file no longer exists");
    expect(decoded.sideEffect).toBe(reloadDrafts);
  });

  it("draft_not_found leaves sideEffect undefined when ctx omits reloadDrafts", () => {
    const decoded = decodeImportError({ error: "draft_not_found" }, 404, {});
    expect(decoded.message).toBe("Draft file no longer exists");
    expect(decoded.sideEffect).toBeUndefined();
  });

  it("workflow_id_exists surfaces the post-cancel collision wording", () => {
    const decoded = decodeImportError(
      { error: "workflow_id_exists" },
      409,
      {},
    );
    expect(decoded.message).toBe(
      "Workflow id collision — refresh and try again",
    );
  });

  it("falls back to a generic message for unrecognized error codes", () => {
    const decoded = decodeImportError({ error: "something_else" }, 500, {});
    expect(decoded.message).toBe("Import failed (500)");
  });

  it("falls back to a generic message when body is null", () => {
    const decoded = decodeImportError(null, 502, {});
    expect(decoded.message).toBe("Import failed (502)");
  });

  it("falls back to a generic message when body has no error field", () => {
    const decoded = decodeImportError({}, 503, {});
    expect(decoded.message).toBe("Import failed (503)");
  });
});
