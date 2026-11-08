/**
 * Pin `Date` for a browser test, and nothing else.
 *
 * Forms default their timestamp to "now" and refuse a future one, so a test
 * that asserts the instant a form sends has to say what now is. Only `Date`
 * is faked: timers, animation frames and the microtask queue keep running,
 * which is what Radix, TanStack Query and the URL-state queue wait on.
 * `setup.ts` restores the real clock after every test.
 *
 * `setSystemTime` without fake timers holds `Date` at the given instant.
 * `useFakeTimers({ toFake: ["Date"] })` did the same until vitest 5.1, where
 * the faked `Date` moves on with the wall clock and a form submitted a few
 * hundred milliseconds in no longer sends the pinned instant.
 */
import { vi } from "vitest";

export function pinDate(iso: string): void {
  vi.setSystemTime(new Date(iso));
}
