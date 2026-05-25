// Magnific HITL - shared isolated-world helpers
//
// This file runs first in the same per-frame isolated world as the two
// Magnific orchestrator content scripts (content-magnific.js,
// content-magnific-i2v.js). Its job is to declare DOM helpers as
// isolated-world globals so the orchestrators can reference them by bare
// name from inside their IIFEs.
//
// IIFE wrapper deliberately omitted: the orchestrators wrap their code
// in `(function () { 'use strict'; ... })()`. Wrapping the shared helpers
// in their own IIFE would scope these declarations to that IIFE, hiding
// them from the orchestrators. Top-level `function` / `const` declarations
// here are reachable as globals in the same isolated world.
//
// `log` is defined at module-top-level too so that `dumpDataCyAttributes`
// (whose body is verbatim from the original orchestrator copies) has a
// `log` to call. The orchestrator IIFEs declare their own per-script
// `log` (with prefixes `[magnific-ext content]` / `[magnific-ext content-i2v]`)
// which shadows this one inside the IIFE — so orchestrator-emitted logs
// keep their per-script prefix. Only the shared-helper diagnostic dump
// uses the `[magnific-ext shared]` prefix.

function log(...args) {
  try { console.log('[magnific-ext shared]', ...args); } catch (_e) { /* ignore */ }
}

const DATA_CY_DUMP_CAP = 50;

// Set value on a textarea/input via the native prototype setter — React's
// controlled-input tracker only fires when the underlying setter is
// invoked directly. A plain `el.value = x` is silently dropped by React's
// change detection.
function setNativeValue(el, value) {
  const proto = Object.getPrototypeOf(el);
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
}

// Resolve a wrapper element down to the first editable descendant
// (textarea / input / contenteditable). If the root itself is editable,
// return it as-is. Magnific's [data-cy="image-prompt-input"] /
// [data-cy="video-prompt-input"] are wrappers around editable elements;
// walking inside them is essential.
function editableFrom(root) {
  if (!root) return null;
  if (
    root instanceof HTMLTextAreaElement ||
    root instanceof HTMLInputElement ||
    (root instanceof HTMLElement && root.isContentEditable)
  ) {
    return root;
  }
  return root.querySelector('textarea, input, [contenteditable="true"]');
}

async function waitFor(selector, timeoutMs = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const el = document.querySelector(selector);
    if (el) return el;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Snapshot the [data-cy] attributes present on the page so the operator
// can paste the dump back when reporting a selector break in a future
// Magnific UI revision. Cap at DATA_CY_DUMP_CAP so we don't flood the
// console on a page with hundreds of hooks (e.g. the model dialog open).
function dumpDataCyAttributes() {
  const els = document.querySelectorAll('[data-cy]');
  const attrs = [];
  for (const el of els) {
    const v = el.getAttribute('data-cy');
    if (v) attrs.push(v);
    if (attrs.length >= DATA_CY_DUMP_CAP) break;
  }
  log(`[data-cy] attributes present (capped at ${DATA_CY_DUMP_CAP}):`, attrs);
}

// Fill a Magnific prompt field. Returns true on success, false if no
// editable element is reachable (callers depend on this for poll loops).
// Handles both textarea/input (native setter + input/change events) and
// contenteditable (textContent + InputEvent).
//
// `wrapperDataCy` is the data-cy selector for the prompt wrapper (e.g.
// '[data-cy="image-prompt-input"]'). `extraCandidates` is an optional
// ordered list of placeholder/aria-label selectors tried after the
// wrapper-derived editable but before the generic `textarea` /
// `[contenteditable="true"]` tail. Image-gen passes the "Describe" /
// "prompt" placeholder hints; i2v passes those plus the "motion" hint.
function fillPrompt(text, wrapperDataCy, extraCandidates = []) {
  const wrapper = document.querySelector(wrapperDataCy);
  const candidates = [
    editableFrom(wrapper),
    ...extraCandidates.map((sel) => document.querySelector(sel)),
    document.querySelector('textarea'),
    document.querySelector('[contenteditable="true"]'),
  ];
  const el = candidates.find((e) => e instanceof HTMLElement);
  if (!el) return false;
  el.focus();
  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
    setNativeValue(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    el.textContent = text;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
  }
  return true;
}
