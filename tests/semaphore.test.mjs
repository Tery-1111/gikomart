import { describe, it, expect } from 'vitest';
import { createSemaphore } from '../src/utils/semaphore.js';

describe('createSemaphore', () => {
  it('allows maxConcurrent acquires without blocking', async () => {
    const sem = createSemaphore(3, 10);
    const releases = await Promise.all([sem.acquire(), sem.acquire(), sem.acquire()]);
    expect(releases.every((release) => typeof release === 'function')).toBe(true);
  });

  it('blocks a queued acquire until a slot is released', async () => {
    const sem = createSemaphore(3, 10);
    const held = [await sem.acquire(), await sem.acquire(), await sem.acquire()];

    let granted = false;
    const fourth = sem.acquire().then((release) => {
      granted = true;
      return release;
    });
    await Promise.resolve(); // let a queued resolve run if it wrongly fired
    expect(granted).toBe(false);

    held[0](); // free one slot — the waiter is handed it
    const release4 = await fourth;
    expect(granted).toBe(true);
    expect(typeof release4).toBe('function');
  });

  it('throws UPLOAD_BUSY on the acquire past maxConcurrent + maxQueued', async () => {
    const sem = createSemaphore(3, 10);
    const held = [await sem.acquire(), await sem.acquire(), await sem.acquire()];
    const queued = [];
    for (let i = 0; i < 10; i += 1) queued.push(sem.acquire()); // fill the wait list

    let err;
    try {
      sem.acquire(); // 14th: 3 active + 10 queued are already taken
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.code).toBe('UPLOAD_BUSY');
    expect(held).toHaveLength(3);
    expect(queued).toHaveLength(10);
  });

  it('does not consume a queue slot with a rejected acquire', async () => {
    const sem = createSemaphore(2, 1);
    const r1 = await sem.acquire();
    const r2 = await sem.acquire();
    const first = sem.acquire(); // queued (wait list now full)
    expect(() => sem.acquire()).toThrow(/busy/i);

    r1(); // hand the freed slot to `first`; wait list is empty again
    const releaseFirst = await first;

    // If the rejected acquire had consumed the only queue slot, this next one
    // would throw too. It must instead queue cleanly.
    const second = sem.acquire();
    expect(() => sem.acquire()).toThrow(/busy/i); // exactly `second` is queued

    r2();
    const releaseSecond = await second;
    expect(typeof releaseSecond).toBe('function');
    releaseFirst();
    releaseSecond();
  });

  it('reuses a released slot', async () => {
    const sem = createSemaphore(1, 0);
    const release = await sem.acquire();
    expect(() => sem.acquire()).toThrow(/busy/i); // no queue room, so it rejects

    release();
    const release2 = await sem.acquire(); // the slot is available again
    expect(typeof release2).toBe('function');
    release2();
  });
});
