"use client";

import { useEffect, useState } from "react";

/**
 * Tick-once-a-second clock. While `active` is true, returns a `now`
 * value that advances every 1000ms; while false, returns the last value
 * (frozen) so consumers can render a stable elapsed-time string until
 * the activity flag flips back on.
 *
 * `initialNow` is the value used for the first render. Pass the
 * server-rendered timestamp from a Server Component prop so SSR and
 * client hydration produce identical timer text — lazy-initializing
 * from `Date.now()` here would read different clocks on server and
 * client and trip Next's hydration mismatch ("7m 42s" vs "7m 43s").
 * After mount, `useEffect` snaps to the real client clock and ticks
 * from there.
 *
 * Used by both the video detail page (active = "any step is running")
 * and the videos list (active = "any in-progress video has a running
 * step") to drive live timers without each row owning its own interval.
 */
export function useNowTick(active: boolean, initialNow: number): number {
  const [now, setNow] = useState<number>(initialNow);

  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);

  return now;
}
