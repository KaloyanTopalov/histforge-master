import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, resolve, sep } from "node:path";
import { resolveMagnificToken } from "@/lib/magnific-auth";
import * as videosRepo from "@/lib/repos/videos";

interface RouteCtx {
  params: { token: string };
}

/**
 * Extension-facing artifact passthrough — token-validated streaming
 * download of a file under `projects/<videoId>/`. The image-to-video
 * executor calls this with `reference_image_url` (built by the next-task
 * route) to fetch the loop image as the first/last-frame upload.
 *
 * Narrow by design in v1: only the loop-image use case is exercised.
 * Broader path access (full project-dir browsing) is deferred — the
 * existing /api/videos/:id/files/:path serves that for the dashboard,
 * but it has no token auth and is intended for browser use on the same
 * origin.
 *
 * Security model:
 *   • The URL [token] segment must match `magnific_token` (404 mismatch).
 *   • The `videoId` must be a known video — protects against stale or
 *     orphaned project dirs being accessed after the DB row was deleted.
 *   • The `path` query param is rejected if absolute or contains `..`
 *     segments. As defense-in-depth, the resolved path must remain
 *     strictly under `projects/<videoId>/`.
 */
const CONTENT_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

export async function GET(
  req: Request,
  ctx: RouteCtx
): Promise<Response> {
  const auth = resolveMagnificToken(ctx.params.token);
  if (!auth.ok) return auth.response;
  const { db } = auth;

  const url = new URL(req.url);
  const videoId = url.searchParams.get("videoId");
  const requestedPath = url.searchParams.get("path");
  if (!videoId || !requestedPath) {
    return new Response("bad request", { status: 400 });
  }

  // Reject explicit escape attempts before touching the FS. The
  // resolve-startsWith check below is the authoritative guard, but
  // catching obviously-hostile inputs early gives a cleaner error.
  if (
    isAbsolute(requestedPath) ||
    requestedPath.split(/[\\/]/).some((seg) => seg === "..")
  ) {
    return new Response("bad request", { status: 400 });
  }

  if (!videosRepo.existsById(db, videoId)) {
    return new Response("not found", { status: 404 });
  }

  const projectsDir = process.env.PROJECTS_DIR ?? "./projects";
  const projectRoot = resolve(projectsDir, videoId);
  const requested = resolve(projectRoot, requestedPath);
  if (
    requested !== projectRoot &&
    !requested.startsWith(projectRoot + sep)
  ) {
    return new Response("bad request", { status: 400 });
  }

  if (!existsSync(requested)) {
    return new Response("not found", { status: 404 });
  }
  const st = statSync(requested);
  if (!st.isFile()) {
    return new Response("not found", { status: 404 });
  }

  const bytes = readFileSync(requested);
  const ext = extname(requested).toLowerCase();
  const contentType = CONTENT_TYPES[ext] ?? "application/octet-stream";

  return new Response(bytes, {
    status: 200,
    headers: {
      "content-type": contentType,
      "content-length": String(bytes.byteLength),
    },
  });
}
