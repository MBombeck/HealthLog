import { settleWithin } from "@/lib/async/settle-within";
import { loadDocument } from "@/lib/navigation/load-document";
import { clearOfflineCachesForSessionEnd } from "@/lib/pwa/query-persister";

/**
 * Leave for the identity provider. The session starts on the way back, so
 * the last account's offline copies go first. The wait for them is capped:
 * WebKit can leave an IndexedDB open hanging after the installed app returns
 * from the background, and the button must still work then.
 */
export async function leaveForSingleSignOn(url: string): Promise<void> {
  await settleWithin(clearOfflineCachesForSessionEnd(), 1_500, undefined);
  loadDocument(url);
}
