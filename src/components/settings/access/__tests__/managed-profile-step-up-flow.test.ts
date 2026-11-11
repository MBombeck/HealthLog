/**
 * #959 — "I get the error message that I need to confirm my second factor,
 * but there is nowhere to do so."
 *
 * Handing a managed profile over, adding a Guardian and removing one are gated
 * on a second factor proved within five minutes (`requireFreshMfa`). Its
 * refusal, 401 `auth.stepup.required`, now names the proofs that clear it in
 * `meta.methods`, and each of these mutations runs inside the re-proof flow:
 * the dialog opens with those proofs, the proof goes to `/api/auth/reproof`,
 * and the request is sent once more.
 *
 * Driven for real below: the hooks' own `mutationFn`s, the flow
 * `useRecentProof` binds to the dialog, and a fake network that answers the
 * way the routes do. `@tanstack/react-query` is reduced to the two calls the
 * hook bodies make, as in `managed-profiles-invalidation.test.ts`; the unit
 * environment has no DOM, so the dialog itself is represented by the view the
 * flow drives (which proofs it offers, its error line) and by the test acting
 * as the person: proving, or closing it.
 *
 * Mutation checks, run: drop `guard(…)` from `useCreateManagedProfileHandover`
 * and every handover case goes red (the refusal escapes, no dialog); make
 * `isProofRefusal` match `auth.reproof.required` only and every case that
 * expects a dialog goes red.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    useMutation: (options: unknown) => options,
    useQueryClient: () => new QueryClient(),
  };
});

vi.mock("qrcode", () => ({
  default: { toDataURL: vi.fn(async () => "data:image/png;base64,AAAA") },
}));

import {
  useCreateManagedProfileHandover,
  useInviteManagedProfileGuardian,
  useRemoveManagedProfileGuardian,
} from "@/lib/queries/use-managed-profiles";
import { ApiError, apiPost } from "@/lib/api/api-fetch";
import {
  ReproofCancelledError,
  createRecentProofFlow,
  type RecentProofFlow,
} from "@/components/settings/security-section/recent-proof-flow";
import type { ReauthMethod } from "@/components/settings/security-section/existing-factor-reauth-dialog";
import { stepUpErrorKey } from "@/components/settings/access/grant-action-error";

type MutationOptions<I, O> = { mutationFn: (input: I) => Promise<O> };

// ── The network, answering the way the routes do ────────────────────────────

const STALE = {
  data: null,
  error: "Recent second-factor verification required",
  meta: { errorCode: "auth.stepup.required", methods: ["totp", "passkey"] },
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Every request, as `METHOD path`, in order. */
let sent: string[] = [];
/** The session's second factor is fresh once a proof was accepted. */
let fresh = false;
/** The codes the authenticator would accept. */
const GOOD_CODE = "246810";
let actionAnswer: () => Response = () => json(200, { data: {}, error: null });

beforeEach(() => {
  sent = [];
  fresh = false;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const path = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    sent.push(`${method} ${path}`);
    if (path === "/api/auth/reproof") {
      const proof = JSON.parse(String(init?.body ?? "{}"));
      if (proof.method === "totp" && proof.code === GOOD_CODE) {
        fresh = true;
        return json(200, { data: { method: "totp" }, error: null });
      }
      return json(401, {
        data: null,
        error: "Verification failed",
        meta: { errorCode: "auth.reproof.failed" },
      });
    }
    return fresh ? actionAnswer() : json(401, STALE);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── The dialog, as the flow drives it ───────────────────────────────────────

interface Dialog {
  flow: RecentProofFlow;
  /** What the dialog offered each time it opened. */
  offered: ReauthMethod[][];
  open: boolean;
  error: string | null;
  /** Resolves when the dialog next opens. */
  opened: () => Promise<void>;
}

function dialog(): Dialog {
  let notify: (() => void) | null = null;
  const d: Dialog = {
    offered: [],
    open: false,
    error: null,
    opened: () =>
      new Promise<void>((resolve) => {
        if (d.open) resolve();
        else notify = resolve;
      }),
    flow: undefined as unknown as RecentProofFlow,
  };
  d.flow = createRecentProofFlow({
    view: {
      setMethods: (methods) => {
        d.open = methods !== null;
        if (methods) {
          d.offered.push(methods);
          notify?.();
          notify = null;
        }
      },
      setPending: () => {},
      setError: (error) => {
        d.error = error;
      },
    },
    // The same call `useRecentProof` makes.
    submit: (proof) => apiPost("/api/auth/reproof", proof),
    messages: () => ({
      signInAgain: "sign in again",
      failed: "failed",
      rateLimited: "rate limited",
    }),
  });
  return d;
}

const HANDOVER = "/api/managed-profiles/p1/handover";

function useHandover(d: Dialog) {
  return useCreateManagedProfileHandover(
    d.flow.run,
  ) as unknown as MutationOptions<
    { profileId: string; expiresInDays: 7; proposals: [] },
    { url: string; qrDataUrl: string }
  >;
}

describe("handing a profile over with a stale second factor", () => {
  beforeEach(() => {
    actionAnswer = () =>
      json(201, {
        data: {
          url: "https://example.test/claim#t",
          token: "t",
          expiresAt: "2026-10-24T00:00:00.000Z",
        },
        error: null,
      });
  });

  it("opens the dialog with the proofs the server named, then hands over", async () => {
    const d = dialog();
    const pending = useHandover(d).mutationFn({
      profileId: "p1",
      expiresInDays: 7,
      proposals: [],
    });

    await d.opened();
    expect(d.offered).toEqual([["totp", "passkey"]]);
    await d.flow.prove({ method: "totp", code: GOOD_CODE });

    const link = await pending;
    expect(link.url).toBe("https://example.test/claim#t");
    expect(d.open).toBe(false);
    expect(sent).toEqual([
      `POST ${HANDOVER}`,
      "POST /api/auth/reproof",
      `POST ${HANDOVER}`,
    ]);
  });

  it("keeps the dialog open on a wrong code and retries only after a right one", async () => {
    const d = dialog();
    const pending = useHandover(d).mutationFn({
      profileId: "p1",
      expiresInDays: 7,
      proposals: [],
    });

    await d.opened();
    await d.flow.prove({ method: "totp", code: "000000" });
    expect(d.open).toBe(true);
    expect(d.error).toBe("failed");
    expect(sent).toEqual([`POST ${HANDOVER}`, "POST /api/auth/reproof"]);

    await d.flow.prove({ method: "totp", code: GOOD_CODE });
    await pending;
    expect(sent.filter((s) => s === `POST ${HANDOVER}`)).toHaveLength(2);
  });

  it("sends nothing more when the dialog is closed", async () => {
    const d = dialog();
    const pending = useHandover(d).mutationFn({
      profileId: "p1",
      expiresInDays: 7,
      proposals: [],
    });

    await d.opened();
    d.flow.cancel();

    await expect(pending).rejects.toBeInstanceOf(ReproofCancelledError);
    expect(sent).toEqual([`POST ${HANDOVER}`]);
  });

  it("asks once: a second refusal after the proof is the answer", async () => {
    actionAnswer = () => json(401, STALE);
    const d = dialog();
    const pending = useHandover(d).mutationFn({
      profileId: "p1",
      expiresInDays: 7,
      proposals: [],
    });

    await d.opened();
    await d.flow.prove({ method: "totp", code: GOOD_CODE });

    await expect(pending).rejects.toMatchObject({ status: 401 });
    expect(d.offered).toHaveLength(1);
  });

  it("opens no dialog for an account with no second factor, and says where to get one", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      json(401, {
        data: null,
        error: "Recent second-factor verification required",
        meta: { errorCode: "auth.stepup.mfa_not_enrolled" },
      }),
    );
    const d = dialog();
    const err = await useHandover(d)
      .mutationFn({ profileId: "p1", expiresInDays: 7, proposals: [] })
      .catch((e: unknown) => e);

    expect(d.offered).toEqual([]);
    expect(err).toBeInstanceOf(ApiError);
    expect(stepUpErrorKey(err as ApiError)).toBe(
      "recordSharing.managed.errorMfaRequired",
    );
  });
});

describe("adding and removing a Guardian with a stale second factor", () => {
  beforeEach(() => {
    actionAnswer = () => json(201, { data: { id: "g2" }, error: null });
  });

  it("adds the Guardian after the proof", async () => {
    const d = dialog();
    const invite = useInviteManagedProfileGuardian(
      d.flow.run,
    ) as unknown as MutationOptions<
      { profileId: string; identifier: string; expiresAt: null },
      unknown
    >;
    const pending = invite.mutationFn({
      profileId: "p1",
      identifier: "someone",
      expiresAt: null,
    });

    await d.opened();
    expect(d.offered).toEqual([["totp", "passkey"]]);
    await d.flow.prove({ method: "totp", code: GOOD_CODE });
    await pending;

    expect(sent).toEqual([
      "POST /api/managed-profiles/p1/guardians",
      "POST /api/auth/reproof",
      "POST /api/managed-profiles/p1/guardians",
    ]);
  });

  it("removes the Guardian after the proof", async () => {
    actionAnswer = () => json(200, { data: { revoked: true }, error: null });
    const d = dialog();
    const remove = useRemoveManagedProfileGuardian(
      d.flow.run,
    ) as unknown as MutationOptions<
      { profileId: string; grantId: string },
      unknown
    >;
    const pending = remove.mutationFn({ profileId: "p1", grantId: "g2" });

    await d.opened();
    await d.flow.prove({ method: "totp", code: GOOD_CODE });
    await pending;

    expect(sent).toEqual([
      "DELETE /api/managed-profiles/p1/guardians/g2",
      "POST /api/auth/reproof",
      "DELETE /api/managed-profiles/p1/guardians/g2",
    ]);
  });

  it("removes nothing when the dialog is closed", async () => {
    const d = dialog();
    const remove = useRemoveManagedProfileGuardian(
      d.flow.run,
    ) as unknown as MutationOptions<
      { profileId: string; grantId: string },
      unknown
    >;
    const pending = remove.mutationFn({ profileId: "p1", grantId: "g2" });

    await d.opened();
    d.flow.cancel();
    await expect(pending).rejects.toBeInstanceOf(ReproofCancelledError);
    expect(sent).toEqual(["DELETE /api/managed-profiles/p1/guardians/g2"]);
  });
});
