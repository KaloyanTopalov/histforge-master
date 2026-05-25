"""AmbientForge Suno sidecar — JSON-RPC over stdio.

Spawned by extensions/suno-runner/bridge.ts. Reads one JSON request per line
from stdin, writes one JSON response per line to stdout. Stderr is for logs.

Methods:
  submit(model, mode, prompt|lyrics, tags?, title?, instrumental, personaId?)
    -> {taskId, clipIds: [a, b]}
  poll(taskId)        -> {status: 'pending'|'ready'|'failed', clips, error?}
  download_wav(taskId) -> {path, bytes}        (path = absolute on disk)
  credits()           -> {credits}
  auth_status()       -> {cookieValid, jwtExpiresAt}

SunoAuth + SunoDirectClient are vendored in sidecars/suno/suno_client.py
(extracted from RAP SUNO's suno_bot.py — no external SUNO_BOT_PATH needed).
The captcha solver is likewise vendored in sidecars/suno/captcha.py so both
can evolve independently from the upstream source.

Persona mode: schema is wired but Suno's payload field name has not been
captured yet. Sidecar fails fast with PERSONA_PAYLOAD_NOT_CAPTURED.
"""

from __future__ import annotations

import json
import os
import sys
import time
import traceback
from pathlib import Path
from typing import Any, Optional

# ---------------------------------------------------------------------------
# Bootstrap: import the vendored Suno client + captcha solver (siblings).
# ---------------------------------------------------------------------------

# Bridge spawns this script with cwd=repo root, so a bare `import suno_client`
# wouldn't find the sibling module — insert this file's directory onto sys.path
# explicitly so the local vendored modules resolve.
sys.path.insert(0, str(Path(__file__).resolve().parent))

try:
    from suno_client import SunoAuth, SunoDirectClient  # type: ignore
    from captcha import BrowserCaptchaSolver
except Exception as e:  # pragma: no cover - bootstrap-time error
    sys.stderr.write(f"[suno-sidecar] FATAL: failed to import dependencies: {e!r}\n")
    sys.stderr.flush()
    sys.exit(3)


# ---------------------------------------------------------------------------
# Auth state
# ---------------------------------------------------------------------------

DOWNLOAD_DIR = Path(os.environ.get("SUNO_DOWNLOAD_DIR", "data/suno-profile/downloads"))
DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)


def _read_cookie() -> Optional[str]:
    profile_env = Path("data/suno-profile/.env")
    if profile_env.exists():
        for line in profile_env.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line.startswith("SUNO_COOKIE="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    return os.environ.get("SUNO_COOKIE")


_taskmap: dict[str, list[str]] = {}  # taskId -> clipIds (one per submit, paired)
_task_counter = 0


def _get_client() -> SunoDirectClient:
    """Build a fresh SunoDirectClient for every request.

    No caching: the operator may re-run `npm run suno:login` at any time to
    rotate the cookie, and we want the next request to pick that up without
    a sidecar restart. SunoAuth itself caches the JWT internally for the
    life of the instance, so per-call construction means each request gets
    one fresh Clerk refresh at most — trivial vs the network calls that
    follow.
    """
    cookie = _read_cookie()
    if not cookie:
        raise SidecarError(
            "SUNO_AUTH",
            "no Suno cookie — run `npm run suno:login` and leave the Chrome window open",
        )
    # Login script (scripts/suno-login.ts) always captures __client.
    # Modern Clerk makes __client JWT-shaped (starts with "eyJ"), which fools
    # suno_client.py's prefix heuristic. Force the right name.
    auth = SunoAuth(cookie, cookie_name="__client")
    return SunoDirectClient(auth)


def _new_task_id() -> str:
    global _task_counter
    _task_counter += 1
    return f"af-suno-{_task_counter:06d}"


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class SidecarError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


# ---------------------------------------------------------------------------
# Method handlers
# ---------------------------------------------------------------------------


def _is_captcha_422(err: Exception) -> bool:
    s = str(err)
    return "422" in s or "Unprocessable" in s


def handle_submit(params: dict[str, Any]) -> dict[str, Any]:
    mode = (params.get("mode") or "custom").lower()
    model = params.get("model") or "chirp-fenix"
    instrumental = bool(params.get("instrumental", False))

    if mode == "persona":
        # TODO(persona): payload field name not yet captured from suno.com
        # /api/generate/v2-web/. Capture by: open suno.com/create, select
        # persona, click Generate, watch DevTools Network tab for the request
        # body. The new key (likely persona_id or similar) goes alongside
        # `mv` in the create_song payload.
        raise SidecarError(
            "PERSONA_PAYLOAD_NOT_CAPTURED",
            "persona mode plumbing in place; payload field name needs network capture",
        )

    client = _get_client()
    lyrics = params.get("lyrics") or ""
    tags = params.get("stylePrompt") or params.get("tags") or ""
    title = params.get("title") or ""
    prompt = params.get("stylePrompt") or params.get("prompt") or ""

    if mode == "custom":
        try:
            clips = client.create_song(
                lyrics=lyrics, style=tags, title=title, model=model, instrumental=instrumental,
            )
        except Exception as e:
            if _is_captcha_422(e):
                sys.stderr.write(
                    "[suno-sidecar] API 422 — falling back to BrowserCaptchaSolver\n"
                )
                sys.stderr.flush()
                solver = BrowserCaptchaSolver()
                clips = solver.submit_song(
                    mode="custom",
                    lyrics=lyrics,
                    style=tags,
                    title=title,
                    instrumental=instrumental,
                    model=model,
                )
            else:
                raise
    elif mode == "description":
        try:
            clips = client.create_song_description_mode(
                prompt=prompt, model=model, instrumental=instrumental,
            )
        except Exception as e:
            if _is_captcha_422(e):
                sys.stderr.write(
                    "[suno-sidecar] API 422 — falling back to BrowserCaptchaSolver\n"
                )
                sys.stderr.flush()
                solver = BrowserCaptchaSolver()
                # Description mode: prompt drives the "Describe the sound you
                # want" textarea on the Simple tab; lyrics/title are unused.
                clips = solver.submit_song(
                    mode="description",
                    lyrics="",
                    style=prompt,
                    title="",
                    instrumental=instrumental,
                    model=model,
                )
            else:
                raise
    else:
        raise SidecarError("INVALID_MODE", f"unknown mode: {mode}")

    clip_ids = [c["id"] for c in clips if c.get("id")]
    if not clip_ids:
        raise SidecarError("SUNO_BRIDGE_ERROR", "Suno returned no clip ids")
    task_id = _new_task_id()
    _taskmap[task_id] = clip_ids
    return {"taskId": task_id, "clipIds": clip_ids}


def _looks_like_auth_error(err: Exception) -> bool:
    s = str(err)
    return "401" in s or "Authentication" in s or "Unauthorized" in s


def _get_clip_with_auth_retry(client: Any, cid: str) -> Any:
    """Fetch a clip; on a 401-shaped error, refresh JWT once and retry. If
    the retry still hits 401, raise SUNO_COOKIE_ROTATED so the worker can
    halt the album and surface the re-login banner. Non-auth errors bubble
    so the existing handle_poll {status: 'failed'} path can report them.
    """
    try:
        return client.get_clip(cid)
    except Exception as e:
        if not _looks_like_auth_error(e):
            raise
        try:
            client._auth._jwt = None  # type: ignore[attr-defined]
        except AttributeError:
            pass
        try:
            return client.get_clip(cid)
        except Exception as e2:
            if _looks_like_auth_error(e2):
                raise SidecarError(
                    "SUNO_COOKIE_ROTATED",
                    "Suno __client cookie rotated mid-poll — operator must run npm run suno:login",
                )
            raise


def handle_poll(params: dict[str, Any]) -> dict[str, Any]:
    task_id = params.get("taskId") or ""
    clip_ids = _taskmap.get(task_id)
    if clip_ids is None:
        return {"status": "failed", "error": "UNKNOWN_TASK"}
    client = _get_client()
    clips = []
    for cid in clip_ids:
        try:
            clip = _get_clip_with_auth_retry(client, cid)
        except SidecarError:
            # Propagate SUNO_COOKIE_ROTATED (and any future auth-class codes)
            # — the bridge maps this to HTTP 401 and the worker halts the album.
            raise
        except Exception as e:  # pragma: no cover - network-dependent
            return {"status": "failed", "error": f"poll error: {e}"}
        clips.append(
            {"id": cid, "status": clip.get("status"), "audio_url": clip.get("audio_url")}
        )

    statuses = {c["status"] for c in clips}
    if "error" in statuses or "failed" in statuses:
        return {"status": "failed", "clips": clips}
    if all(s == "complete" for s in statuses):
        return {"status": "ready", "clips": clips}
    return {"status": "pending", "clips": clips}


def handle_download_wav(params: dict[str, Any]) -> dict[str, Any]:
    task_id = params.get("taskId") or ""
    clip_ids = _taskmap.get(task_id)
    if not clip_ids:
        raise SidecarError("UNKNOWN_TASK", f"no clips for {task_id}")
    # clipIndex selects which of the generation's clips to fetch. Default 0 =
    # byte-identical legacy single-clip behavior. Suno-dual-variant callers
    # pass 1 to fetch the SECOND clip of the same generation (no extra Suno
    # spend — both clips were produced by the one create_song call).
    try:
        clip_idx = int(params.get("clipIndex") or 0)
    except (TypeError, ValueError):
        clip_idx = 0
    if clip_idx < 0 or clip_idx >= len(clip_ids):
        raise SidecarError(
            "SUNO_DOWNLOAD_FAILED",
            f"clip index {clip_idx} out of range ({len(clip_ids)} clips) for {task_id}",
        )
    client = _get_client()
    chosen_id = clip_ids[clip_idx]
    # Suno's WAV download is a two-step server-side conversion:
    #   1. POST /api/gen/{id}/convert_wav/  — triggers WAV transcoding
    #   2. GET  /api/gen/{id}/wav_file/     — returns {wav_file_url} once ready
    # Pattern verified live 2026-04-28; matches D:\ai-music-ext-main\contentScript.js:1160-1199.
    # Studio-API requires Bearer JWT in Authorization (cookie alone is 401);
    # client._auth.headers() supplies the same header dict that
    # SunoDirectClient._get/_post use for create_song / get_clip.
    base = "https://studio-api.prod.suno.com"

    def _hdrs() -> dict:
        return client._auth.headers()  # type: ignore[attr-defined]

    def _refresh_and_call(verb: str, url: str) -> Any:
        method = client._session.post if verb == "POST" else client._session.get  # type: ignore[attr-defined]
        r = method(url, headers=_hdrs(), timeout=60)
        if r.status_code == 401:
            client._auth._jwt = None  # type: ignore[attr-defined]
            r = method(url, headers=_hdrs(), timeout=60)
            if r.status_code == 401:
                raise SidecarError("SUNO_AUTH", f"Suno rejected {verb} {url.split('/api')[-1]} (401 after refresh)")
        return r

    # Step 1: trigger conversion (idempotent — already-converted clips return
    # quickly). 200 / 204 / 409 are all treated as success.
    convert_resp = _refresh_and_call("POST", f"{base}/api/gen/{chosen_id}/convert_wav/")
    if convert_resp.status_code not in (200, 202, 204, 409):
        raise SidecarError(
            "SUNO_DOWNLOAD_FAILED",
            f"convert_wav -> {convert_resp.status_code}: {convert_resp.text[:200]}",
        )

    # Step 2: poll wav_file/ until wav_file_url appears (max ~90s).
    wav_url: str | None = None
    poll_deadline = time.time() + 90
    while time.time() < poll_deadline:
        wav_resp = _refresh_and_call("GET", f"{base}/api/gen/{chosen_id}/wav_file/")
        if not wav_resp.ok:
            raise SidecarError(
                "SUNO_DOWNLOAD_FAILED",
                f"wav_file -> {wav_resp.status_code}: {wav_resp.text[:200]}",
            )
        try:
            data = wav_resp.json() or {}
        except Exception:
            data = {}
        wav_url = data.get("wav_file_url") if isinstance(data, dict) else None
        if wav_url:
            break
        time.sleep(3)

    if not wav_url:
        raise SidecarError(
            "SUNO_DOWNLOAD_FAILED",
            f"wav_file_url not produced within 90s for clip {chosen_id}",
        )

    # Step 3: stream the WAV. The CDN URL (cdn1.suno.ai/...wav) is public-ish
    # but pass auth headers in case Suno tightens the policy.
    out_path = DOWNLOAD_DIR / (
        f"{task_id}.wav" if clip_idx == 0 else f"{task_id}-c{clip_idx}.wav"
    )
    with client._session.get(wav_url, stream=True, timeout=300) as r:  # type: ignore[attr-defined]
        if not r.ok:
            raise SidecarError(
                "SUNO_DOWNLOAD_FAILED",
                f"wav fetch -> {r.status_code}: {r.text[:200]}",
            )
        size = 0
        with out_path.open("wb") as f:
            for chunk in r.iter_content(chunk_size=64 * 1024):
                if chunk:
                    f.write(chunk)
                    size += len(chunk)
    return {"path": str(out_path.resolve()), "bytes": size}


def handle_credits(_params: dict[str, Any]) -> dict[str, Any]:
    client = _get_client()
    info = client.check_credits() or {}
    credits = (
        info.get("total_credits_left")
        or info.get("credits_left")
        or info.get("credits")
        or 0
    )
    return {"credits": int(credits)}


def handle_auth_status(_params: dict[str, Any]) -> dict[str, Any]:
    cookie = _read_cookie()
    return {"cookieValid": bool(cookie)}


METHODS = {
    "submit": handle_submit,
    "poll": handle_poll,
    "download_wav": handle_download_wav,
    "credits": handle_credits,
    "auth_status": handle_auth_status,
}


# ---------------------------------------------------------------------------
# Stdio loop
# ---------------------------------------------------------------------------


def _send(obj: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _log(msg: str) -> None:
    sys.stderr.write(f"[suno-sidecar] {msg}\n")
    sys.stderr.flush()


def main() -> None:
    _log(f"started pid={os.getpid()}")
    _send({"event": "ready", "pid": os.getpid()})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as e:
            _send({"id": None, "error": {"code": "BAD_REQUEST", "message": str(e)}})
            continue
        req_id = req.get("id")
        method = req.get("method") or ""
        params = req.get("params") or {}
        handler = METHODS.get(method)
        if handler is None:
            _send({"id": req_id, "error": {"code": "UNKNOWN_METHOD", "message": method}})
            continue
        try:
            result = handler(params)
            _send({"id": req_id, "result": result})
        except SidecarError as e:
            _send({"id": req_id, "error": {"code": e.code, "message": e.message}})
        except Exception as e:
            _log(f"unhandled error in {method}: {e!r}\n{traceback.format_exc()}")
            _send(
                {
                    "id": req_id,
                    "error": {"code": "SIDECAR_INTERNAL", "message": f"{type(e).__name__}: {e}"},
                }
            )
    _log("stdin closed; exiting")


if __name__ == "__main__":
    main()
