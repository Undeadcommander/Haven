import test from "node:test";
import assert from "node:assert/strict";
import { captureDepth } from "../src/capture-depth.js";

const flush = () => new Promise(setImmediate);
function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function setup(context, { pendingSession, compatible, reference } = {}) {
  const finish = { onclick: null, disabled: false }, cancel = { onclick: null };
  const overlay = { querySelector: (selector) => selector.includes("finish") ? finish : cancel };
  const calls = { sessions: 0, contexts: 0, losses: 0, frames: 0, references: 0, ends: 0 };
  const graphics = {
    makeXRCompatible: () => compatible?.promise || Promise.resolve(),
    getExtension: () => ({ loseContext() { calls.losses++; } }),
  };
  class Session extends EventTarget {
    renderState = {};
    updateRenderState(state) { this.renderState = state; }
    requestReferenceSpace() { calls.references++; return reference?.promise || Promise.resolve({}); }
    requestAnimationFrame() { calls.frames++; }
    async end() { calls.ends++; this.dispatchEvent(new Event("end")); }
  }
  const session = new Session();
  const globals = {
    navigator: { xr: { requestSession() { calls.sessions++; return pendingSession?.promise || Promise.resolve(session); } } },
    document: { createElement: () => ({ getContext() { calls.contexts++; return graphics; } }) },
    XRWebGLLayer: class { framebuffer = {}; },
  };
  for (const [name, value] of Object.entries(globals)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true });
    context.after(() => {
      if (original) Object.defineProperty(globalThis, name, original);
      else delete globalThis[name];
    });
  }
  return { overlay, finish, cancel, session, calls };
}

test("cancel settles immediately during session permission and closes a late session", { timeout: 2000 }, async (context) => {
  const pendingSession = deferred();
  const { overlay, finish, cancel, session, calls } = setup(context, { pendingSession });
  const result = captureDepth(overlay, () => {});
  assert.equal(finish.disabled, true);
  cancel.onclick();
  assert.equal(await result, null);
  pendingSession.resolve(session);
  await flush();
  assert.equal(calls.ends, 1);
  assert.equal(calls.contexts, 0);
  assert.equal(cancel.onclick, null);
});

for (const phase of ["compatible", "reference"]) {
  test("cancel during pending " + phase + " releases graphics and never starts frames", { timeout: 2000 }, async (context) => {
    const pending = deferred();
    const { overlay, finish, cancel, calls } = setup(context, { [phase]: pending });
    const result = captureDepth(overlay, () => {});
    await flush();
    assert.equal(finish.disabled, true);
    cancel.onclick();
    assert.equal(await result, null);
    pending.resolve({});
    await flush();
    assert.equal(calls.ends, 1);
    assert.equal(calls.losses, 1);
    assert.equal(calls.frames, 0);
  });
}

test("viewer abort during permission closes a late session without capture", { timeout: 2000 }, async (context) => {
  const pendingSession = deferred(), controller = new AbortController();
  const { overlay, session, calls } = setup(context, { pendingSession });
  const result = captureDepth(overlay, () => {}, { signal: controller.signal });
  controller.abort();
  assert.equal(await result, null);
  pendingSession.resolve(session);
  await flush();
  assert.equal(calls.ends, 1);
  assert.equal(calls.frames, 0);
});

test("an already aborted capture never requests camera access", async (context) => {
  const controller = new AbortController();
  controller.abort();
  const { overlay, calls } = setup(context);
  assert.equal(await captureDepth(overlay, () => {}, { signal: controller.signal }), null);
  assert.equal(calls.sessions, 0);
});

test("session loss during startup settles and releases its context", { timeout: 2000 }, async (context) => {
  const reference = deferred();
  const { overlay, session, calls } = setup(context, { reference });
  const result = captureDepth(overlay, () => {});
  const rejection = assert.rejects(result, /Not enough depth data/);
  await flush();
  session.dispatchEvent(new Event("end"));
  await rejection;
  reference.resolve({});
  await flush();
  assert.equal(calls.frames, 0);
  assert.equal(calls.losses, 1);
});

test("failed session shutdown rejects instead of leaving capture pending", { timeout: 2000 }, async (context) => {
  const { overlay, finish, session, calls } = setup(context);
  session.end = async () => { throw new DOMException("Interrupted", "InvalidStateError"); };
  const result = captureDepth(overlay, () => {});
  const rejection = assert.rejects(result, /Keep the browser in the foreground/);
  await flush();
  assert.equal(finish.disabled, false);
  finish.onclick();
  await rejection;
  assert.equal(calls.losses, 1);
});

test("permission rejection arriving after cancellation stays cancelled", { timeout: 2000 }, async (context) => {
  const pendingSession = deferred();
  const { overlay, cancel, calls } = setup(context, { pendingSession });
  const result = captureDepth(overlay, () => {});
  cancel.onclick();
  assert.equal(await result, null);
  pendingSession.reject(new DOMException("Denied", "NotAllowedError"));
  await flush();
  assert.equal(calls.contexts, 0);
});
