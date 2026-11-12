import { settleWithin } from "@/lib/async/settle-within";
import { clearOfflineCachesForSessionEnd } from "@/lib/pwa/query-persister";

/**
 * The session-end wipe before the page leaves for the identity provider,
 * where the next session starts. The wait is capped: WebKit can leave an
 * IndexedDB open hanging after the installed app returns from the
 * background, and the button must still work then.
 */
export function clearOfflineCachesBeforeLeaving(): Promise<void> {
  return settleWithin(clearOfflineCachesForSessionEnd(), 1_500, undefined);
}
