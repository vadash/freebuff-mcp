# freebuff.exe base URL: structure and patch findings

Results of unpacking and patching the installed CLI
(`C:\Users\vadash\.config\manicode\freebuff.exe`). The exe was restored to its
original bytes after the experiment; this file records what was found and the
working procedure.

## Binary facts

| Fact | Value |
|---|---|
| File | `C:\Users\vadash\.config\manicode\freebuff.exe` |
| Format | Bun standalone executable (`\n---- Bun! ----\n` trailer at offset 122105913) |
| Size | 122,121,984 bytes |
| SHA-256 (original) | `ed74b4827eba3f89584d064cff032d06f26eacbc0598e12ee3283421b5176577` |
| Embedded bundle | App code is stored uncompressed in the overlay (~98.4 MB onward); some embedded files are separate zstd frames (107–110 MB region) |

## How the CLI resolves its server URL

All names below are minified bundle symbols.

1. A zod schema `r0H` validates a config object; defaults `ozH` hardcode:
   - `NEXT_PUBLIC_CODEBUFF_APP_URL: "https://www.codebuff.com"` — the API/agent
     transport base.
   - `NEXT_PUBLIC_FREEBUFF_APP_URL: "https://freebuff.com"` — the login page
     base (`https://freebuff.com/login?auth_code=…`).
2. The parsed config `CE = r0H.safeParse(ozH).data` is a module-level constant.
   Only the ad-pixel IDs read `process.env`; the two URLs do not.
3. An env override exists: `CODEBUFF_APP_URL` / `NEXT_PUBLIC_CODEBUFF_APP_URL`
   (checked in that order by `YDA()`), gated by:
   - scheme: `https`, or `http` only for localhost (`R6H`);
   - host allowlist `gK$ = ["codebuff.com", "freebuff.com"]` (plus localhost);
   - escape hatch: `CODEBUFF_ALLOW_CUSTOM_APP_URL` in `{1, true, yes}` accepts
     any https host (prints a one-time warning per URL).
4. The override is incomplete. `w9()` (used for telemetry gating) honors it, but
   the main transport reads `CE` raw:
   - `pi$()` = `(CE.NEXT_PUBLIC_CODEBUFF_APP_URL || "https://codebuff.com")`
     with trailing `/` stripped;
   - `iYA(method)` = `${pi$()}${method === "POST" ? NIA : "/api/v1/freebuff/session"}`;
   - auth/usage posts `${CE.NEXT_PUBLIC_CODEBUFF_APP_URL}/api/v1/usage`.
   Env vars therefore do **not** fully retarget the CLI; a binary patch does.
5. Login is a separate string. The login URL is built from
   `NEXT_PUBLIC_FREEBUFF_APP_URL`, not from the API base. Telemetry goes to
   `us.i.posthog.com`. No TLS certificate pinning was found.

## Patch procedure (same-length in-place)

- Target: the single occurrence of `"https://www.codebuff.com"` (24 bytes,
  exactly once in the whole file — verified).
- Constraint: replacement must be **exactly 24 bytes**. `https://` is 8, so the
  hostname must be **16 characters** — a 5-char first label under a 10-char
  zone (e.g. `fb123.100169.xyz` → `https://fb123.100169.xyz`). A 14-char host
  cannot be padded: an explicit port adds at least 4 (`:443`), an FQDN trailing
  dot adds 1 (23 ≠ 24). Names longer than 16 chars need a shorter alias
  (Cloudflare Worker custom domain), not a longer string.
- Same length ⇒ every Bun overlay offset stays valid; no trailer or index edits.
- Edit in place with any byte-level tool; then verify: size unchanged, old
  string absent, new string present exactly once.
- What needs no patch: only the API base. Login (`freebuff.com`) and telemetry
  (`posthog.com`) were left untouched on purpose.

## Verification that worked

With the patched exe, run the CLI with `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY`
pointing at a local socket listener. Bun's `fetch` honors the proxy env vars and
sends plaintext `CONNECT` lines, which name the dial target:

```
CONNECT fb123.100169.xyz:443   ← agent transport, repeated (retry loop)
CONNECT freebuff.com:443       ← login flow, once (unchanged)
CONNECT us.i.posthog.com:443   ← telemetry (unchanged)
```

The TUI boots and renders normally on the patched exe; the retry loop is the
expected behavior while the target host has no DNS.

## Why a redirect is not enough

The CLI appends its own API paths and uses POST plus streaming responses. A
301/302 from e.g. a Cloudflare Redirect Rule breaks it: `fetch` converts POST to
GET on 301/302, strips `Authorization` on cross-origin redirects, and SSE/stream
endpoints do not survive. The short domain must **reverse-proxy** the real
backend (a Cloudflare Worker with a Custom Domain), preserving method, headers,
body, and streaming; WebSocket upgrades pass through `fetch` in Workers.

## Restore

Write the saved original bytes back over the exe (keep a copy before patching)
and confirm SHA-256 equals `ed74b482…5176577`. The CLI is a self-contained
Bun standalone; no other file references the patched bytes.
