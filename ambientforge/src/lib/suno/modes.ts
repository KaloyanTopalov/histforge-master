// Client-safe Suno mode constants. Lives in lib/suno/ so the channel form
// (Client Component) can import without pulling in the server-side db.ts.

export type SunoMode = 'custom' | 'description' | 'persona';
export const SUNO_MODES: readonly SunoMode[] = ['custom', 'description', 'persona'] as const;
