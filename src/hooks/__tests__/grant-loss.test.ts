/**
 * Leaving a record the server has stopped honouring.
 *
 * Revocation clears the delegate's acting sessions in the same transaction, so
 * that path puts the browser back by itself. Expiry does not — nothing sweeps,
 * the grant simply stops being live on the next request, and the session keeps
 * its stamp. From then on every read is a correct 403 under a banner that says
 * the person is somewhere they are not.
 *
 * The subscriber is what closes that. It runs against a real `QueryClient`
 * here, driven into the error state the way a failing read drives it, because
 * "the effect calls subscribe" is a claim about source and "the callback fires
 * when a read is refused" is the behaviour somebody depends on.
 *
 * Mutation check, run: widen the guard to fire on any error (drop the
 * `isSharingAccessDenied` test) → "ignores an ordinary failure" goes red.
 */
import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";

import {
  isSharingAccessDenied,
  subscribeToGrantLoss,
} from "@/hooks/use-account-switch";
import { ApiError } from "@/lib/api/api-fetch";
import { QUERY_CLIENT_DEFAULT_OPTIONS } from "@/lib/pwa/query-client-options";

function client(): QueryClient {
  return new QueryClient({ defaultOptions: QUERY_CLIENT_DEFAULT_OPTIONS });
}

/** Drive one query to the error state, the way a refused read does. */
async function failWith(qc: QueryClient, error: unknown): Promise<void> {
  await qc
    .fetchQuery({
      queryKey: ["probe", Math.random()],
      queryFn: () => Promise.reject(error),
      retry: false,
    })
    .catch(() => {});
}

const DENIED = new ApiError("Account access denied", 403, {
  errorCode: "sharing.access.denied",
});
const NOT_PERMITTED = new ApiError("Not permitted", 403, {
  errorCode: "sharing.not_permitted",
});

describe("the two sharing error codes", () => {
  it("tells the two apart", () => {
    // Different facts, different responses. One means the caller may no longer
    // act as that account and must leave; the other means the surface is not
    // part of what sharing covers and leaving would be the wrong answer.
    expect(isSharingAccessDenied(DENIED)).toBe(true);
    expect(isSharingAccessDenied(NOT_PERMITTED)).toBe(false);
  });

  it("reads the code, not the status or the prose", () => {
    expect(isSharingAccessDenied(new ApiError("Forbidden", 403))).toBe(false);
    expect(isSharingAccessDenied(new Error("Account access denied"))).toBe(
      false,
    );
    expect(isSharingAccessDenied(null)).toBe(false);
  });
});

describe("subscribeToGrantLoss", () => {
  it("leaves when a read is refused for a grant that has ended", async () => {
    const qc = client();
    const onLoss = vi.fn();
    const stop = subscribeToGrantLoss(qc, onLoss);

    await failWith(qc, DENIED);
    stop();

    expect(onLoss).toHaveBeenCalledTimes(1);
  });

  it("ignores an ordinary failure", async () => {
    const qc = client();
    const onLoss = vi.fn();
    const stop = subscribeToGrantLoss(qc, onLoss);

    // A 500, a network blip and a not-permitted surface are all reasons to
    // stay put. Reloading the app out of the record on any of them would turn
    // a transient error into a lost context.
    await failWith(qc, new ApiError("Server error", 500));
    await failWith(qc, NOT_PERMITTED);
    await failWith(qc, new TypeError("fetch failed"));
    stop();

    expect(onLoss).not.toHaveBeenCalled();
  });

  it("fires once, however many reads are refused", async () => {
    // A switched page has several reads in flight and they all fail together.
    // The callback replaces the document; a second one would queue a second
    // navigation behind it.
    const qc = client();
    const onLoss = vi.fn();
    const stop = subscribeToGrantLoss(qc, onLoss);

    await failWith(qc, DENIED);
    await failWith(qc, DENIED);
    await failWith(qc, DENIED);
    stop();

    expect(onLoss).toHaveBeenCalledTimes(1);
  });

  it("stops listening once unsubscribed", async () => {
    const qc = client();
    const onLoss = vi.fn();
    subscribeToGrantLoss(qc, onLoss)();

    await failWith(qc, DENIED);

    expect(onLoss).not.toHaveBeenCalled();
  });
});
