"use client";

import { AlertTriangle } from "lucide-react";

interface FlowServiceOverloadBannerProps {
  overloadUntilRaw: string;
}

function parseOverloadUntil(raw: string): number | null {
  if (!raw) return null;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) return null;
  if (n * 1000 <= Date.now()) return null;
  return n;
}

function formatIso(unixSec: number): string {
  return new Date(unixSec * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");
}

export function FlowServiceOverloadBanner({
  overloadUntilRaw,
}: FlowServiceOverloadBannerProps): JSX.Element | null {
  const until = parseOverloadUntil(overloadUntilRaw);
  if (until === null) return null;

  const remainingMin = Math.max(
    1,
    Math.round((until * 1000 - Date.now()) / 60_000)
  );

  return (
    <div
      role="alert"
      className="mb-4 flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-500/50 dark:bg-amber-950 dark:text-amber-100"
    >
      <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4" />
      <div>
        <strong>Veo is reporting high backend traffic.</strong> Affected
        accounts will resume automatically at{" "}
        <time dateTime={new Date(until * 1000).toISOString()}>
          {formatIso(until)}
        </time>{" "}
        (~{remainingMin} minutes).
      </div>
    </div>
  );
}
