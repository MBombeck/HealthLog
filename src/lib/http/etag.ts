/**
 * Content ETags for JSON reads: the tag is a hash of the exact body, so it
 * changes whenever anything the body says changes (a row edited, added,
 * tombstoned, or a dose whose state moved with the clock) and never
 * otherwise. A matching `If-None-Match` answers 304 with no body.
 */
import { createHash } from "node:crypto";

/** The strong ETag of `body`, quoted. */
export function contentEtag(body: string): string {
  return `"${createHash("sha256").update(body).digest("base64url").slice(0, 32)}"`;
}

/** Whether the request's `If-None-Match` names `etag` (or `*`). */
export function matchesEtag(request: Request, etag: string): boolean {
  const header = request.headers.get("if-none-match");
  if (!header) return false;
  return header
    .split(",")
    .map((v) => v.trim().replace(/^W\//, ""))
    .some((v) => v === etag || v === "*");
}
