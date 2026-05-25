/**
 * Pure-data constants for channels — no DB imports, safe to import from
 * client components. The server-side `src/lib/repos/channels.ts` re-exports
 * these so existing imports keep working.
 */

export const WORKFLOWS = ['ambient', 'rap-compilation', 'ambient-video'] as const;
export type Workflow = (typeof WORKFLOWS)[number];

export const YOUTUBE_IMAGE_ASPECTS = ['letterbox', 'crop'] as const;
export type YoutubeImageAspect = (typeof YOUTUBE_IMAGE_ASPECTS)[number];

export const RAP_CLIP_STRATEGIES = ['random-fill', 'sequential', 'seeded-by-album'] as const;
export type RapClipStrategy = (typeof RAP_CLIP_STRATEGIES)[number];
