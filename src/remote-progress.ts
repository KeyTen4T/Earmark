// The freshness rule for progress records arriving from sync. Pure, so the Node test runner can
// exercise it directly (test/remote-progress.test.ts).

/** The only thing the comparison needs from a progress record. */
type Stamped = { updated: number };

/**
 * Whether an incoming sync record should overwrite the one stored now. The player keeps saving
 * progress while a sync request is in flight, so by the time the remote records are applied the
 * local record for that book can already be newer; in that case the incoming record is skipped.
 * Equal stamps are applied, matching the merge's deterministic tie-break.
 */
export function shouldApplyRemoteProgress(local: Stamped | undefined, incoming: Stamped): boolean {
  return !local || local.updated <= incoming.updated;
}
