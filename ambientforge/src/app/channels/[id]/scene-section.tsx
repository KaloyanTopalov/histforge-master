'use client';

import { useState } from 'react';

type Props = {
  albumId: string;
  sceneTitle: string | null;
  sceneImagePrompt: string | null;
  sceneSeedancePrompt: string | null;
};

/**
 * Channel detail page Scene section for ambient-video. The Copy button on the
 * Midjourney prompt is the most important UI here — operator clicks it,
 * pastes into Midjourney, saves the render as `projects/<channel_id>/source.jpg`.
 */
export default function SceneSection({
  albumId,
  sceneTitle,
  sceneImagePrompt,
  sceneSeedancePrompt,
}: Props) {
  const hasAnything = sceneTitle || sceneImagePrompt || sceneSeedancePrompt;
  if (!hasAnything) {
    return (
      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight">
          Scene (latest album: <span className="font-mono text-sm">{albumId}</span>)
        </h2>
        <div className="rounded-md border border-dashed border-zinc-300 p-4 text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
          Scene generator (step 01b) hasn&apos;t run yet for this album.
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold tracking-tight">
        Scene (latest album: <span className="font-mono text-sm">{albumId}</span>)
      </h2>

      {sceneTitle && (
        <div className="rounded-md border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950">
          <div className="text-xs uppercase tracking-wide text-zinc-500">YouTube title</div>
          <div className="mt-1 text-base font-medium">{sceneTitle}</div>
        </div>
      )}

      {sceneImagePrompt && (
        <div className="rounded-md border-2 border-amber-400 bg-amber-50 p-3 dark:border-amber-700 dark:bg-amber-950/40">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-xs font-semibold uppercase tracking-wide text-amber-800 dark:text-amber-200">
              Midjourney prompt
            </div>
            <CopyButton text={sceneImagePrompt} />
          </div>
          <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-amber-950 dark:text-amber-50">
            {sceneImagePrompt}
          </pre>
          <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
            Copy this into Midjourney, save the render as{' '}
            <code>projects/&lt;channel_id&gt;/source.jpg</code>. Step 05a uses that same image as
            the cover/thumbnail base AND as the Seedance first/last frame.
          </p>
        </div>
      )}

      {sceneSeedancePrompt && (
        <div className="rounded-md border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950">
          <div className="mb-1 text-xs uppercase tracking-wide text-zinc-500">
            Seedance motion prompt (sent automatically in step 08)
          </div>
          <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-zinc-700 dark:text-zinc-300">
            {sceneSeedancePrompt}
          </pre>
        </div>
      )}
    </section>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const onClick = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Older browsers / locked-down contexts — best effort.
      setCopied(false);
    }
  };
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-md bg-amber-600 px-3 py-1 text-xs font-semibold text-white hover:bg-amber-700 disabled:opacity-50 dark:bg-amber-500 dark:text-amber-950 dark:hover:bg-amber-400"
    >
      {copied ? 'Copied!' : 'Copy'}
    </button>
  );
}
