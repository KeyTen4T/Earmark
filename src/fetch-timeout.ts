// One fetch timeout that cannot be lost: an AbortController plus a timer, with the caller's own
// signal composed in. Pure (no react-native/expo imports), so the Node test runner can exercise it.
//
// Hermes may lack AbortSignal.any / AbortSignal.timeout, so the two signals are wired by hand. A
// timeout is reported as a `TimeoutError`, which is distinguishable from a caller's own abort.

export class TimeoutError extends Error {
  constructor(message = 'Request timed out') {
    super(message);
    this.name = 'TimeoutError';
  }
}

/** The shape every caller here passes: a plain fetch over a string URL. */
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function fetchWithTimeout(
  input: string,
  init: RequestInit = {},
  ms: number,
  fetchImpl: FetchLike = fetch,
): Promise<Response> {
  const controller = new AbortController();
  const caller = init.signal ?? undefined;
  const forward = () => controller.abort();
  if (caller) {
    if (caller.aborted) controller.abort();
    else caller.addEventListener('abort', forward);
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, ms);
  return fetchImpl(input, { ...init, signal: controller.signal })
    .catch((e: unknown) => {
      if (timedOut) throw new TimeoutError();
      throw e;
    })
    .finally(() => {
      clearTimeout(timer);
      caller?.removeEventListener('abort', forward);
    });
}
