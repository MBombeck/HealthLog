import { hash, verify } from "@node-rs/argon2";
import zxcvbn from "zxcvbn-typescript";
import {
  getZxcvbnTranslations,
  PASSWORD_STRENGTH_MAX_LENGTH,
} from "@/lib/zxcvbn-i18n";
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
 * Minted from `ARGON2_HASH_OPTIONS`, the same parameters every real hash
 * carries, because Argon2 encodes its cost in the hash string and the
 * verifier pays whatever the string says. A dummy minted at cheaper settings
 * would leave the gap it was added to close.
 *
 * The input is a fixed constant rather than a random string so the module
 * has no hidden state, and it is never compared to anything: the arm that
 * verifies against it discards the verdict and returns false. There is no
 * path on which a caller can make this hash accept.
 */
const DUMMY_VERIFY_INPUT = "healthlog: not a credential, never accepted";

let dummyHashPromise: Promise<string> | null = null;

/**
 * The dummy hash, minted on first use and kept for the process afterwards.
 *
 * Lazy rather than minted at import: every process that imports this module
 * would otherwise spend 19 MiB and a thread-pool slot at boot, including the
 * queue worker and each build worker, none of which ever authenticates
 * anybody. From the second refusal onward the cost profile is identical
 * either way.
 *
 * A rejected promise stays rejected for the life of the process, so caching
 * one would degrade every later refusal back to the cheap path and leave the
 * timing channel open with no way to notice. A failed mint is therefore
 * dropped and the next call mints again.
 */
function dummyHash(): Promise<string> {
  if (!dummyHashPromise) {
    const pending = hash(DUMMY_VERIFY_INPUT, ARGON2_HASH_OPTIONS);
    dummyHashPromise = pending;
    pending.catch(() => {
      if (dummyHashPromise === pending) dummyHashPromise = null;
    });
  }
  return dummyHashPromise;
}

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
  try {
    // Same verifier, same cost profile, verdict discarded.
    await verify(await dummyHash(), password);
  } catch (error) {
    // Both the mint and the verify are inside the guard, and the mint has to
    // be: an unguarded `await` on a rejected mint would throw out of here and
    // answer 500 on exactly the arm this function exists to make ordinary —
    // an unknown identifier answering 500 while a real account answers 401 is
    // the oracle again, in the status code, and cheaper to read than the
    // timing gap was. The breadcrumb makes a degraded instance visible; the
    // answer below is the same either way.
    console.error("[auth] dummy password verification failed", error);
  }
  return false;
}

/**
 * The meter's reading of a password as the user types it: zxcvbn's score and
 * its untranslated feedback, which the client maps to the UI language with
 * `getZxcvbnTranslations`. The estimator runs here rather than in the browser
 * because its dictionaries are about 375 KB gzip, more than any page of the
 * app; `POST /api/auth/password-strength` serves it to the meter.
 */
export interface PasswordStrengthEstimate {
  score: number; // 0-4
  warning: string;
  suggestions: string[];
}

/**
 * The characters zxcvbn's l33t matcher reads as substituted letters. It tries
 * every combination of the substitutions present, so its work multiplies with
 * each distinct one: twenty of them make 800 combinations, each a full
 * dictionary pass over the password.
 */
const L33T_CHARACTERS = new Set("4@8({[<369!|170$5+%2");
const MAX_DISTINCT_L33T_CHARACTERS = 6;

/**
 * The part of a password the estimator scores: at most
 * `PASSWORD_STRENGTH_MAX_LENGTH` characters, cut before the seventh distinct
 * l33t character. Both bounds keep one call in the low milliseconds on any
 * input (`password-estimate-cost.test.ts` counts the combinations left).
 * A password that reaches either bound with a strong prefix is strong; one
 * that is cut early reads weaker than it is, which errs on the safe side.
 */
export function passwordEstimateInput(password: string): string {
  const seen = new Set<string>();
  const limit = Math.min(password.length, PASSWORD_STRENGTH_MAX_LENGTH);
  for (let i = 0; i < limit; i++) {
    const ch = password[i];
    if (!L33T_CHARACTERS.has(ch) || seen.has(ch)) continue;
    if (seen.size === MAX_DISTINCT_L33T_CHARACTERS) return password.slice(0, i);
    seen.add(ch);
  }
  return password.slice(0, limit);
}

/** The one call into zxcvbn; every estimate goes through the bound above. */
function scorePassword(password: string, userInputs: string[] = []) {
  return zxcvbn(passwordEstimateInput(password), userInputs);
}

export function estimatePasswordStrength(
  password: string,
): PasswordStrengthEstimate {
  const result = scorePassword(password);
  return {
    score: result.score,
    warning: result.feedback.warning ?? "",
    suggestions: result.feedback.suggestions ?? [],
  };
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

  const result = scorePassword(password, userInputs);
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
