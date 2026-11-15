import test from "node:test";
import assert from "node:assert/strict";
import { createCleanupScheduler } from "../src/firestore-cleanup.js";
const settle = () => new Promise(setImmediate);

test("cleanup retries failures with backoff and can run again after success", async () => {
  const timers = [];
  let calls = 0;
  const queue = createCleanupScheduler({
    cleanup: async () => { if (++calls < 3) throw Error("Denied temporarily"); },
    isActive: () => true,
    setTimer: (callback, delay) => { timers.push({ callback, delay }); return timers.length; },
  });
  queue.schedule("alice");
  await settle();
  assert.equal(calls, 1);
  assert.equal(timers[0].delay, 30_000);
  await timers[0].callback();
  assert.equal(timers[1].delay, 60_000);
  await timers[1].callback();
  assert.equal(calls, 3);
  queue.schedule("alice");
  await settle();
  assert.equal(calls, 4);
});

test("account switches cancel cleanup retries and a publish during cleanup triggers another sweep", async () => {
  let active = "alice", finish, calls = 0;
  const queue = createCleanupScheduler({
    isActive: (uid) => uid === active,
    cleanup: async () => { calls++; if (calls === 1) await new Promise((resolve) => { finish = resolve; }); },
  });
  queue.schedule("alice");
  queue.schedule("alice");
  assert.equal(calls, 1);
  finish();
  await settle();
  assert.equal(calls, 2);
  active = "bob";
  queue.cancelExcept(active);
  queue.schedule("alice");
  assert.equal(calls, 2);
});

test("retry timers cannot revive work after sign-out", async () => {
  let active = true, retry, cancelled = false, calls = 0;
  const queue = createCleanupScheduler({
    cleanup: async () => { calls++; throw Error("Offline"); },
    isActive: () => active,
    setTimer: (callback) => { retry = callback; return 1; },
    clearTimer: () => { cancelled = true; },
  });
  queue.schedule("alice");
  await settle();
  active = false;
  queue.cancelExcept(null);
  await retry();
  assert.equal(cancelled, true);
  assert.equal(calls, 1);
});
