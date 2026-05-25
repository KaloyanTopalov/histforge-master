"""Vendored Suno API client.

Extracted verbatim from `E:\\Projects\\RAP SUNO\\suno_bot.py` — the `SunoAuth`
(Clerk cookie -> JWT) + `SunoDirectClient` (create_song / get_clip / feed /
download) classes plus the legacy `CaptchaSolver` placeholder and the inline
constants those classes use. Mirrors the `captcha.py` vendoring (Session 4.6)
so AmbientForge no longer depends on the external `SUNO_BOT_PATH` directory.

Only dependencies: the Python stdlib + `requests`. The upstream file's
`config` / `models` / `prompt_engine` imports were for its CLI/lyric pipeline,
which the sidecar does not use, so none of that is pulled in here. Auth secrets
are NOT in this file — the sidecar supplies the cookie at runtime.

Re-vendor (re-copy the same class bodies) if RAP SUNO's `suno_bot.py` changes
because Suno's internal API drifted.
"""

from __future__ import annotations

import json
import logging
import os
import random
import time
from pathlib import Path
from typing import List, Optional

import requests

logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────
# CONSTANTS (inline in upstream suno_bot.py, NOT from config.py)
# ─────────────────────────────────────────────

CLERK_BASE = "https://auth.suno.com"
API_BASE = "https://studio-api.prod.suno.com"
DOWNLOAD_DIR = "output/downloads"
POLL_INTERVAL_S = 10
POLL_MAX_WAIT_S = 600  # 10 min per song
POLL_JITTER_S = 2      # random jitter on poll intervals


# ─────────────────────────────────────────────
# SUNO AUTH (Clerk-based)
# ─────────────────────────────────────────────

class SunoAuth:
    """Handles authentication for Suno's internal API.

    Supports two modes:
    1. _session cookie (JWT) — used directly as Bearer token, refreshed via Clerk
    2. __client cookie (legacy) — exchanged for JWT via Clerk token endpoint

    The _session cookie is a JWT that can be used directly. When it expires,
    we use the Clerk refresh flow with the stored cookies.
    """

    def __init__(self, cookie_value: str, cookie_name: str = "__session"):
        self._cookie_name = cookie_name
        self._cookie_value = cookie_value
        self._session = requests.Session()
        self._jwt: Optional[str] = None
        self._jwt_expires: float = 0
        self._sid: Optional[str] = None

        if cookie_name in ("_session", "__session") and cookie_value.startswith("eyJ"):
            # __session cookie IS the JWT — use it directly
            self._jwt = cookie_value
            self._jwt_expires = time.time() + 300  # assume 5 min validity
            logger.info("Using __session JWT directly (length=%d)", len(cookie_value))
        else:
            # __client cookie — need Clerk exchange
            self._session.cookies.set("__client", cookie_value, domain=".suno.com")

        # Always set cookies for refresh
        self._session.cookies.set(cookie_name, cookie_value, domain=".suno.com")

    def _get_session_id(self) -> str:
        resp = self._session.post(
            f"{CLERK_BASE}/v1/client",
            params={"__clerk_api_version": "2025-11-10"},
        )
        resp.raise_for_status()
        data = resp.json()
        response_data = data.get("response", data)

        sid = response_data.get("last_active_session_id")
        if sid:
            return sid

        sessions = response_data.get("sessions", [])
        if sessions:
            s = sessions[0]
            return s.get("id", s) if isinstance(s, dict) else s

        raise RuntimeError(
            "No active Suno session. Is your cookie valid and fresh? "
            "Copy it again from your browser."
        )

    def get_token(self) -> str:
        """Get a valid JWT, auto-refreshing when expired."""
        now = time.time()
        if self._jwt and now < self._jwt_expires - 5:
            return self._jwt

        # Try Clerk token refresh
        try:
            if not self._sid:
                logger.info("Refreshing auth via Clerk...")
                self._sid = self._get_session_id()
                logger.info("Session ID: %s...", self._sid[:12])

            resp = self._session.post(
                f"{CLERK_BASE}/v1/client/sessions/{self._sid}/tokens",
                params={"__clerk_api_version": "2025-11-10"},
            )
            resp.raise_for_status()
            data = resp.json()
            new_jwt = data.get("jwt", data.get("token"))
            if new_jwt:
                self._jwt = new_jwt
                self._jwt_expires = now + 50
                logger.info("JWT refreshed successfully")
                return self._jwt
        except Exception as e:
            logger.warning("Clerk refresh failed: %s", e)

        # Fallback: if we have a JWT from _session cookie, use it even if "expired"
        # (the API might still accept it)
        if self._jwt:
            logger.warning("Using existing JWT (may be expired)")
            return self._jwt

        raise RuntimeError(
            "Authentication failed. Your cookie has expired. "
            "Copy a fresh _session cookie from suno.com."
        )

    def headers(self) -> dict:
        return {
            "Authorization": f"Bearer {self.get_token()}",
            "Origin": "https://suno.com",
            "Referer": "https://suno.com/",
            "User-Agent": self._user_agent,
        }

    @property
    def _user_agent(self) -> str:
        """Consistent User-Agent per session (matches real Chrome on Windows)."""
        if not hasattr(self, "_ua_cached"):
            # Use a realistic, current Chrome UA
            chrome_ver = random.choice(["133.0.0.0", "134.0.0.0", "134.0.6998.89", "135.0.0.0"])
            self._ua_cached = (
                f"Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                f"AppleWebKit/537.36 (KHTML, like Gecko) "
                f"Chrome/{chrome_ver} Safari/537.36"
            )
        return self._ua_cached


# ─────────────────────────────────────────────
# Legacy solver wrapper — not used with self-hosted hCaptcha.
# Kept verbatim so SunoDirectClient.__init__ behaves identically; the real
# browser-captcha flow is the separately vendored captcha.BrowserCaptchaSolver,
# driven by the sidecar (not by SunoDirectClient).
# ─────────────────────────────────────────────

class CaptchaSolver:
    """Placeholder — Suno's custom hCaptcha can't be solved externally."""
    def __init__(self, api_key: str):
        self._api_key = api_key
    def solve(self) -> str:
        raise RuntimeError("Suno uses self-hosted hCaptcha — use BrowserCaptchaSolver instead")


# ─────────────────────────────────────────────
# SUNO API CLIENT (internal endpoints)
# ─────────────────────────────────────────────

class SunoDirectClient:
    """Creates songs via Suno's internal API (same as the website).

    Includes automatic hCaptcha solving via 2Captcha when needed.
    """

    def __init__(self, auth: SunoAuth, captcha_api_key: str = None):
        self._auth = auth
        self._session = requests.Session()
        self._captcha_solver = None
        self._last_captcha_token = None

        key = captcha_api_key or os.getenv("TWOCAPTCHA_KEY")
        if key:
            self._captcha_solver = CaptchaSolver(key)
            logger.info("2Captcha solver enabled")
        else:
            logger.warning("No TWOCAPTCHA_KEY — captcha solving disabled")

    def _get(self, path: str, params: dict = None) -> dict:
        resp = self._session.get(
            f"{API_BASE}{path}",
            headers=self._auth.headers(),
            params=params,
        )
        if resp.status_code == 401:
            self._auth._jwt = None
            resp = self._session.get(
                f"{API_BASE}{path}",
                headers=self._auth.headers(),
                params=params,
            )
        resp.raise_for_status()
        return resp.json()

    def _post(self, path: str, payload: dict) -> dict:
        resp = self._session.post(
            f"{API_BASE}{path}",
            headers={**self._auth.headers(), "Content-Type": "application/json"},
            json=payload,
        )
        if resp.status_code == 401:
            self._auth._jwt = None
            resp = self._session.post(
                f"{API_BASE}{path}",
                headers={**self._auth.headers(), "Content-Type": "application/json"},
                json=payload,
            )
        resp.raise_for_status()
        return resp.json()

    def _check_captcha_required(self) -> bool:
        """Check if Suno requires captcha before generation."""
        try:
            resp = self._session.post(
                f"{API_BASE}/api/c/check",
                headers={**self._auth.headers(), "Content-Type": "application/json"},
                json={"ctype": "generation"},
            )
            resp.raise_for_status()
            required = resp.json().get("required", False)
            logger.info("Captcha required: %s", required)
            return required
        except Exception as e:
            logger.warning("Captcha check failed: %s -- assuming required", e)
            return True

    def _solve_captcha(self) -> Optional[str]:
        """Solve captcha if required. Returns token or None.

        If captcha is required but solving fails, returns None and lets
        the caller submit without a token (may get 422, triggering retry).
        """
        if not self._check_captcha_required():
            return None

        if not self._captcha_solver:
            logger.warning("Captcha required but no solver — submitting without token")
            return None

        try:
            token = self._captcha_solver.solve()
            self._last_captcha_token = token
            return token
        except Exception as e:
            logger.warning("Captcha solve failed: %s — submitting without token", e)
            return None

    def check_credits(self) -> dict:
        """Check remaining credits/quota."""
        return self._get("/api/billing/info/")

    def create_song(
        self,
        lyrics: str,
        style: str,
        title: str,
        model: str = "chirp-fenix",
        instrumental: bool = False,
    ) -> list:
        """Submit a song generation request with automatic captcha solving.

        Each generation produces 2 clips (Suno always generates pairs).
        """
        # Solve captcha before generation
        captcha_token = self._solve_captcha()

        payload = {
            "prompt": lyrics,
            "tags": style,
            "title": title,
            "mv": model,
            "make_instrumental": instrumental,
        }
        if captcha_token:
            payload["token"] = captcha_token

        logger.info("Creating song: %s (model=%s, captcha=%s)", title, model, bool(captcha_token))
        data = self._post("/api/generate/v2-web/", payload)

        clips = data.get("clips", [])
        if not clips:
            raise RuntimeError(f"No clips returned: {json.dumps(data)[:300]}")

        clip_ids = [c["id"] for c in clips]
        logger.info("Song submitted — %d clips: %s", len(clips), ", ".join(clip_ids))
        return clips

    def create_song_description_mode(
        self,
        prompt: str,
        model: str = "chirp-fenix",
        instrumental: bool = False,
    ) -> list:
        """Create a song in description mode (Suno writes the lyrics).

        Use this for quick/inspiration-based generation.
        """
        captcha_token = self._solve_captcha()

        payload = {
            "gpt_description_prompt": prompt,
            "mv": model,
            "make_instrumental": instrumental,
        }
        if captcha_token:
            payload["token"] = captcha_token

        logger.info("Creating song (description mode, captcha=%s): %s...", bool(captcha_token), prompt[:60])
        data = self._post("/api/generate/v2-web/", payload)

        clips = data.get("clips", [])
        if not clips:
            raise RuntimeError(f"No clips returned: {json.dumps(data)[:300]}")

        clip_ids = [c["id"] for c in clips]
        logger.info("Song submitted — %d clips: %s", len(clips), ", ".join(clip_ids))
        return clips

    def get_clip(self, clip_id: str) -> dict:
        """Get a single clip's current state."""
        data = self._get(f"/api/clip/{clip_id}")
        return data

    def get_feed(self, ids: str = None) -> list:
        """Get clips from feed, optionally filtered by IDs."""
        params = {}
        if ids:
            params["ids"] = ids
        data = self._get("/api/feed/v2", params=params)
        if isinstance(data, list):
            return data
        return data.get("clips", data.get("data", []))

    def wait_for_clips(self, clip_ids: List[str]) -> List[dict]:
        """Poll until all clips are complete or failed.

        Handles large batches by querying in chunks of 10 IDs.
        """
        logger.info("Waiting for %d clips to complete...", len(clip_ids))
        start = time.time()

        while time.time() - start < POLL_MAX_WAIT_S:
            # Query in chunks (API may not handle too many IDs at once)
            all_clips = []
            for i in range(0, len(clip_ids), 10):
                chunk = clip_ids[i:i + 10]
                ids_param = ",".join(chunk)
                clips = self.get_feed(ids=ids_param)
                if clips:
                    all_clips.extend(clips)
                time.sleep(0.5)  # small delay between chunk queries

            clips = all_clips
            if not clips:
                logger.warning("No clips returned from feed -- retrying")
                time.sleep(POLL_INTERVAL_S + random.uniform(0, POLL_JITTER_S))
                continue

            # Check statuses
            all_done = True
            n_complete = 0
            n_failed = 0
            n_pending = 0
            for clip in clips:
                status = clip.get("status", "")
                clip_id = clip.get("id", "?")
                if status == "complete":
                    n_complete += 1
                elif status in ("error", "failed"):
                    n_failed += 1
                    logger.error("Clip %s failed: %s", clip_id, clip.get("error_message", "unknown"))
                else:
                    n_pending += 1
                    all_done = False

            elapsed = int(time.time() - start)
            if all_done:
                complete = [c for c in clips if c.get("status") == "complete"]
                logger.info("All clips done in %ds — %d complete", elapsed, len(complete))
                return clips

            logger.info(
                "Progress: %d complete, %d pending, %d failed (%ds elapsed)",
                n_complete, n_pending, n_failed, elapsed,
            )
            time.sleep(POLL_INTERVAL_S + random.uniform(0, POLL_JITTER_S))

        raise TimeoutError(f"Clips did not complete within {POLL_MAX_WAIT_S}s")

    def add_to_playlist(self, playlist_id: str, clip_ids: List[str]):
        """Add clips to a playlist."""
        self._post("/api/playlist/update_clips/", {
            "playlist_id": playlist_id,
            "update_type": "add",
            "metadata": {"clip_ids": clip_ids},
        })
        logger.info("Added %d clips to playlist %s", len(clip_ids), playlist_id)

    def get_playlist_clips(self, playlist_id: str, limit: int = 100) -> list:
        """Get all clips from a playlist (paginated)."""
        all_clips = []
        page = 0
        while len(all_clips) < limit:
            data = self._get(f"/api/playlist/{playlist_id}", params={"page": page})
            items = data.get("playlist_clips", [])
            if not items:
                break
            for item in items:
                clip = item.get("clip", item)
                all_clips.append(clip)
            page += 1
        return all_clips[:limit]

    def download_clip(self, clip: dict, output_dir: str = DOWNLOAD_DIR) -> Optional[str]:
        """Download a clip's audio file."""
        clip_id = clip.get("id", "unknown")
        title = clip.get("title", "untitled").strip()
        audio_url = clip.get("audio_url")

        if not audio_url:
            logger.warning("Clip %s has no audio_url — skipping", clip_id)
            return None

        out_path = Path(output_dir)
        out_path.mkdir(parents=True, exist_ok=True)

        safe_title = "".join(c if c.isalnum() or c in " -_" else "_" for c in title)
        safe_title = safe_title.strip()[:80]
        filename = f"{safe_title}_{clip_id[:8]}.mp3"
        filepath = out_path / filename

        if filepath.exists():
            logger.info("Already exists: %s", filename)
            return str(filepath)

        logger.info("Downloading: %s", filename)
        resp = requests.get(audio_url, stream=True, timeout=60)
        resp.raise_for_status()

        with open(filepath, "wb") as f:
            for chunk in resp.iter_content(chunk_size=8192):
                f.write(chunk)

        size_mb = filepath.stat().st_size / 1e6
        logger.info("Saved: %s (%.1f MB)", filename, size_mb)
        return str(filepath)
