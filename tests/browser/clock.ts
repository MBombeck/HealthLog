/**
 * Pin `Date` for a browser test, and nothing else.
 *
 * Forms default their timestamp to "now" and refuse a future one, so a test
 * that asserts the instant a form sends has to say what now is. Only `Date`
 * is faked: timers, animation frames and the microtask queue keep running,
 * which is what Radix, TanStack Query and the URL-state queue wait on.
 * `setup.ts` restores the real clock after every test.
 */
import { vi } from "vitest";

export function pinDate(iso: string): void {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date(iso) });
}
