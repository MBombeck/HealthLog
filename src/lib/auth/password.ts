import { hash, verify } from "@node-rs/argon2";
import zxcvbn from "zxcvbn-typescript";
import { translateZxcvbn } from "@/lib/zxcvbn-de";

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

export function checkPasswordStrength(
  password: string,
  userInputs: string[] = [],
): PasswordStrength {
  if (password.length < 12) {
    return {
      score: 0,
      feedback: ["Passwort muss mindestens 12 Zeichen lang sein."],
      isAcceptable: false,
    };
  }

  const result = zxcvbn(password, userInputs);
  const feedback: string[] = [];

  if (result.feedback.warning) {
    feedback.push(translateZxcvbn(result.feedback.warning));
  }
  if (result.feedback.suggestions) {
    feedback.push(...result.feedback.suggestions.map(translateZxcvbn));
  }

  return {
    score: result.score,
    feedback,
    isAcceptable: result.score >= 3,
  };
}
