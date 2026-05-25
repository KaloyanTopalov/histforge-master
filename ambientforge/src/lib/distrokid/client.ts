import fs from 'node:fs';
import path from 'node:path';

export class DistrokidError extends Error {
  readonly code: string;
  readonly retriable: boolean;
  readonly status?: number;
  readonly cause?: unknown;
  constructor(code: string, message: string, retriable: boolean, status?: number, cause?: unknown) {
    super(message);
    this.name = 'DistrokidError';
    this.code = code;
    this.retriable = retriable;
    this.status = status;
    this.cause = cause;
  }
}

export type DistrokidMetadata = {
  albumTitle: string;
  artistName: string;
  genre: string;
  language: string;
  explicit: boolean;
  releaseDate: string;
  label: string;
  /**
   * Track count for the release. The DistroKid New Release form is a SPA whose
   * album-level fields (album title, etc.) only render once "Number of songs"
   * is set to ≥2. The runner drives the songs dropdown to this value before
   * filling the rest of the form.
   */
  numSongs: number;
  /**
   * Operator's real legal name. DistroKid requires first + last name as
   * songwriter credit per track for publishing rights. Replicated across all
   * tracks; sourced from settings at step 06 time.
   */
  songwriterFirstName?: string;
  songwriterMiddleName?: string;
  songwriterLastName?: string;
  /**
   * Per-track performer + producer credits. Replicated across all tracks.
   * Operator must have clicked "Add credits for each song on this release"
   * before these fill (the runner attempts a best-effort auto-click).
   */
  creditPerformerName?: string;
  creditPerformerRole?: string;
  creditProducerName?: string;
  creditProducerRole?: string;
};

export type DistrokidVerifyArtistResult = { found: boolean; candidates?: string[] };
export type DistrokidStartReleaseResult = { releaseToken: string };
export type DistrokidUploadResult = { ok: true; requiresManualUpload?: boolean };
export type DistrokidUploadTrackResult = {
  ok: true;
  trackNumber: number;
  requiresManualUpload?: boolean;
};
export type DistrokidVerifyCountResult = { count: number; matches: boolean };
export type DistrokidSubmitResult = {
  status: 'screenshot_saved' | 'captcha_required' | 'submitted';
  screenshotPath?: string;
  releaseId?: string;
};

export interface DistrokidClient {
  verifyArtist(artistName: string): Promise<DistrokidVerifyArtistResult>;
  startRelease(): Promise<DistrokidStartReleaseResult>;
  setMetadata(releaseToken: string, payload: DistrokidMetadata): Promise<{ ok: true }>;
  uploadCover(releaseToken: string, filePath: string): Promise<DistrokidUploadResult>;
  uploadTrack(
    releaseToken: string,
    filePath: string,
    trackNumber: number,
    title: string,
  ): Promise<DistrokidUploadTrackResult>;
  verifyTrackCount(releaseToken: string, expected: number): Promise<DistrokidVerifyCountResult>;
  submitOrScreenshot(
    releaseToken: string,
    screenshotPath: string,
    dryRun: boolean,
    hint?: { channelName?: string },
  ): Promise<DistrokidSubmitResult>;
  focusWindow(): Promise<{ ok: boolean; error?: string }>;
}

const DEFAULT_BRIDGE_URL = 'http://localhost:7342';
const BRIDGE_TIMEOUT_MS = 30_000;

export type DistrokidClientOpts = {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
};

export function makeDistrokidClient(opts: DistrokidClientOpts = {}): DistrokidClient {
  if (process.env.DISTROKID_MODE === 'mock') {
    return makeMockDistrokidClient();
  }
  return makeBridgeDistrokidClient(opts);
}

// ---------------------------------------------------------------------------
// Mock client
// ---------------------------------------------------------------------------

type MockRelease = {
  releaseToken: string;
  payload?: DistrokidMetadata;
  coverUploaded: boolean;
  tracks: Array<{ trackNumber: number; title: string; filePath: string }>;
};

type MockState = {
  counter: number;
  releases: Map<string, MockRelease>;
};

const mockState: MockState = {
  counter: 0,
  releases: new Map(),
};

/** Test-only: reset mock state between runs. */
export function __resetMockDistrokidState(): void {
  mockState.counter = 0;
  mockState.releases.clear();
}

function fixturePath(): string {
  return path.join(process.cwd(), 'tests', 'fixtures', 'distrokid', 'dryrun-fixture.png');
}

export function makeMockDistrokidClient(): DistrokidClient {
  return {
    async verifyArtist(artistName) {
      if (artistName.includes('Nonexistent') || artistName.includes('Definitely Not A Real Artist')) {
        throw new DistrokidError(
          'DISTROKID_ARTIST_NOT_FOUND',
          `mock: artist "${artistName}" not in DistroKid dropdown`,
          false,
        );
      }
      return { found: true };
    },
    async startRelease() {
      mockState.counter += 1;
      const releaseToken = `mock-release-${String(mockState.counter).padStart(4, '0')}`;
      mockState.releases.set(releaseToken, {
        releaseToken,
        coverUploaded: false,
        tracks: [],
      });
      return { releaseToken };
    },
    async setMetadata(releaseToken, payload) {
      const r = mockState.releases.get(releaseToken);
      if (!r) {
        throw new DistrokidError('DISTROKID_UNKNOWN_RELEASE', `mock: unknown ${releaseToken}`, false);
      }
      r.payload = payload;
      return { ok: true };
    },
    async uploadCover(releaseToken, filePath) {
      const r = mockState.releases.get(releaseToken);
      if (!r) {
        throw new DistrokidError('DISTROKID_UNKNOWN_RELEASE', `mock: unknown ${releaseToken}`, false);
      }
      if (!fs.existsSync(filePath)) {
        throw new DistrokidError(
          'DISTROKID_COVER_MISSING',
          `mock: cover file not found at ${filePath}`,
          false,
        );
      }
      r.coverUploaded = true;
      return { ok: true };
    },
    async uploadTrack(releaseToken, filePath, trackNumber, title) {
      const r = mockState.releases.get(releaseToken);
      if (!r) {
        throw new DistrokidError('DISTROKID_UNKNOWN_RELEASE', `mock: unknown ${releaseToken}`, false);
      }
      if (!fs.existsSync(filePath)) {
        throw new DistrokidError(
          'DISTROKID_TRACK_FILE_MISSING',
          `mock: track file not found at ${filePath}`,
          false,
        );
      }
      r.tracks.push({ trackNumber, title, filePath });
      return { ok: true, trackNumber };
    },
    async verifyTrackCount(releaseToken, expected) {
      const r = mockState.releases.get(releaseToken);
      if (!r) {
        throw new DistrokidError('DISTROKID_UNKNOWN_RELEASE', `mock: unknown ${releaseToken}`, false);
      }
      const count = r.tracks.length;
      return { count, matches: count === expected };
    },
    async submitOrScreenshot(releaseToken, screenshotPath, _dryRun, hint) {
      const r = mockState.releases.get(releaseToken);
      if (!r) {
        throw new DistrokidError('DISTROKID_UNKNOWN_RELEASE', `mock: unknown ${releaseToken}`, false);
      }
      if (hint?.channelName?.includes('captcha-test')) {
        return { status: 'captcha_required' };
      }
      const fixture = fixturePath();
      if (!fs.existsSync(fixture)) {
        throw new DistrokidError(
          'DISTROKID_FIXTURE_MISSING',
          `mock: dryrun fixture missing at ${fixture} — run npm run fixtures:setup`,
          false,
        );
      }
      await fs.promises.mkdir(path.dirname(screenshotPath), { recursive: true });
      await fs.promises.copyFile(fixture, screenshotPath);
      return { status: 'screenshot_saved', screenshotPath };
    },
    async focusWindow() {
      return { ok: true };
    },
  };
}

// ---------------------------------------------------------------------------
// Bridge HTTP client (real)
// ---------------------------------------------------------------------------

export function makeBridgeDistrokidClient(opts: DistrokidClientOpts = {}): DistrokidClient {
  const baseUrl = opts.baseUrl ?? DEFAULT_BRIDGE_URL;
  const fetchImpl = opts.fetchImpl ?? fetch;

  async function call<T>(method: string, urlPath: string, body?: unknown): Promise<T> {
    const url = `${baseUrl}${urlPath}`;
    const ac = new AbortController();
    const timeout = setTimeout(() => ac.abort(), BRIDGE_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method,
        headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ac.signal,
      });
    } catch (err) {
      const cause = err as { code?: string; name?: string; message?: string };
      if (cause?.name === 'AbortError') {
        throw new DistrokidError(
          'DISTROKID_BRIDGE_TIMEOUT',
          `${method} ${urlPath} timed out`,
          true,
          undefined,
          err,
        );
      }
      const code = cause?.code ?? '';
      const msg = cause?.message ?? '';
      if (code === 'ECONNREFUSED' || msg.includes('ECONNREFUSED')) {
        throw new DistrokidError(
          'DISTROKID_BRIDGE_UNREACHABLE',
          `bridge unreachable at ${baseUrl}`,
          true,
          undefined,
          err,
        );
      }
      throw new DistrokidError(
        'DISTROKID_BRIDGE_UNREACHABLE',
        `bridge call failed: ${msg}`,
        true,
        undefined,
        err,
      );
    } finally {
      clearTimeout(timeout);
    }

    if (res.status === 401) {
      throw new DistrokidError('DISTROKID_AUTH', 'bridge rejected request', false, 401);
    }
    if (res.status === 429) {
      throw new DistrokidError(
        'DISTROKID_RATE_LIMITED',
        `bridge responded ${res.status}`,
        true,
        429,
      );
    }
    if (res.status >= 500) {
      throw new DistrokidError(
        'DISTROKID_BRIDGE_ERROR',
        `bridge responded ${res.status}`,
        true,
        res.status,
      );
    }
    if (!res.ok) {
      let detail = '';
      try {
        detail = (await res.text()).slice(0, 200);
      } catch {
        /* ignore */
      }
      throw new DistrokidError(
        'DISTROKID_BRIDGE_ERROR',
        `bridge ${method} ${urlPath} -> ${res.status}: ${detail}`,
        false,
        res.status,
      );
    }

    if (res.status === 204) return undefined as T;
    try {
      return (await res.json()) as T;
    } catch (err) {
      throw new DistrokidError(
        'DISTROKID_BRIDGE_ERROR',
        'bridge returned invalid JSON',
        true,
        res.status,
        err,
      );
    }
  }

  return {
    async verifyArtist(artistName) {
      return call<DistrokidVerifyArtistResult>('POST', '/verify_artist', { artistName });
    },
    async startRelease() {
      return call<DistrokidStartReleaseResult>('POST', '/start_release', {});
    },
    async setMetadata(releaseToken, payload) {
      return call<{ ok: true }>('POST', '/set_metadata', { releaseToken, payload });
    },
    async uploadCover(releaseToken, filePath) {
      return call<DistrokidUploadResult>('POST', '/upload_cover', { releaseToken, filePath });
    },
    async uploadTrack(releaseToken, filePath, trackNumber, title) {
      return call<DistrokidUploadTrackResult>('POST', '/upload_track', {
        releaseToken,
        filePath,
        trackNumber,
        title,
      });
    },
    async verifyTrackCount(releaseToken, expected) {
      return call<DistrokidVerifyCountResult>('POST', '/verify_track_count', {
        releaseToken,
        expected,
      });
    },
    async submitOrScreenshot(releaseToken, screenshotPath, dryRun, hint) {
      return call<DistrokidSubmitResult>('POST', '/submit_or_screenshot', {
        releaseToken,
        screenshotPath,
        dryRun,
        hint,
      });
    },
    async focusWindow() {
      return call<{ ok: boolean; error?: string }>('POST', '/focus_window', {});
    },
  };
}
