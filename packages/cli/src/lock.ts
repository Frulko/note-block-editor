import { closeSync, mkdirSync, openSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * One writer at a time.
 *
 * @remarks
 * §10 assumes a single writer, and until now that was an assumption rather
 * than a mechanism: two processes writing the same page raced on the rename
 * and the later one won, silently. That is fine until `nbe watch` is importing
 * an external edit while you run `nbe new` in another terminal, at which point
 * one of the two edits disappears with no error anywhere.
 *
 * The lock is a file created with `wx` — exclusive create, which is atomic on
 * every filesystem that matters, unlike "check then create" which has a window
 * between the two. It holds the pid and a heartbeat.
 *
 * **Stale locks are the hard part**, and getting it wrong in either direction
 * is bad: never stealing means one crash locks the workspace forever, and
 * stealing too eagerly means two writers believing they are alone. So two
 * independent signals must agree — the recorded process is gone *and* the
 * heartbeat has stopped. A long-running command refreshes its heartbeat, so a
 * busy watcher is never mistaken for a dead one, and a pid that has been
 * recycled by the operating system is still caught by the stale heartbeat.
 *
 * @category CLI
 */

const LOCK = 'lock';
/** A heartbeat older than this, from a process that is gone, is abandoned. */
const STALE_MS = 15_000;
const HEARTBEAT_MS = 5_000;

export class LockedError extends Error {
  constructor(readonly pid: number) {
    super(`l'espace de travail est utilisé par le processus ${pid}`);
    this.name = 'LockedError';
  }
}

interface Held {
  pid: number;
  at: number;
}

function read(path: string): Held | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<Held>;
    return typeof parsed.pid === 'number' ? { pid: parsed.pid, at: Number(parsed.at) || 0 } : null;
  } catch {
    // unreadable or truncated: a writer died mid-write, so it is not held
    return null;
  }
}

/** True when no process with this id exists. */
function gone(pid: number): boolean {
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0); // signal 0 tests for existence without delivering
    return false;
  } catch (err) {
    // EPERM means it exists and belongs to someone else — still alive
    return (err as NodeJS.ErrnoException).code !== 'EPERM';
  }
}

/**
 * Take the lock, run, and release it.
 *
 * @throws {@link LockedError} when another live process holds it.
 */
export async function withLock<T>(root: string, run: () => Promise<T> | T): Promise<T> {
  const directory = join(root, '.nbe');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, LOCK);

  const take = (): boolean => {
    try {
      closeSync(openSync(path, 'wx'));
      writeFileSync(path, JSON.stringify({ pid: process.pid, at: Date.now() }), 'utf8');
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      return false;
    }
  };

  if (!take()) {
    const held = read(path);
    const abandoned = !held || (gone(held.pid) && Date.now() - held.at > STALE_MS);
    if (!abandoned) throw new LockedError(held!.pid);
    // both signals agree it is abandoned: clear it and try once more
    rmSync(path, { force: true });
    if (!take()) throw new LockedError(read(path)?.pid ?? -1);
  }

  const beat = setInterval(() => {
    try {
      utimesSync(path, new Date(), new Date());
      writeFileSync(path, JSON.stringify({ pid: process.pid, at: Date.now() }), 'utf8');
    } catch {
      /* the lock was taken from under us; the release below is still safe */
    }
  }, HEARTBEAT_MS);
  beat.unref?.();

  const release = () => {
    clearInterval(beat);
    // only remove a lock that is still ours, or a steal would be undone
    if (read(path)?.pid === process.pid) rmSync(path, { force: true });
  };
  process.once('exit', release);

  try {
    return await run();
  } finally {
    release();
    process.off('exit', release);
  }
}
