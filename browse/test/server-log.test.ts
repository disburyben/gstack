/**
 * The daemon's stderr must land in `.gstack/browse-server.log`.
 *
 * Before this, cli.ts spawned the server with stdio ['ignore','ignore','ignore'],
 * so every diagnostic the server emitted (including the warnOnce degradations
 * added for audit/salt/state-file failures) was discarded — a degraded daemon
 * was indistinguishable from a healthy one. These tests cover the log plumbing
 * plus a static tripwire on the spawn sites.
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  openServerLog,
  closeServerLog,
  rotateServerLog,
  serverLogEnabled,
  serverLogPath,
  MAX_SERVER_LOG_BYTES,
} from '../src/server-log';
import { resolveConfig } from '../src/config';
import { _resetWarnOnce } from '../src/error-handling';

const ROOT = path.resolve(import.meta.dir, '..', '..');

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-server-log-'));
  _resetWarnOnce();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.BROWSE_SERVER_LOG;
});

describe('server log path', () => {
  test('config exposes browse-server.log inside stateDir', () => {
    const config = resolveConfig({ BROWSE_STATE_FILE: path.join(dir, '.gstack', 'browse.json') });
    expect(config.serverLog).toBe(path.join(dir, '.gstack', 'browse-server.log'));
    expect(config.serverLog).toBe(serverLogPath(config.stateDir));
  });
});

describe('openServerLog', () => {
  test('returns an fd a detached child can write through', () => {
    const logPath = serverLogPath(dir);
    const fd = openServerLog(logPath);
    expect(fd).not.toBeNull();
    const res = spawnSync(process.execPath, ['-e', 'process.stderr.write("from the daemon\\n")'], {
      stdio: ['ignore', fd!, fd!],
    });
    closeServerLog(fd);
    expect(res.status).toBe(0);
    expect(fs.readFileSync(logPath, 'utf-8')).toContain('from the daemon');
  });

  test('appends instead of truncating across spawns', () => {
    const logPath = serverLogPath(dir);
    fs.writeFileSync(logPath, 'earlier run\n');
    const fd = openServerLog(logPath);
    fs.writeSync(fd!, 'later run\n');
    closeServerLog(fd);
    const body = fs.readFileSync(logPath, 'utf-8');
    expect(body).toContain('earlier run');
    expect(body).toContain('later run');
  });

  test('creates a missing state directory', () => {
    const logPath = serverLogPath(path.join(dir, 'nested', '.gstack'));
    const fd = openServerLog(logPath);
    closeServerLog(fd);
    expect(fs.existsSync(logPath)).toBe(true);
  });

  test('BROWSE_SERVER_LOG=0 opts out (caller falls back to /dev/null)', () => {
    process.env.BROWSE_SERVER_LOG = '0';
    expect(serverLogEnabled()).toBe(false);
    expect(openServerLog(serverLogPath(dir))).toBeNull();
    expect(fs.existsSync(serverLogPath(dir))).toBe(false);
  });

  test('returns null instead of throwing when the log cannot be opened', () => {
    // A directory at the log path: open(…, 'a') fails EISDIR. The spawn must
    // still happen, just without capture.
    const logPath = serverLogPath(dir);
    fs.mkdirSync(logPath);
    expect(openServerLog(logPath)).toBeNull();
  });
});

describe('rotateServerLog', () => {
  test('moves an oversized log to .1 and starts fresh', () => {
    const logPath = serverLogPath(dir);
    fs.writeFileSync(logPath, 'x'.repeat(64));
    rotateServerLog(logPath, 32);
    expect(fs.existsSync(logPath)).toBe(false);
    expect(fs.readFileSync(`${logPath}.1`, 'utf-8')).toHaveLength(64);

    const fd = openServerLog(logPath);
    fs.writeSync(fd!, 'new generation\n');
    closeServerLog(fd);
    expect(fs.readFileSync(logPath, 'utf-8')).toBe('new generation\n');
  });

  test('leaves a small log in place and tolerates a missing one', () => {
    const logPath = serverLogPath(dir);
    fs.writeFileSync(logPath, 'small\n');
    rotateServerLog(logPath, MAX_SERVER_LOG_BYTES);
    expect(fs.readFileSync(logPath, 'utf-8')).toBe('small\n');
    expect(() => rotateServerLog(path.join(dir, 'absent.log'))).not.toThrow();
  });
});

describe('spawn sites keep capturing daemon output', () => {
  test('cli.ts and terminal-agent-control.ts route child stdio at the log fd', () => {
    for (const rel of ['browse/src/cli.ts', 'browse/src/terminal-agent-control.ts']) {
      const body = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
      expect(body).toContain('openServerLog');
      // ['ignore','ignore','ignore'] here would silently discard diagnostics again.
      expect(body).toMatch(/stdio: \['ignore', logFd \?\? 'ignore', logFd \?\? 'ignore'\]/);
    }
  });

  test("the Windows launcher opens the log in the child process", () => {
    const body = fs.readFileSync(path.join(ROOT, 'browse', 'src', 'cli.ts'), 'utf-8');
    // Parent fds are meaningless to the separate `node -e` launcher, so the
    // launcher must open the path itself.
    expect(body).toMatch(/stdio:\['ignore',out,out\]/);
    expect(body).toContain('fs.openSync(p');
  });
});
