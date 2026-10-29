import { ApiError } from "@/lib/api/api-fetch";
import {
  isReproofRequired,
  type ExistingFactorProof,
  type ReauthMethod,
} from "./existing-factor-reauth-dialog";

/**
 * The re-proof flow without React: catch the refusal, ask for a proof, post
 * it, run the action once more. `useRecentProof` binds it to component state
 * and the dialog; the unit suite drives it directly, because this repository's
 * component tests run without a browser DOM and the flow is what matters.
 */

const KNOWN_METHODS: readonly ReauthMethod[] = [
  "password",
  "oidc",
  "totp",
  "webauthn",
  "passkey",
];

/** The proofs a refusal says this account can give. */
function methodsFrom(err: ApiError): ReauthMethod[] {
  const raw = err.meta?.methods;
  if (!Array.isArray(raw)) return [];
  return raw.filter((m): m is ReauthMethod =>
    KNOWN_METHODS.includes(m as ReauthMethod),
  );
}

/**
 * A refusal the re-proof dialog can clear.
 *
 * Two gates answer this way. The recent-proof gate (`auth.reproof.required`)
 * in front of exports, share links, tokens, invitations and the admin data
 * actions; and the fresh-factor gate (`auth.stepup.required`, from
 * `requireFreshMfa`) in front of the managed-profile acts, the second-factor
 * changes, passkey removal, the password change, account deletion, the data
 * wipe and the key rotation. The second one names the proofs it would take in
 * `meta.methods` on a browser session, and a `POST /api/auth/reproof` with one
 * of them stamps the session the way signing in with the factor does, so the
 * same dialog clears both. A fresh-factor refusal without `methods` (an
 * account with no factor at all says `auth.stepup.mfa_not_enrolled` instead)
 * is not something a dialog can answer, and stays with the caller's own
 * message.
 */
export function isProofRefusal(err: unknown): boolean {
  if (isReproofRequired(err)) return true;
  return (
    err instanceof ApiError &&
    err.status === 401 &&
    err.meta?.errorCode === "auth.stepup.required" &&
    methodsFrom(err).length > 0
  );
}

/** The person closed the re-proof dialog. Nothing ran; show nothing. */
export class ReproofCancelledError extends Error {
  constructor() {
    super("Re-proof cancelled");
    this.name = "ReproofCancelledError";
  }
}

export interface RecentProofFlowView {
  /** Open the dialog offering these proofs, or close it with `null`. */
  setMethods: (methods: ReauthMethod[] | null) => void;
  setPending: (pending: boolean) => void;
  setError: (error: string | null) => void;
}

export interface RecentProofFlow {
  run: <T>(action: () => Promise<T>) => Promise<T>;
  /** The dialog collected a proof: post it and release the waiting action. */
  prove: (proof: ExistingFactorProof) => Promise<void>;
  /** The dialog was closed without a proof. */
  cancel: () => void;
}

export function createRecentProofFlow(deps: {
  view: RecentProofFlowView;
  /** Posts the proof to `/api/auth/reproof`. */
  submit: (proof: ExistingFactorProof) => Promise<unknown>;
  /** Read at the moment they are needed, so a locale switch is honoured. */
  messages: () => { signInAgain: string; failed: string };
}): RecentProofFlow {
  let waiter: { resolve: () => void; reject: () => void } | null = null;

  const run = async <T>(action: () => Promise<T>): Promise<T> => {
    try {
      return await action();
    } catch (err) {
      if (!isProofRefusal(err)) throw err;
      const offered = methodsFrom(err as ApiError);
      // Nothing to re-prove in place: an account that signs in through an
      // identity provider the instance no longer offers. A fresh sign-in is
      // the proof it can give. One that can still reach its provider is
      // offered `oidc` instead, which leaves the page and comes back to it.
      if (offered.length === 0) {
        throw new ApiError(deps.messages().signInAgain, 401, {
          errorCode: "auth.reproof.sign_in_again",
        });
      }
      await new Promise<void>((resolve, reject) => {
        waiter = {
          resolve,
          reject: () => reject(new ReproofCancelledError()),
        };
        deps.view.setError(null);
        deps.view.setMethods(offered);
      });
      // Once. A second refusal is the answer, not a reason to ask again.
      return action();
    }
  };

  const prove = async (proof: ExistingFactorProof): Promise<void> => {
    deps.view.setPending(true);
    deps.view.setError(null);
    try {
      await deps.submit(proof);
      deps.view.setMethods(null);
      const w = waiter;
      waiter = null;
      w?.resolve();
    } catch (err) {
      deps.view.setError(
        err instanceof ApiError && err.status === 429
          ? err.message
          : deps.messages().failed,
      );
    } finally {
      deps.view.setPending(false);
    }
  };

  const cancel = () => {
    deps.view.setMethods(null);
    deps.view.setError(null);
    const w = waiter;
    waiter = null;
    w?.reject();
  };

  return { run, prove, cancel };
}
