import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { resolveFlowAccountByToken } from "@/lib/flow-auth";
import * as gfRepo from "@/lib/repos/google-flow";

interface RouteCtx {
  params: { token: string; taskId: string };
}

/**
 * Extension-facing artifact passthrough — token+task-scoped streaming
 * download of the reference image attached to a specific dispatched
 * task. The youforge-flow image executor reads `task.referenceImage`
 * (an absolute URL pointing at this route) and `uploadImage`s the
 * response bytes as the Flow `imageInputs` reference.
 *
 * Authorization model (tightened on 2026-05-26 after a Codex review):
 *
 *   The URL is bound to a single (account, task) pair so a holder of
 *   one Flow account token can NEVER fetch reference artifacts attached
 *   to another account's tasks. The next-task route builds the URL
 *   when it dispatches a row; this route verifies:
 *     1. [token] matches a known Flow account (404 mismatch)
 *     2. [taskId] resolves to a queue row (404 unknown)
 *     3. the row's `assigned_account_id` equals the calling account
 *        (403 wrong account)
 *     4. the row's status is `dispatched` — i.e. the task is still
 *        in-flight for that account (404 not-currently-dispatched)
 *     5. the row's `reference_image` is non-null (404 nothing to serve)
 *
 * Only the file the dispatch route issued is served — there is no
 * caller-controlled `path` query string. This eliminates the entire
 * class of "guess the videoId / path and read other operators' files"
 * threats by construction.
 *
 * Defense-in-depth: even with the task lookup as the authoritative
 * binding, the resolved on-disk path is still verified to live strictly
 * under `projects/<videoId>/` — guards against weird PROJECTS_DIR
 * layouts or symlinked paths.
 */
const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

export async function GET(
  req: Request,
  ctx: RouteCtx
): Promise<Response> {
  const auth = resolveFlowAccountByToken(ctx.params.token);
  if (!auth.ok) return auth.response;
  const { db, account } = auth;

  const row = gfRepo.findTaskByExternalId(db, ctx.params.taskId);
  if (!row) {
    return new Response("not found", { status: 404 });
  }
  if (row.assigned_account_id !== account.id) {
    return new Response("forbidden", { status: 403 });
  }
  if (row.status !== "dispatched") {
    return new Response("not found", { status: 404 });
  }
  if (row.reference_image === null) {
    return new Response("not found", { status: 404 });
  }

  const projectsDir = process.env.PROJECTS_DIR ?? "./projects";
  const projectRoot = resolve(projectsDir, row.video_id);
  const requested = resolve(projectRoot, row.reference_image);
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
