/**
 * Capture the detached server/terminal-agent stdout+stderr into
 * `<stateDir>/browse-server.log`.
 *
 * Both are spawned with `stdio: ['ignore','ignore','ignore']` so they survive
 * the CLI's exit (see the setsid rationale in cli.ts). The side effect was that
 * every diagnostic they emit — `warnOnce` degradations, Playwright launch
 * noise, unhandled rejections — went to /dev/null, so the only way to see a
 * failing daemon was to re-run the server in the foreground by hand. Handing
 * the child an append-mode fd on the log keeps it detached while making that
 * output readable after the fact.
 *
 * Set BROWSE_SERVER_LOG=0 to opt out (back to /dev/null).
 */

import * as fs from 'fs';
import * as path from 'path';
import { warnOnce } from './error-handling';

/** Rotate once past this size, so an error loop can't fill the disk. */
export const MAX_SERVER_LOG_BYTES = 5 * 1024 * 1024;

export function serverLogPath(stateDir: string): string {
  return path.join(stateDir, 'browse-server.log');
}

export function serverLogEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.BROWSE_SERVER_LOG !== '0';
}

/**
 * Move the log aside when it exceeds MAX_SERVER_LOG_BYTES, keeping a single
 * `.1` generation. Best-effort: a rotation failure must not stop the spawn.
 */
export function rotateServerLog(logPath: string, maxBytes: number = MAX_SERVER_LOG_BYTES): void {
  try {
    if (fs.statSync(logPath).size < maxBytes) return;
    fs.renameSync(logPath, `${logPath}.1`);
  } catch (err: any) {
    if (err?.code === 'ENOENT') return;
    warnOnce('server-log-rotate', `[browse] cannot rotate ${logPath}`, err);
  }
}

/**
 * Open the server log for a detached child's stdout+stderr, rotating first.
 * Returns a file descriptor the caller passes to spawn and closes afterwards
 * (the child keeps its own inherited copy), or null when logging is disabled
 * or the log can't be opened — callers then fall back to 'ignore'.
 */
export function openServerLog(logPath: string): number | null {
  if (!serverLogEnabled()) return null;
  rotateServerLog(logPath);
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    return fs.openSync(logPath, 'a', 0o600);
  } catch (err) {
    warnOnce(
      'server-log-open',
      `[browse] cannot open ${logPath}; daemon diagnostics will be discarded`,
      err,
    );
    return null;
  }
}

/** Release the parent's copy of the fd after the child inherited it. */
export function closeServerLog(fd: number | null): void {
  if (fd === null) return;
  try {
    fs.closeSync(fd);
  } catch {
    // Already closed / never valid — nothing depends on this succeeding.
  }
}
