import { NextResponse } from 'next/server';
import { errorJson } from '@/lib/api/errors';
import {
  assertBrollPathAllowed,
  preflightBrollFolder,
  readAllowedBrollRoots,
} from '@/lib/broll/preflight';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ALLOWED_ORIGIN = 'http://localhost:3003';

/**
 * GET /api/channels/validate-broll?path=<urlencoded-absolute-path>
 *
 * Runs the same B-roll preflight that the workflow uses at album-trigger
 * time. C5: gated by browser fetch metadata (CSRF defense — only the
 * dashboard's own fetches at localhost:3003 may call this) AND by the
 * operator-configured allowlist `broll_allowed_root_paths` (filesystem
 * disclosure defense — without this, any localhost caller could enumerate
 * arbitrary directories via ffprobe).
 */
export async function GET(req: Request) {
  // CSRF defense. Accept Sec-Fetch-Site=same-origin (modern browsers always
  // send this on same-origin fetches; cross-site attackers can't forge it).
  // Fall back to Origin matching for older browsers / direct curl tests.
  // Tests run with neither header set and use NODE_ENV=test as the opt-out.
  if (process.env.NODE_ENV !== 'test') {
    const sfs = req.headers.get('sec-fetch-site');
    const origin = req.headers.get('origin');
    const sameOrigin =
      sfs === 'same-origin' || (sfs === null && origin === ALLOWED_ORIGIN);
    if (!sameOrigin) {
      return errorJson(
        'ORIGIN_NOT_ALLOWED',
        'validate-broll requires same-origin fetch from the dashboard',
        403,
      );
    }
  }

  const url = new URL(req.url);
  const p = url.searchParams.get('path');
  if (!p || p.trim().length === 0) {
    return errorJson('PATH_REQUIRED', 'Pass ?path=<absolute folder path>', 400);
  }

  const allowedRoots = readAllowedBrollRoots();
  const check = assertBrollPathAllowed(p, allowedRoots);
  if (!check.ok) {
    const status = check.code === 'PATH_NOT_FOUND' ? 404 : 403;
    return errorJson(check.code, check.reason, status, {
      allowedRoots,
    });
  }

  try {
    const result = await preflightBrollFolder(check.resolvedPath);
    return NextResponse.json(result);
  } catch (err) {
    return errorJson(
      'PREFLIGHT_FAILED',
      err instanceof Error ? err.message : String(err),
      500,
    );
  }
}
