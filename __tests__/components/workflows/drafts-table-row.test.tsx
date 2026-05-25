import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  Table,
  TableBody,
} from "@/components/ui/table";
import { DraftTableRow } from "@/app/workflows/drafts-table-row";
import type { DraftRow } from "@/lib/workflows-api";

afterEach(() => {
  cleanup();
});

const baseRow: DraftRow = {
  filename: "fast-narrative.json",
  slug: "fast-narrative",
  label: "Fast narrative",
  providers: {
    script: "openrouter",
    tts: "ai33",
    image: "comfyui",
    video: "comfyui",
  },
  chunker_step: "chunk_clips_then_images",
  stepCount: 3,
  mtime: 1000,
  errors: [],
};

function renderRow(row: DraftRow): void {
  render(
    <Table>
      <TableBody>
        <DraftTableRow
          row={row}
          busy={false}
          anyBusy={false}
          onImport={() => {}}
          onDiscard={() => {}}
        />
      </TableBody>
    </Table>
  );
}

describe("DraftTableRow chunker_step surface", () => {
  it("shows the chunker_step value alongside the providers", () => {
    renderRow(baseRow);
    expect(screen.getByText(/chunk_clips_then_images/)).toBeTruthy();
  });

  it("falls back to an em-dash when chunker_step is null", () => {
    renderRow({ ...baseRow, chunker_step: null });
    // The providers cell already renders em-dashes for missing values; the
    // chunker value is rendered in the same cell.
    const cell = screen.getByText(/script: openrouter/);
    expect(cell.textContent).toMatch(/chunker: —/);
  });

  it("renders chunker_step on a draft where one of the providers is missing", () => {
    renderRow({
      ...baseRow,
      providers: { script: "openrouter", tts: null, image: null, video: "google_flow" },
      chunker_step: "chunk_clips_only",
    });
    expect(screen.getByText(/chunker: chunk_clips_only/)).toBeTruthy();
  });
});
