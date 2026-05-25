import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { VideosTabs } from "@/app/videos/videos-tabs";

beforeEach(() => {
  /* no globals */
});

afterEach(() => {
  cleanup();
});

describe("VideosTabs", () => {
  it("renders two pill buttons: Narrative and Music videos", () => {
    render(<VideosTabs active="narrative" onChange={() => {}} />);
    expect(screen.getByRole("tab", { name: /narrative/i })).not.toBeNull();
    expect(screen.getByRole("tab", { name: /music videos/i })).not.toBeNull();
  });

  it("marks the active tab with aria-selected=true and the other with false", () => {
    render(<VideosTabs active="narrative" onChange={() => {}} />);
    const narrative = screen.getByRole("tab", { name: /narrative/i });
    const music = screen.getByRole("tab", { name: /music videos/i });
    expect(narrative.getAttribute("aria-selected")).toBe("true");
    expect(music.getAttribute("aria-selected")).toBe("false");
  });

  it("flips active when the prop changes", () => {
    const { rerender } = render(
      <VideosTabs active="narrative" onChange={() => {}} />,
    );
    expect(
      screen.getByRole("tab", { name: /narrative/i }).getAttribute("aria-selected"),
    ).toBe("true");

    rerender(<VideosTabs active="music_videos" onChange={() => {}} />);
    expect(
      screen.getByRole("tab", { name: /music videos/i }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      screen.getByRole("tab", { name: /narrative/i }).getAttribute("aria-selected"),
    ).toBe("false");
  });

  it("fires onChange with the clicked tab's value", () => {
    const onChange = vi.fn();
    render(<VideosTabs active="narrative" onChange={onChange} />);
    fireEvent.click(screen.getByRole("tab", { name: /music videos/i }));
    expect(onChange).toHaveBeenCalledWith("music_videos");
  });

  it("does not fire onChange when clicking the already-active tab", () => {
    const onChange = vi.fn();
    render(<VideosTabs active="narrative" onChange={onChange} />);
    fireEvent.click(screen.getByRole("tab", { name: /narrative/i }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
