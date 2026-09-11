import { hash, verify } from "@node-rs/argon2";
import zxcvbn from "zxcvbn-typescript";
import { getZxcvbnTranslations } from "@/lib/zxcvbn-i18n";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { defaultLocale, type Locale } from "@/lib/i18n/config";
// The Argon2id params live in a plain `.mjs` module so the operator
// password-reset CLI (scripts/reset-password.mjs) can mint a byte-identical
// hash under plain `node` in the production standalone image — there is one
// source of truth for the cost parameters, not two.
import { ARGON2_HASH_OPTIONS } from "./argon2-params.mjs";

export async function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_HASH_OPTIONS);
}

export async function verifyPassword(
  storedHash: string,
  password: string,
): Promise<boolean> {
  return verify(storedHash, password);
}

/**
 * A stand-in stored hash for the login arms that have nothing to verify.
 *
 * Sign-in used to return the moment it found no account, or an account with
 * no password — one indexed SELECT — while an account that did have a
 * password paid a full Argon2id verification at 19 MiB and t=2. The two
 * answers were byte-identical and the two costs were not, so the clock told
 * a caller which addresses are registered and which of those carry a
 * password. Verifying against this hash on the empty arms makes the work
 * comparable.
 *
 * Minted once per process from `ARGON2_HASH_OPTIONS`, the same parameters
 * every real hash carries, because Argon2 encodes its cost in the hash
 * string and the verifier pays whatever the string says. A dummy minted at
 * cheaper settings would leave the gap it was added to close.
 *
 * The input is a fixed constant rather than a random string so the module
 * has no hidden state, and it is never compared to anything: the arm that
 * verifies against it discards the verdict and returns false. There is no
 * path on which a caller can make this hash accept.
 */
const DUMMY_VERIFY_INPUT = "healthlog: not a credential, never accepted";
const DUMMY_PASSWORD_HASH: Promise<string> = hash(
  DUMMY_VERIFY_INPUT,
  ARGON2_HASH_OPTIONS,
);
// Keep a mint failure from surfacing as an unhandled rejection at import
// time; `verifyPasswordOrDummy` still awaits and still sees it.
void DUMMY_PASSWORD_HASH.catch(() => undefined);

/**
 * Verify `password` against `storedHash`, or against the dummy hash when
 * there is no stored hash to verify against.
 *
 * Returns false whenever `storedHash` is absent — an account without a
 * password, or no account at all. The dummy verification's own verdict is
 * thrown away, so a false here is never a rejected credential being
 * mistaken for anything else, and a true can only come from a real stored
 * hash.
 *
 * Callers on an anonymous surface should use this rather than branching on
 * the absent hash themselves: the branch is what the clock reads.
 */
export async function verifyPasswordOrDummy(
  storedHash: string | null | undefined,
  password: string,
): Promise<boolean> {
  if (storedHash) return verify(storedHash, password);
  // Same verifier, same cost profile, verdict discarded. A throw here (a
  // malformed dummy, a mint that failed) must not turn into a 500 that only
  // the unknown-account arm can produce — that would be the oracle again,
  // in the status code this time.
  await verify(await DUMMY_PASSWORD_HASH, password).catch(() => false);
  return false;
}

export interface PasswordStrength {
  score: number; // 0-4
  feedback: string[];
  isAcceptable: boolean;
}

const MIN_PASSWORD_LENGTH = 12;

export function checkPasswordStrength(
  password: string,
  userInputs: string[] = [],
  locale: Locale = defaultLocale,
): PasswordStrength {
  const { t } = getServerTranslator(locale);
  const { translate } = getZxcvbnTranslations(locale);

  if (password.length < MIN_PASSWORD_LENGTH) {
    return {
      score: 0,
      feedback: [
        t("auth.passwordTooShort", { minLength: MIN_PASSWORD_LENGTH }),
      ],
      isAcceptable: false,
    };
  }

  const result = zxcvbn(password, userInputs);
  const feedback: string[] = [];

  if (result.feedback.warning) {
    feedback.push(translate(result.feedback.warning));
  }
  if (result.feedback.suggestions) {
    feedback.push(...result.feedback.suggestions.map(translate));
  }

  return {
    score: result.score,
    feedback,
    isAcceptable: result.score >= 3,
  };
}
