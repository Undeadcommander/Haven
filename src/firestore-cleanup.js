import { collection, doc, query, where, limit, getDocFromServer,
  getDocsFromServer, runTransaction } from "firebase/firestore";
import { isDeletingRecord } from "./delete-account-data.js";

// Discover obsolete snapshots again on every attempt, including files left by
// a previous browser session. Small transactions stay below Firestore's request
// size limit even when deleted chunks have their maximum payload size.
export async function removeObsoleteSnapshots(db, uid, assertOwner) {
  const reference = doc(db, "users", uid);
  for (;;) {
    assertOwner();
    const head = (await getDocFromServer(reference)).data();
    if (!head || isDeletingRecord(head)) return;
    const keep = [...new Set([head.snapshotId, head.previous?.snapshotId].filter(Boolean))];
    if (!keep.length) return;
    const candidates = (await getDocsFromServer(query(
      collection(db, "users", uid, "chunks"),
      where("snapshotId", "not-in", keep), limit(8),
    ))).docs;
    if (!candidates.length) return;
    const removed = await runTransaction(db, async (tx) => {
      assertOwner();
      const current = (await tx.get(reference)).data();
      if (!current || isDeletingRecord(current)) return 0;
      let count = 0;
      for (const chunk of candidates) {
        const snapshotId = chunk.data().snapshotId;
        // A publish between the query and transaction may have created one of
        // these candidates. Never delete the current or previous snapshot.
        if (snapshotId === current.snapshotId || snapshotId === current.previous?.snapshotId) continue;
        tx.delete(chunk.ref);
        count++;
      }
      return count;
    });
    if (!removed) return;
  }
}

export function createCleanupScheduler({ cleanup, isActive, setTimer = setTimeout,
  clearTimer = clearTimeout }) {
  const jobs = new Map();
  function schedule(uid) {
    if (!isActive(uid)) return;
    if (jobs.has(uid)) { jobs.get(uid).again = true; return; }
    const job = { timer: null, again: false };
    jobs.set(uid, job);
    const attempt = async (delay = 30_000) => {
      if (jobs.get(uid) !== job) return;
      if (!isActive(uid)) { jobs.delete(uid); return; }
      try {
        await cleanup(uid);
        if (jobs.get(uid) === job) {
          if (job.again) { job.again = false; void attempt(); }
          else jobs.delete(uid);
        }
      } catch {
        if (jobs.get(uid) !== job) return;
        if (!isActive(uid)) { jobs.delete(uid); return; }
        job.timer = setTimer(() => attempt(Math.min(delay * 2, 300_000)), delay);
      }
    };
    void attempt();
  }
  function cancelExcept(uid) {
    for (const [owner, job] of jobs) {
      if (owner === uid) continue;
      clearTimer(job.timer);
      jobs.delete(owner);
    }
  }
  return { schedule, cancelExcept };
}
