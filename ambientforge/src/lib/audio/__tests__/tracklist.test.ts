import { describe, it, expect } from 'vitest';
import {
  buildTracklist,
  formatTimestamp,
  parseTracklistText,
} from '@/lib/audio/tracklist';

describe('formatTimestamp', () => {
  it('formats sub-hour values as M:SS without zero-padded minutes', () => {
    expect(formatTimestamp(0, false)).toBe('0:00');
    expect(formatTimestamp(7, false)).toBe('0:07');
    expect(formatTimestamp(65, false)).toBe('1:05');
    expect(formatTimestamp(3599, false)).toBe('59:59');
  });

  it('formats hour-mode values as H:MM:SS with zero-padded minutes + seconds', () => {
    expect(formatTimestamp(3600, true)).toBe('1:00:00');
    expect(formatTimestamp(3661, true)).toBe('1:01:01');
    expect(formatTimestamp(7325, true)).toBe('2:02:05');
    expect(formatTimestamp(36000, true)).toBe('10:00:00');
  });

  it('floors fractional seconds to integer', () => {
    expect(formatTimestamp(7.9, false)).toBe('0:07');
    expect(formatTimestamp(3601.4, true)).toBe('1:00:01');
  });
});

describe('buildTracklist', () => {
  it('produces M:SS-only entries when total duration stays under 1 hour', () => {
    const tracks = [
      { trackNumber: 1, title: 'A', durationSec: 60 },
      { trackNumber: 2, title: 'B', durationSec: 120 },
      { trackNumber: 3, title: 'C', durationSec: 90 },
    ];
    const out = buildTracklist(tracks);
    expect(out.entries.map((e) => e.timestamp)).toEqual(['0:00', '1:00', '3:00']);
    expect(out.text).toBe('0:00 - A\n1:00 - B\n3:00 - C');
  });

  it('switches to H:MM:SS for the entry whose cumulative timestamp first reaches 1:00:00 and ALL later entries', () => {
    // 30 tracks of 5 minutes each → cumulative timestamps 0:00, 5:00, ..., 55:00, 1:00:00, 1:05:00, ..., 2:25:00.
    // Entry 13 starts at 60:00 = exactly 3600s → first entry that uses hours format.
    const tracks = Array.from({ length: 30 }, (_, i) => ({
      trackNumber: i + 1,
      title: `Track ${i + 1}`,
      durationSec: 300,
    }));
    const out = buildTracklist(tracks);
    // Entry 1 → 0:00 (no hours)
    expect(out.entries[0].timestamp).toBe('0:00');
    // Entry 12 (idx 11) starts at 55:00 → still M:SS.
    expect(out.entries[11].timestamp).toBe('55:00');
    // Entry 13 (idx 12) starts at 1:00:00 → switch to H:MM:SS.
    expect(out.entries[12].timestamp).toBe('1:00:00');
    // Entry 14 (idx 13) starts at 1:05:00 → continues in H:MM:SS.
    expect(out.entries[13].timestamp).toBe('1:05:00');
    // Last entry (idx 29) starts at 2:25:00.
    expect(out.entries[29].timestamp).toBe('2:25:00');
    // text begins with M:SS, contains the switchover.
    expect(out.text.startsWith('0:00 - Track 1')).toBe(true);
    expect(out.text).toContain('\n55:00 - Track 12\n1:00:00 - Track 13\n');
  });

  it('orders by trackNumber even when input is shuffled', () => {
    const tracks = [
      { trackNumber: 3, title: 'C', durationSec: 30 },
      { trackNumber: 1, title: 'A', durationSec: 30 },
      { trackNumber: 2, title: 'B', durationSec: 30 },
    ];
    const out = buildTracklist(tracks);
    expect(out.entries.map((e) => e.title)).toEqual(['A', 'B', 'C']);
    expect(out.entries.map((e) => e.timestamp)).toEqual(['0:00', '0:30', '1:00']);
  });

  it('handles empty input gracefully', () => {
    expect(buildTracklist([]).text).toBe('');
    expect(buildTracklist([]).entries).toEqual([]);
  });
});

describe('parseTracklistText', () => {
  it('round-trips the buildTracklist output', () => {
    const tracks = Array.from({ length: 30 }, (_, i) => ({
      trackNumber: i + 1,
      title: `Track ${i + 1}`,
      durationSec: 300,
    }));
    const built = buildTracklist(tracks);
    const parsed = parseTracklistText(built.text);
    expect(parsed).toHaveLength(30);
    expect(parsed[0]).toEqual({ trackNumber: 1, title: 'Track 1', timestamp: '0:00' });
    expect(parsed[12]).toEqual({ trackNumber: 13, title: 'Track 13', timestamp: '1:00:00' });
  });
});
