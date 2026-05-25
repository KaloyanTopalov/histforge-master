import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { getDb } from "@/lib/db";
import * as videosRepo from "@/lib/repos/videos";

interface RouteCtx {
  params: { id: string; path: string[] };
}

/**
 * Map known extensions to a sensible content-type. The pipeline only
 * produces a small, fixed set of file types — default to octet-stream
 * for anything else rather than guessing.
 */
const CONTENT_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".log": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".mp3": "audio/mpeg",
};

/**
 * GET /api/videos/:id/files/:...path — serve a file from the video's
 * project directory.
 *
 * Authorization: the `id` must be a known video in the DB — we don't
 * serve from arbitrary paths under `projects/`. This also protects
 * against stale/orphaned project directories being accessed after
 * their DB row was deleted.
 *
 * Security: the resolved path must remain strictly under
 * `projects/<id>/`. Any `..` traversal that would escape the project
 * root is rejected with 400.
 *
 * Used by the videos list (final.mp4 link) and the video detail page
 * (final.mp4 link + pipeline.log link). See plan Task 2.2 / 2.3.
 */
export async function GET(
  _req: Request,
  ctx: RouteCtx
): Promise<Response> {
  // Reject empty path ([...path] in Next captures zero segments as [])
  // — there is no "directory listing" semantics here.
  if (!ctx.params.path || ctx.params.path.length === 0) {
    return new Response("bad request", { status: 400 });
  }

  // Reject explicit parent-directory tokens before touching the
  // filesystem. `resolve()` would handle this correctly but rejecting
  // up front gives a cleaner error and avoids a path.resolve call on
  // hostile input.
  if (ctx.params.path.some((seg) => seg === ".." || seg === "")) {
    return new Response("bad request", { status: 400 });
  }

  const db = getDb();
  if (!videosRepo.existsById(db, ctx.params.id)) {
    return new Response("not found", { status: 404 });
  }

  const projectsDir = process.env.PROJECTS_DIR ?? "./projects";
  const projectRoot = resolve(projectsDir, ctx.params.id);
  const requested = resolve(projectRoot, ...ctx.params.path);

  // Defense in depth: even if the explicit `..` check above missed
  // something (e.g. a URL-decoded path segment doing something weird),
  // the final resolved path must remain under projectRoot.
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
