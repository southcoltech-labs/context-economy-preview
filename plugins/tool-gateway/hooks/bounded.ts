// SPDX-License-Identifier: Apache-2.0

import type { Ports } from "./types.ts";

/**
 * `work`'s value, or `fallback()` once `ms` pass first. A late value or error from `work` is
 * dropped: nothing it settles to reaches the caller. `work` keeps running (a host read cannot
 * always be cancelled), so code inside it that changes state must check it is still current.
 */
export async function within<T>(
  ports: Pick<Ports, "sleep">,
  ms: number,
  work: Promise<T>,
  fallback: () => T,
): Promise<T> {
  const stop = new AbortController();
  work.catch(() => undefined);
  const timeUp = ports.sleep(Math.max(0, ms), stop.signal).then(
    () => ({ timedOut: true as const }),
    // Aborted once `work` settled (the race is decided), or the host has no timer: `work` decides.
    () => new Promise<never>(() => undefined),
  );
  try {
    const first = await Promise.race([work.then(value => ({ timedOut: false as const, value })), timeUp]);
    return first.timedOut ? fallback() : first.value;
  } finally {
    stop.abort();
  }
}
