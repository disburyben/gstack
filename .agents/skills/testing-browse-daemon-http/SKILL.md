---
name: testing-browse-daemon-http
description: How to boot the browse daemon locally and test its HTTP surface (bearer auth, /file serving, /command dispatch) with curl. Use when verifying changes to browse/src/server.ts, path-security.ts, auth tokens, or /file response headers.
---

# Testing the browse daemon over HTTP

The `browse` daemon (Bun + Playwright) is not a web UI — verify server changes with
request/response transcripts against a locally booted daemon.

## Boot a daemon with a known token

```bash
export PATH="$HOME/.bun/bin:$PATH"        # bun is usually NOT on the default PATH
bun install                                # do this even if deps "are installed" — see gotcha below
bunx playwright install chromium chromium-headless-shell   # daemon exits at boot without a browser
AUTH_TOKEN=abcdefghijklmnopqrstuvwxyz012345 BROWSE_PORT=29321 BROWSE_PARENT_PID=0 \
  bun run browse/src/server.ts
```

- **`AUTH_TOKEN` must be >= 16 chars after unicode-whitespace stripping**
  (`sanitizeAuthToken` in `browse/src/server.ts`). A shorter value is silently
  ignored and the daemon falls back to a random UUID — you will then get 401 on
  every request with the token you think you set. Always confirm the effective
  token: `cat .gstack/browse.json` (fields: `pid`, `port`, `token`).
- `BROWSE_PARENT_PID=0` disables the parent-process watchdog so the daemon
  survives your shell.
- Boot takes ~10-15s (Chromium launch) before routes answer.
- The daemon binds 127.0.0.1 only.

## Route cheat sheet

| Route | Auth |
|---|---|
| `GET /health` | none (returns `status`, `mode`, `tabs`) |
| `GET /refs`, `GET /memory`, `GET /activity/history` | root bearer token |
| `GET /file?path=<abs>` | root or scoped token; path must resolve inside TEMP_DIR (`/tmp` on Linux/macOS), else 403 |
| `POST /pty-dispose` | root token via `Authorization: Bearer` **or** JSON body `{"authToken": "..."}` |
| `POST /command` `{"command":"goto","args":[...]}` | root or scoped token — the way to drive browse commands (`goto`, `snapshot`, `diff`) without the CLI |

Driving browse commands through `/command` is the cheapest way to exercise
command-layer code (e.g. `Diff.diffLines` in `browse/src/snapshot.ts` via
`{"command":"snapshot","args":["-D"]}`, or `{"command":"diff","args":[url1,url2]}`).
`file:///tmp/*.html` fixtures work fine as navigation targets.

## Adversarial bearer-token cases worth covering

When auth comparison changes (e.g. `===` → `crypto.timingSafeEqual`), the
interesting risk is a **throw turning a 401 into a 500**. `crypto.timingSafeEqual`
throws on mismatched buffer lengths, so always include a token whose JS string
length matches the real token but whose UTF-8 byte length does not:

```bash
MULTI="abcdefghijklmnopqrstuvwxyz01234é"   # 32 chars, 33 UTF-8 bytes
```

Full set: no header; header without the `Bearer ` prefix; wrong token of the same
byte length; wrong token of a different length; empty bearer; the multibyte token.
Each must be exactly `401` with `{"error":"Unauthorized"}`. Also assert the daemon
log has no `RangeError` / `FATAL` / `unhandled` lines afterwards and still answers
200 on a valid request — a swallowed throw can otherwise look like a pass.

## Gotchas

- **`bun install` may not reflect the branch's `package.json`.** A dependency bump
  in the diff (e.g. `diff` 7 → 8) is NOT present until you re-run `bun install`;
  verify the real installed version
  (`node -e "console.log(require('./node_modules/<pkg>/package.json').version)"`)
  before claiming a dependency change was exercised.
- **Do not `pkill -f "browse/src/server.ts"` from the shell tool** — the pattern
  matches the shell's own command line and kills your session. Run the daemon in a
  dedicated background shell and kill that shell instead.
- **The free test suite is noisy and location-sensitive.** Failures differ between
  a checkout at the repo path and a worktree under a different path (many tests are
  cwd/`/tmp`-sensitive), and sidebar/chat/queue/sidepanel tests are flaky. To
  compare a branch against its base, check both commits out **in the same
  directory** (`git checkout --detach <sha>` inside one throwaway worktree) and
  diff the sorted `(fail)` test names rather than trusting fail counts.
- **Avoid `/tmp/gstack-*` for scratch worktrees** — the suite creates and deletes
  paths matching that prefix and will delete your worktree mid-run.
- Overall suite exit code is `0` even with ~90-106 `(fail)` lines on a dev box;
  exit code alone proves nothing.

## Devin Secrets Needed

None for the daemon HTTP surface. `supabase/functions/**` changes need Supabase
project credentials (service-role / anon keys) and cannot be verified locally
without them.
