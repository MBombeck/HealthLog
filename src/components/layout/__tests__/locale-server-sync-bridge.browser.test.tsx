/**
 * The language reaches the account only when there is an account.
 *
 * The provider used to PUT the locale on every mount, signed in or not. A
 * signed-out page got a 401, the once-per-tab marker was never set, and every
 * signed-out page load sent the refused write again. The write now belongs to
 * `LocaleServerSyncBridge`, which waits for the account payload without
 * fetching it and then sends the choice once.
 */
import { describe, expect, it } from "vitest";

import { queryKeys } from "@/lib/query-keys";

import { authUser, renderWithApp } from "../../../../tests/browser/render";
import { stubFetch } from "../../../../tests/browser/fetch-stub";
import { LocaleServerSyncBridge } from "../locale-server-sync-bridge";

const LOCALE_PUT = "/api/auth/me/locale";

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 150));
}

describe("LocaleServerSyncBridge", () => {
  it("sends nothing while nobody is signed in, and never asks who is", async () => {
    const fetchStub = stubFetch().on("PUT", LOCALE_PUT, { data: null });
    await renderWithApp(<LocaleServerSyncBridge />, {
      user: null,
      locale: "de",
    });
    await settle();
    expect(fetchStub.calls("PUT", LOCALE_PUT)).toHaveLength(0);
    expect(fetchStub.calls("GET", "/api/auth/me")).toHaveLength(0);
  });

  it("sends the choice made while signed out once an account appears", async () => {
    const fetchStub = stubFetch().on("PUT", LOCALE_PUT, { data: null });
    const { queryClient } = await renderWithApp(<LocaleServerSyncBridge />, {
      user: null,
      locale: "de",
    });
    await settle();
    expect(fetchStub.calls("PUT", LOCALE_PUT)).toHaveLength(0);

    queryClient.setQueryData(
      queryKeys.authMe(),
      authUser({ id: "account-signed-in-later" }),
    );
    await expect.poll(() => fetchStub.calls("PUT", LOCALE_PUT).length).toBe(1);
    expect(fetchStub.calls("PUT", LOCALE_PUT)[0].body).toEqual({
      locale: "de",
    });
  });

  it("writes once per tab for the same account and language", async () => {
    const fetchStub = stubFetch().on("PUT", LOCALE_PUT, { data: null });
    const first = await renderWithApp(<LocaleServerSyncBridge />, {
      user: { id: "account-already-synced" },
      locale: "en",
    });
    await expect.poll(() => fetchStub.calls("PUT", LOCALE_PUT).length).toBe(1);
    await first.screen.unmount();

    await renderWithApp(<LocaleServerSyncBridge />, {
      user: { id: "account-already-synced" },
      locale: "en",
    });
    await settle();
    expect(fetchStub.calls("PUT", LOCALE_PUT)).toHaveLength(1);
  });
});
