---
name: testing-browse-daemon
description: How to run and adversarially test the gstack browse daemon end-to-end (audit log, device salt, terminal-agent state files, cookie-import path checks). Use when verifying browse/src changes at runtime rather than via unit tests.
---

# Testing the browse daemon at runtime

## Setup

```bash
export PATH=$HOME/.bun/bin:$PATH        # bun is not on the default PATH
bun install && bun run build            # produces browse/dist/browse + dist/server-node.mjs
npx playwright install chromium         # headless-shell is required before any goto
B=browse/dist/browse
$B status                               # cold-starts the daemon (headless "launched" mode)
```

State lives in `<git root>/.gstack/` (`browse.json`, `browse-audit.jsonl`, …), overridable with
`BROWSE_STATE_FILE`. `browse cookie-import`/`validateReadPath` safe dirs are `/tmp` + the repo root
(`browse/src/path-security.ts`), so put fixtures there.

## Seeing daemon stderr (required for any warning/diagnostic test)

`cli.ts` spawns the server with `stdio: ['ignore','ignore','ignore']` — **all daemon stderr goes to
/dev/null**, so `warnOnce`/`console.warn` output is invisible in normal operation. Run the server
yourself instead and keep the CLI pointed at it via the same state file:

```bash
$B stop; pkill -f browse/src/server.ts
BROWSE_STATE_FILE=$PWD/.gstack/browse.json BROWSE_PARENT_PID=0 \
  nohup bun run browse/src/server.ts > /tmp/server.log 2>&1 &
sleep 7            # then normal `browse <cmd>` calls reuse this daemon
```
`warnOnce` dedupes per key **per process**, so restart the daemon between warning tests or the
second test sees zero lines.

## Failure injection that actually works

- **Unwritable file**: replace the target with a directory (`mkdir .gstack/browse-audit.jsonl`) →
  append/rename fails EISDIR. For atomic-rename writers the directory must be **non-empty**.
- **chmod on a state dir does NOT work**: `mkdirSecure()` (`browse/src/file-permissions.ts`) is
  called on every write and chmods the dir back to `0700`, silently undoing `chmod 500`.
- **Device salt**: `~/.gstack/security/device-salt`. Back it up, blank it, then run a *fresh
  process* — the salt is cached per process and the path is resolved at module load:
  `bun -e "const m=await import('./browse/src/security.ts'); console.log(m.hashPayload('x'))"`.
  Compare against the unsalted digest `sha256("" + payload)` to prove the salt was really applied.
  Note `hashPayload`/`logAttempt` currently have **no production call site**, so a module-level
  invocation is the only runtime path.
- **terminal-agent state files** (`tabs.json`, `active-tab.json`): the agent only writes them when
  the sidebar extension sends a `tabState` WS frame. Reproduce that wire path without Chrome:
  read `<stateDir>/terminal-port` + `terminal-internal-token`, `POST /internal/grant`
  `{token, sessionId}` with `Authorization: Bearer <internal token>`, then
  `new WebSocket('ws://127.0.0.1:<port>/ws', {protocols:['gstack-pty.<token>'], headers:{Origin:'chrome-extension://<32 chars>'}})`
  and send `{type:'tabState', tabs:[…], active:{tabId,url,title}}`. The `Origin` must start with
  `chrome-extension://` or the upgrade 403s. Agent liveness: `GET /internal/healthz` with the same
  bearer token. Start a standalone agent with
  `BROWSE_STATE_FILE=/tmp/x/.gstack/browse.json BROWSE_SERVER_PORT=1 bun run browse/src/terminal-agent.ts`.

## Gotchas

- `browse eval <file>` takes a **file**; use `browse js "<inline script>"` for inline JS.
- After `browse cookie-import`, JS execution is pinned to the imported cookie's domain — restart the
  daemon before unrelated `js`/`eval` tests.
- `viewport <WxH> --scale <n>` forces `recreateContext()` → `saveState()`/`restoreState()`, which is
  the only easy way to exercise storage capture/restore. Tab ids are renumbered after the rebuild.
- Pre-existing unrelated failures on this checkout: `browse/src/sidebar-agent.ts` is missing
  (sidebar tests cascade), `bun run skill:check` exits 1 (claude/SKILL.md not generated), one /tmp
  symlink test fails. Don't chase them.
- No GUI terminal ships on the Devin box; `sudo apt-get install -y xterm` works and
  `display <png>` (ImageMagick) is available for showing captured screenshots in a recording.

## Devin Secrets Needed

None for the free/runtime browse tests. `ANTHROPIC_API_KEY` only for `bun run test:evals`.
