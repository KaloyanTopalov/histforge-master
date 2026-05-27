# magnific-ext extension key rotation

The `manifest.json` field `"key"` is the base64-encoded **public** half of an
RSA-2048 keypair. Chrome uses it to derive the extension's load-time ID
deterministically — same key → same ID, every operator, every machine. The
HistForge-managed Playwright runtime relies on that ID to navigate to a
bridge page at `chrome-extension://<id>/blank.html` and inject the Magnific
token into the extension's `chrome.storage.local` from a page running on
the extension's own origin (the only Chrome context that has `chrome.*`
APIs in V3 outside the service worker).

This file documents the generation procedure, the resulting extension ID,
and what to do if the key ever needs rotating.

## Current extension ID

`blkhajpjohgopchihlaeeagamopdpfmd`

Computed from the public key in `extensions/magnific-ext/manifest.json` via
SHA-256 of the DER-encoded key, first 32 hex chars, with each hex digit
remapped `0..f` → `a..p`.

## Generation procedure

The keypair is generated on a developer machine, never committed to the
repo, and the private half is discarded once the public half is captured.

```bash
openssl genrsa 2048 2>/dev/null \
  | openssl rsa -pubout -outform DER 2>/dev/null \
  | openssl base64 -A
```

- `openssl genrsa 2048` — generates an RSA-2048 keypair to stdout.
- `openssl rsa -pubout -outform DER` — reads the keypair from stdin,
  extracts the public half in DER form.
- `openssl base64 -A` — single-line base64 encode, ready for JSON.

Pipe-only: the private key exists only in the openssl process buffers and
is freed when the pipeline ends. No `.pem` file lands on disk.

If a developer chooses to write the private key to disk for any reason
(e.g., signing CRX packages outside the dev flow), the `.gitignore` carries
a defense-in-depth entry for `extensions/**/*.private.pem`. Do not commit
private key material.

## Computing the extension ID

```bash
node -e "
const k = '<paste base64 from manifest>';
const c = require('crypto');
const h = c.createHash('sha256').update(Buffer.from(k, 'base64')).digest('hex');
const id = h.slice(0,32).split('').map(ch =>
  String.fromCharCode(parseInt(ch,16) + 'a'.charCodeAt(0))
).join('');
console.log(id);
"
```

Output is a 32-char `a..p` string — the Chrome extension ID.

## When to rotate

The key only needs rotating if it leaks publicly (extremely unlikely — the
public half is intended to be visible) **or** if the extension ID needs to
change for an unrelated reason. There is no scheduled rotation.

To rotate:

1. Re-run the generation command above to produce a new base64 public key.
2. Replace the `"key"` value in `extensions/magnific-ext/manifest.json`.
3. Compute the new extension ID and update the "Current extension ID"
   section above.
4. Update any tests that pin the ID. As of S1 there are none — the runtime
   module derives the ID from the manifest at runtime.
5. Distribute the updated extension to operators. Chrome will treat the
   re-keyed extension as a new ID, so any operator with prior data in the
   old extension's storage will need to repeat the `Connect Magnific` flow.

## Why deterministic IDs

The runtime's bridge-page strategy (Decision 1 in the runtime spec) writes
the magnific token into `chrome.storage.local` by navigating to a page
served by the extension itself. The URL is
`chrome-extension://<id>/blank.html`, which requires knowing `<id>` ahead
of time. Without the manifest `"key"`, Chrome computes the ID from the
absolute install path — which varies per operator machine and per `npm
install` location — and the runtime would have to discover the ID at
boot time. With the key, the ID is fixed and the runtime can construct
the URL without round-tripping through `context.serviceWorkers()`.
