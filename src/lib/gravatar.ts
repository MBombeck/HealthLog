import { createHash } from "crypto";

/**
 * Generate a Gravatar avatar URL from an email address.
 * Uses SHA-256 hash (supported by Gravatar since 2023).
 * Returns 404 as default so the client can fall back to initials.
 */
export function getGravatarUrl(email: string, size = 80): string {
  const trimmed = email.trim().toLowerCase();
  const hash = createHash("sha256").update(trimmed).digest("hex");
  return `https://www.gravatar.com/avatar/${hash}?s=${size}&d=404`;
}
