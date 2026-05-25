"use client";

import { useMemo } from "react";
import { ChevronDown } from "lucide-react";
import type { VideoStep } from "@/types";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  groupArtifactsByStep,
  humanizeStepName,
  LOGS_GROUP_KEY,
  OTHER_GROUP_KEY,
} from "@/lib/artifact-grouping";
import { SectionHeading } from "../_shared";

interface ArtifactsPanelProps {
  videoId: string;
  artifacts: string[];
  steps: VideoStep[];
}

export function ArtifactsPanel({
  videoId,
  artifacts,
  steps,
}: ArtifactsPanelProps): JSX.Element {
  const artifactGroups = useMemo(
    () => groupArtifactsByStep(artifacts, steps),
    [artifacts, steps]
  );

  return (
    <Card>
      <CardHeader>
        <SectionHeading title="Artifacts" accent="slate" count={artifacts.length} />
      </CardHeader>
      <CardContent>
        {artifacts.length === 0 ? (
          <p className="text-sm text-muted-foreground">No files yet.</p>
        ) : (
          <div className="space-y-4">
            {artifactGroups.map((group) => {
              const isLogs = group.stepName === LOGS_GROUP_KEY;
              const isOther = group.stepName === OTHER_GROUP_KEY;
              const isSyntheticGroup = isLogs || isOther;
              const num =
                group.stepIndex !== null
                  ? String(group.stepIndex).padStart(2, "0")
                  : "—";
              const title = isLogs
                ? "Logs"
                : isOther
                  ? "Other"
                  : humanizeStepName(group.stepName);
              return (
                <section
                  key={group.stepName}
                  className="overflow-hidden rounded-lg border bg-muted/30"
                >
                  <details className="group">
                    <summary className="flex cursor-pointer list-none items-baseline gap-2 px-4 py-3 transition-colors hover:bg-muted/50 [&::-webkit-details-marker]:hidden">
                      <h4 className="flex items-baseline gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                        <span className="font-mono tabular-nums">{num}</span>
                        <span aria-hidden="true" className="text-muted-foreground/40">
                          ·
                        </span>
                        <span>{title}</span>
                        {!isSyntheticGroup && (
                          <span className="font-mono text-[10px] font-normal normal-case tracking-normal text-muted-foreground/60">
                            {group.stepName}
                          </span>
                        )}
                      </h4>
                      <span className="ml-auto rounded-full bg-muted px-2 py-0.5 font-mono text-[10px] font-medium normal-case tracking-normal tabular-nums text-muted-foreground">
                        {group.artifacts.length}
                      </span>
                      <ChevronDown
                        aria-hidden="true"
                        className="h-4 w-4 shrink-0 self-center text-muted-foreground transition-transform duration-200 group-open:rotate-180"
                      />
                    </summary>
                    <ul className="space-y-0.5 border-t border-border/60 px-4 py-3 text-sm">
                      {group.artifacts.map((a) => (
                        <li key={a}>
                          <a
                            className="underline"
                            href={`/api/videos/${videoId}/files/${a}`}
                          >
                            {a}
                          </a>
                        </li>
                      ))}
                    </ul>
                  </details>
                </section>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
