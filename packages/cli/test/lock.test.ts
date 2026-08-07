import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LockedError, withLock } from '../src/lock';

/**
 * One writer at a time.
 *
 * §10 assumed a single writer; this makes it one. The interesting cases are
 * both failure directions: never stealing a stale lock means one crash locks
 * the workspace forever, and stealing too eagerly means two writers each
 * believing they are alone.
 */

let root: string;
const lockPath = () => join(root, '.nbe', 'lock');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nbe-lock-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Write a lock file as another process would have left it. */
function plant(pid: number, at: number) {
  mkdirSync(join(root, '.nbe'), { recursive: true });
  writeFileSync(lockPath(), JSON.stringify({ pid, at }), 'utf8');
}

/** A pid that certainly does not exist. */
const DEAD_PID = 0x7ffffffe;

describe('holding the lock', () => {
  it('runs the work and releases afterwards', async () => {
    const seen = await withLock(root, () => {
      expect(existsSync(lockPath())).toBe(true);
      return 'done';
    });
    expect(seen).toBe('done');
    expect(existsSync(lockPath())).toBe(false);
  });

  it('releases even when the work throws', async () => {
    await expect(withLock(root, () => Promise.reject(new Error('boum')))).rejects.toThrow('boum');
    expect(existsSync(lockPath())).toBe(false);
  });

  it('records who holds it', async () => {
    await withLock(root, () => {
      expect(JSON.parse(readFileSync(lockPath(), 'utf8')).pid).toBe(process.pid);
    });
  });
});

describe('refusing a workspace someone else is writing', () => {
  it('throws rather than racing, naming the process', async () => {
    plant(process.pid, Date.now()); // a live process: ourselves
    await expect(withLock(root, () => 'never')).rejects.toBeInstanceOf(LockedError);
  });

  it("leaves the other process's lock in place", async () => {
    plant(process.pid, Date.now());
    await withLock(root, () => 'never').catch(() => undefined);
    expect(JSON.parse(readFileSync(lockPath(), 'utf8')).pid).toBe(process.pid);
  });

  it('refuses a dead process whose heartbeat is still recent', async () => {
    // the pid is gone but it was alive a second ago: only one signal agrees,
    // and a pid can be recycled, so this must not be stolen
    plant(DEAD_PID, Date.now());
    await expect(withLock(root, () => 'never')).rejects.toBeInstanceOf(LockedError);
  });
});

describe('reclaiming a lock nobody holds', () => {
  it('takes over when the process is gone and the heartbeat stopped', async () => {
    plant(DEAD_PID, Date.now() - 60_000);
    // both signals agree: a crash left this behind
    expect(await withLock(root, () => 'taken')).toBe('taken');
  });

  it('takes over a truncated lock, which is a writer that died mid-write', async () => {
    mkdirSync(join(root, '.nbe'), { recursive: true });
    writeFileSync(lockPath(), '{"pid": 12', 'utf8');
    expect(await withLock(root, () => 'taken')).toBe('taken');
  });

  it('a crash does not lock the workspace forever', async () => {
    plant(DEAD_PID, Date.now() - 60_000);
    await withLock(root, () => 'first');
    expect(existsSync(lockPath())).toBe(false);
    expect(await withLock(root, () => 'second')).toBe('second');
  });
});

describe('two attempts in the same process', () => {
  it('the second waits for nothing and fails fast, rather than deadlocking', async () => {
    await withLock(root, async () => {
      await expect(withLock(root, () => 'inner')).rejects.toBeInstanceOf(LockedError);
    });
  });
});
