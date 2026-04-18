import { hash, verify } from "@node-rs/argon2";
import zxcvbn from "zxcvbn-typescript";
import { getZxcvbnTranslations } from "@/lib/zxcvbn-i18n";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { defaultLocale, type Locale } from "@/lib/i18n/config";

export async function hashPassword(password: string): Promise<string> {
  return hash(password, {
    memoryCost: 19456,
    timeCost: 2,
    outputLen: 32,
    parallelism: 1,
  });
}

export async function verifyPassword(
  storedHash: string,
  password: string,
): Promise<boolean> {
  return verify(storedHash, password);
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
