"""AmbientForge Suno captcha solver — drives suno.com via CDP.

Vendored from `E:\\Projects\\RAP SUNO\\suno_bot.py:208-341` and rewritten for
the current Suno UI (Session 4.6, selectors verified live 2026-04-28 against
Chrome 147 with credits=3910).

The upstream version targeted a stale UI: forced the Advanced tab
unconditionally, hunted for style textareas via stale placeholder
substrings (`moombahcore`, `style`, `genre`), never toggled Instrumental,
and never waited for Create to become enabled — so the form silently failed
and the network monitor timed out at 120 s with `No clips returned`.

This rewrite always uses the **Advanced tab** form for both submission
modes. Live probing showed Suno's current Simple-tab "Describe the sound
you want" textarea is vestigial — filling it does not enable Create — but
the lyrics+style textareas (with stable ``data-testid`` hooks) are wired to
the form watcher in both Simple and Advanced layouts. So:

- ``mode='custom'`` — fill ``[data-testid="lyrics-textarea"]`` with lyrics,
  fill the textarea inside ``[data-testid="create-form-styles-wrapper"]``
  with style, fill title input, set Instrumental, click Create.
- ``mode='description'`` — same form, but lyrics is empty and the prompt
  goes into the style field (this is functionally equivalent to API
  description-mode + instrumental for AmbientForge's use case: an
  instrumental ambient song generated from a stylistic prompt).

The Instrumental toggle is a ``<button>`` with text "Instrumental" and
``aria-label="Check this to generate an instrumental only song"``. State is
read from ``getComputedStyle(...).backgroundColor``: ``rgba(0, 0, 0, 0)``
(transparent) = off, anything else = on (verified on=rgb(247, 244, 239)
from the Tailwind ``bg-foreground-primary`` class).

Solves Suno's self-hosted hCaptcha (hcaptcha-endpoint-prod.suno.com) by
letting Chrome's already-logged-in profile handle the challenge natively
when it appears — external captcha services can't solve this instance.
"""

from __future__ import annotations

import json
import os
import sys
import time
from typing import Any

import requests
import websocket  # websocket-client


def _stderr(msg: str) -> None:
    """Write directly to stderr; the bridge captures these into the
    [sidecar] log lane. Python's logging framework would silently drop
    messages because the sidecar never configures a handler.
    """
    sys.stderr.write(msg if msg.endswith("\n") else msg + "\n")
    sys.stderr.flush()


CDP_PORT = int(os.environ.get("SUNO_CDP_PORT", "9333"))
GENERATE_DEADLINE_S = 120
CREATE_BUTTON_WAIT_S = 5
CDP_RESPONSE_TIMEOUT_S = 30


class BrowserCaptchaSolver:
    """Drive the suno.com create form via CDP to submit a song."""

    def __init__(self) -> None:
        self._ws_mod = websocket

    def _get_suno_ws(self) -> str:
        targets = requests.get(f"http://127.0.0.1:{CDP_PORT}/json", timeout=3).json()
        pages = [
            t for t in targets
            if t.get("type") == "page" and t.get("url", "").startswith("https://suno.com")
        ]
        if not pages:
            raise RuntimeError(f"No suno.com tab open in Chrome (port {CDP_PORT})")
        return pages[0]["webSocketDebuggerUrl"]

    @staticmethod
    def _log(msg: str) -> None:
        # Operator-readable; lands in the bridge's [sidecar] stderr lane.
        _stderr(msg)

    def _await_response(self, ws, expect_id: int, timeout_s: float = CDP_RESPONSE_TIMEOUT_S) -> dict:
        """Receive CDP messages until we get the response with the matching id.

        CDP interleaves events (Network.requestWillBeSent, Console events…)
        with command responses, so a single ``recv()`` is unsafe — the
        upstream code's first bug.
        """
        deadline = time.time() + timeout_s
        ws.settimeout(min(timeout_s, 5))
        while time.time() < deadline:
            try:
                msg = json.loads(ws.recv())
            except self._ws_mod.WebSocketTimeoutException:
                continue
            except Exception as e:  # pragma: no cover - encoding noise
                if "codec" in str(e):
                    continue
                raise
            if msg.get("id") == expect_id:
                return msg
        raise RuntimeError(f"No CDP response for id={expect_id} within {timeout_s}s")

    def submit_song(
        self,
        *,
        mode: str,
        lyrics: str,
        style: str,
        title: str,
        instrumental: bool,
        model: str,
    ) -> list[dict[str, Any]]:
        if mode not in ("custom", "description"):
            raise ValueError(
                f"BrowserCaptchaSolver.submit_song: unsupported mode {mode!r}"
            )

        self._log(f"[captcha-solver] step: connecting to CDP at port {CDP_PORT}")
        ws_url = self._get_suno_ws()
        ws = self._ws_mod.create_connection(ws_url)
        try:
            self._log("[captcha-solver] step: connected, enabling Network domain")
            ws.send(json.dumps({"id": 1, "method": "Network.enable"}))
            self._await_response(ws, 1, timeout_s=10)

            payload = {
                "mode": mode,
                "lyrics": lyrics,
                "style": style,
                "title": title,
                "instrumental": instrumental,
                "createWaitMs": CREATE_BUTTON_WAIT_S * 1000,
            }
            fill_js = self._build_fill_js(payload)

            self._log(
                f"[captcha-solver] step: filling form (mode={mode}, instrumental={instrumental}, "
                f"lyrics_len={len(lyrics)}, style_len={len(style)}, title_len={len(title)})"
            )
            ws.send(json.dumps({
                "id": 2,
                "method": "Runtime.evaluate",
                "params": {
                    "expression": fill_js,
                    "awaitPromise": True,
                    "returnByValue": True,
                },
            }))
            result = self._await_response(ws, 2, timeout_s=CREATE_BUTTON_WAIT_S + 10)

            ex = result.get("result", {}).get("exceptionDetails")
            if ex:
                raise RuntimeError(f"Form-fill JS threw: {json.dumps(ex)[:400]}")

            val = result.get("result", {}).get("result", {}).get("value", "{}")
            try:
                fill_result = json.loads(val) if val else {}
            except json.JSONDecodeError:
                fill_result = {"ok": False, "error": "non_json_result", "raw": val[:200]}

            steps = fill_result.get("steps", [])
            for s in steps:
                self._log(f"[captcha-solver] step: {s}")

            if not fill_result.get("ok"):
                err = fill_result.get("error", "unknown")
                state = fill_result.get("state", {})
                raise RuntimeError(
                    f"Browser form submission failed: {err}; state={json.dumps(state)}"
                )

            self._log("[captcha-solver] step: clicked Create — waiting for /api/generate response")
            return self._wait_for_generate(ws)
        finally:
            try:
                ws.close()
            except Exception:
                pass

    def _wait_for_generate(self, ws) -> list[dict[str, Any]]:
        deadline = time.time() + GENERATE_DEADLINE_S
        while time.time() < deadline:
            ws.settimeout(5)
            try:
                msg = json.loads(ws.recv())
            except self._ws_mod.WebSocketTimeoutException:
                continue
            except Exception as e:  # pragma: no cover
                if "codec" in str(e):
                    continue
                _stderr(f"[captcha-solver] CDP monitor error (ignored): {e!r}")
                continue

            if msg.get("method") != "Network.responseReceived":
                continue
            url = msg.get("params", {}).get("response", {}).get("url", "")
            if "generate" not in url or "v2" not in url:
                continue

            req_id = msg["params"]["requestId"]
            self._log("[captcha-solver] step: captured /api/generate response, fetching body")
            ws.send(json.dumps({
                "id": 99,
                "method": "Network.getResponseBody",
                "params": {"requestId": req_id},
            }))
            try:
                body_msg = self._await_response(ws, 99, timeout_s=10)
            except Exception as e:
                self._log(f"[captcha-solver] step: getResponseBody failed: {e}; continuing wait")
                continue

            body = body_msg.get("result", {}).get("body", "")
            if not body:
                continue
            try:
                data = json.loads(body)
            except json.JSONDecodeError:
                self._log("[captcha-solver] step: response body was not JSON; continuing wait")
                continue

            clips = data.get("clips") or []
            if not clips:
                continue

            clip_ids = [
                {"id": c["id"], "status": c.get("status", "submitted")}
                for c in clips if c.get("id")
            ]
            self._log(
                "[captcha-solver] step: generated %d clip(s): %s"
                % (len(clip_ids), ",".join(c["id"][:12] for c in clip_ids))
            )
            return clip_ids

        raise RuntimeError("No clips returned from browser generation (timed out)")

    @staticmethod
    def _build_fill_js(payload: dict) -> str:
        params = json.dumps(payload)
        # Single async IIFE; returns JSON string {ok: bool, steps: string[], error?, state?}.
        return r"""
        (async () => {
          const PARAMS = __PARAMS__;
          const steps = [];
          const log = (s) => { steps.push(s); };
          const sleep = (ms) => new Promise(r => setTimeout(r, ms));

          const setTextareaValue = (el, value) => {
            const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
            setter.call(el, value);
            const tr = el._valueTracker; if (tr) tr.setValue("");
            el.dispatchEvent(new Event("input", { bubbles: true }));
          };
          const setInputValue = (el, value) => {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
            setter.call(el, value);
            const tr = el._valueTracker; if (tr) tr.setValue("");
            el.dispatchEvent(new Event("input", { bubbles: true }));
          };

          const tabButton = (text) => Array.from(document.querySelectorAll("button"))
            .find(b => b.textContent.trim() === text);
          const isTabActive = (btn) => !!btn && (btn.className || "").split(/\s+/).indexOf("active") >= 0;

          // Always submit via the Advanced tab form. Suno's current UI keeps
          // the Simple-tab "Describe the sound you want" textarea in the DOM
          // but disconnected from the form watcher, so filling it does not
          // enable Create. The lyrics+style fields (stable data-testid hooks)
          // are the only ones the form watcher reads.
          const advTab = tabButton("Advanced");
          if (!advTab) {
            return JSON.stringify({ ok: false, error: "advanced_tab_not_found", state: {}, steps });
          }
          if (!isTabActive(advTab)) {
            advTab.click();
            log("clicked Advanced tab");
            await sleep(500);
          } else {
            log("Advanced tab already active");
          }

          // Fill lyrics. Empty for description mode; track lyrics for custom.
          const lyricsTA = document.querySelector('[data-testid="lyrics-textarea"]');
          if (!lyricsTA) {
            return JSON.stringify({ ok: false, error: "lyrics_textarea_not_found", state: {}, steps });
          }
          const lyricsToSet = PARAMS.mode === "description" ? "" : (PARAMS.lyrics || "");
          setTextareaValue(lyricsTA, lyricsToSet);
          log("filled lyrics-textarea (" + lyricsToSet.length + " chars, mode=" + PARAMS.mode + ")");

          // Fill style. For description mode, the prompt goes here. For
          // custom mode, the channel's sunoStylePrompt goes here.
          const stylesWrapper = document.querySelector('[data-testid="create-form-styles-wrapper"]');
          const styleTA = stylesWrapper && stylesWrapper.querySelector("textarea");
          if (!styleTA) {
            return JSON.stringify({
              ok: false,
              error: "style_textarea_not_found",
              state: { wrapperFound: !!stylesWrapper },
              steps,
            });
          }
          setTextareaValue(styleTA, PARAMS.style || "");
          log("filled style textarea (" + (PARAMS.style || "").length + " chars)");

          // Title input scoped to the form container that holds both
          // lyrics-textarea and create-form-styles-wrapper. The page has
          // multiple elements with placeholder "Song Title (Optional)";
          // only the form one is in the lyrics+style ancestor scope.
          let formContainer = lyricsTA;
          while (formContainer && formContainer !== document.body) {
            if (formContainer.contains(stylesWrapper)) break;
            formContainer = formContainer.parentElement;
          }
          const titleInput = (formContainer || document.body)
            .querySelector('input[placeholder="Song Title (Optional)"]');
          if (titleInput) {
            setInputValue(titleInput, PARAMS.title || "");
            log("filled title input");
          } else {
            log("title input not found; skipped (optional)");
          }

          // Instrumental toggle. Single button; identity confirmed by both
          // visible text and aria-label. Off-state has transparent
          // background (Tailwind `bg-transparent`); when on, Suno swaps to
          // a non-transparent action color.
          const instrumentalBtn = Array.from(document.querySelectorAll("button")).find(
            b => b.textContent.trim() === "Instrumental"
              && (b.getAttribute("aria-label") || "").toLowerCase().indexOf("instrumental") >= 0
          );
          if (!instrumentalBtn) {
            return JSON.stringify({ ok: false, error: "instrumental_button_not_found", state: {}, steps });
          }
          const bgRaw = getComputedStyle(instrumentalBtn).backgroundColor || "";
          const isOn = !(
            bgRaw === "" ||
            bgRaw === "transparent" ||
            /^rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)$/.test(bgRaw)
          );
          if (isOn !== !!PARAMS.instrumental) {
            instrumentalBtn.click();
            log("instrumental: clicked toggle (was " + (isOn ? "on" : "off")
                + " -> " + (PARAMS.instrumental ? "on" : "off") + ")");
            await sleep(200);
          } else {
            log("instrumental: already " + (isOn ? "on" : "off") + ", skipped");
          }

          // Wait for Create to become enabled.
          const findCreate = () => Array.from(document.querySelectorAll("button"))
            .find(b => b.getAttribute("aria-label") === "Create song");
          let createBtn = findCreate();
          if (!createBtn) {
            return JSON.stringify({ ok: false, error: "create_button_not_found", state: {}, steps });
          }
          const enableDeadline = Date.now() + (PARAMS.createWaitMs || 5000);
          while (createBtn && createBtn.disabled && Date.now() < enableDeadline) {
            await sleep(100);
            createBtn = findCreate();
          }
          if (!createBtn || createBtn.disabled) {
            const lyricsTA2 = document.querySelector('[data-testid="lyrics-textarea"]');
            const stylesWrapper2 = document.querySelector('[data-testid="create-form-styles-wrapper"]');
            const styleTA2 = stylesWrapper2 && stylesWrapper2.querySelector("textarea");
            return JSON.stringify({
              ok: false,
              error: "create_button_disabled",
              state: {
                advancedActive: isTabActive(tabButton("Advanced")),
                lyricsLen: lyricsTA2 ? (lyricsTA2.value || "").length : null,
                styleLen: styleTA2 ? (styleTA2.value || "").length : null,
                instrumentalBg: getComputedStyle(instrumentalBtn).backgroundColor,
                createDisabled: createBtn ? createBtn.disabled : null,
              },
              steps,
            });
          }
          createBtn.click();
          log("clicked Create");
          return JSON.stringify({ ok: true, steps });
        })()
        """.replace("__PARAMS__", params)
