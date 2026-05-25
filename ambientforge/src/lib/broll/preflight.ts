/**
 * B-roll folder validation. Used by:
 *   1. Channel CRUD validation (POST/PATCH /api/channels with workflow=rap)
 *   2. Album-trigger preflight (workflow.preflightChecks before step 01)
 *   3. The "Validate folder" button in the dashboard channel form
 *
 * Probes every video file in the folder (ffprobe). Returns a structured
 * result with reasons explaining why the folder is or isn't usable.
 * Never throws — callers decide how to react to invalid results.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ffprobe } from '../audio/ffmpeg';
import { isVideoFile, type BrollClip } from './select';
import { getRawSetting } from '../settings';

/** Minimum clip count required for rap-compilation albums. Below this, the
 *  selectBroll cycle would repeat clips too aggressively to feel varied. */
export const MIN_BROLL_CLIPS = 10;

export type BrollPathCheck =
  | { ok: true; resolvedPath: string }
  | { ok: false; code: BrollPathRejectCode; reason: string };

export type BrollPathRejectCode =
  | 'PATH_NOT_ABSOLUTE'
  | 'PATH_TRAVERSAL'
  | 'PATH_NOT_FOUND'
  | 'PATH_NOT_ALLOWED';

/**
 * Validate a B-roll folder path against the operator-configured allowlist.
 * Used by the validate-broll API, channel CRUD, workflow preflight, and
 * step 09-rap. Symlinks are resolved BEFORE allowlist checking so a symlink
 * pointing outside the allowlist is rejected.
 */
export function assertBrollPathAllowed(
  absPath: string,
  allowedRoots: string[],
): BrollPathCheck {
  if (!path.isAbsolute(absPath)) {
    return { ok: false, code: 'PATH_NOT_ABSOLUTE', reason: 'path must be absolute' };
  }
  // Reject .. segments BEFORE normalize so traversal can't smuggle past the
  // realpath resolution (which would otherwise quietly resolve ../sibling).
  const segments = absPath.split(/[\\/]/);
  if (segments.includes('..')) {
    return { ok: false, code: 'PATH_TRAVERSAL', reason: '.. segment in path' };
  }
  let resolvedPath: string;
  try {
    resolvedPath = fs.realpathSync(absPath);
  } catch {
    return { ok: false, code: 'PATH_NOT_FOUND', reason: 'path does not exist' };
  }
  const norm = path.normalize(resolvedPath);
  for (const root of allowedRoots) {
    const normRoot = path.normalize(root);
    const withSep = normRoot.endsWith(path.sep) ? normRoot : normRoot + path.sep;
    if (norm === normRoot || norm.startsWith(withSep)) {
      return { ok: true, resolvedPath: norm };
    }
  }
  return { ok: false, code: 'PATH_NOT_ALLOWED', reason: 'not under any allowed root' };
}

/** Read the operator-configured allowlist from settings (JSON-encoded array). */
export function readAllowedBrollRoots(): string[] {
  const raw = getRawSetting('broll_allowed_root_paths') ?? '[]';
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((p) => typeof p === 'string')) {
      return parsed;
    }
  } catch {
    /* fall through */
  }
  return [];
}

export type BrollPreflightResult = {
  exists: boolean;
  videoCount: number;
  /** First 5 video filenames (relative to the folder) for display. */
  sampleFiles: string[];
  /** Distinct codecs detected via ffprobe across all probed clips. */
  codecsDetected: string[];
  /** Probed durations, suitable for selectBroll input. */
  clips: BrollClip[];
  /** Human-readable reasons (positive AND negative). */
  reasons: string[];
  /** True iff the folder is usable for a rap-compilation channel. */
  ok: boolean;
};

export type PreflightOpts = {
  /** When set, override MIN_BROLL_CLIPS (used by tests). */
  minClips?: number;
};

export async function preflightBrollFolder(
  absPath: string,
  opts: PreflightOpts = {},
): Promise<BrollPreflightResult> {
  const minClips = opts.minClips ?? MIN_BROLL_CLIPS;
  const reasons: string[] = [];

  if (!fs.existsSync(absPath)) {
    return {
      exists: false,
      videoCount: 0,
      sampleFiles: [],
      codecsDetected: [],
      clips: [],
      reasons: [`folder does not exist: ${absPath}`],
      ok: false,
    };
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absPath);
  } catch (err) {
    return {
      exists: false,
      videoCount: 0,
      sampleFiles: [],
      codecsDetected: [],
      clips: [],
      reasons: [`stat failed: ${String(err)}`],
      ok: false,
    };
  }
  if (!stat.isDirectory()) {
    return {
      exists: true,
      videoCount: 0,
      sampleFiles: [],
      codecsDetected: [],
      clips: [],
      reasons: [`path exists but is not a directory: ${absPath}`],
      ok: false,
    };
  }

  let entries: string[];
  try {
    entries = fs.readdirSync(absPath);
  } catch (err) {
    return {
      exists: true,
      videoCount: 0,
      sampleFiles: [],
      codecsDetected: [],
      clips: [],
      reasons: [`readdir failed: ${String(err)}`],
      ok: false,
    };
  }
  const videoFiles = entries
    .filter((f) => isVideoFile(f))
    .sort((a, b) => a.localeCompare(b));
  const sampleFiles = videoFiles.slice(0, 5);

  const clips: BrollClip[] = [];
  const codecs = new Set<string>();
  for (const f of videoFiles) {
    const fullPath = path.join(absPath, f);
    try {
      const probe = await ffprobe(fullPath);
      if (probe.codec) codecs.add(probe.codec);
      if (probe.duration && probe.duration > 0) {
        clips.push({ path: fullPath, durationSec: probe.duration });
      } else {
        reasons.push(`clip ${f} has no readable duration`);
      }
    } catch (err) {
      reasons.push(`ffprobe failed for ${f}: ${String(err)}`);
    }
  }
  const codecsDetected = Array.from(codecs).sort();

  if (clips.length < minClips) {
    reasons.push(
      `only ${clips.length} probable clips found (need ≥ ${minClips})`,
    );
  } else {
    reasons.push(`${clips.length} clips probed successfully`);
  }
  if (codecsDetected.length > 1) {
    reasons.push(
      `mixed codecs across folder: ${codecsDetected.join(', ')} — final mux will re-encode`,
    );
  } else if (codecsDetected.length === 1) {
    reasons.push(`uniform codec: ${codecsDetected[0]}`);
  }

  const ok = clips.length >= minClips;
  return {
    exists: true,
    videoCount: videoFiles.length,
    sampleFiles,
    codecsDetected,
    clips,
    reasons,
    ok,
  };
}
