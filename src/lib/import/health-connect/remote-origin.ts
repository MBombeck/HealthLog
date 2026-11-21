/**
 * Which WebDAV or Nextcloud folders the scheduled Health Connect fetch may
 * call.
 *
 * The Dawarich rule (`src/lib/dawarich/origin.ts`): a public host is
 * reachable without configuration and goes out through `safeFetch` with
 * `requirePublicHost`; a private one (a Nextcloud on the home network) only
 * when its exact origin is listed in `HEALTH_CONNECT_WEBDAV_PRIVATE_ORIGINS`
 * (the shared grant grammar in `@/lib/private-origin-policy`: one
 * `scheme://host[:port]` per entry, comma separated, never a suffix or a
 * range), and then through the operator-approved dispatcher. The request body
 * can never widen it. A folder URL may carry a path; the grant is matched on
 * the origin.
 *
 * The fetch sends the WebDAV password in a Basic header, so a public host is
 * reachable over `https:` only (`https_required` otherwise): over plain
 * `http:` everyone on the path would read the password every six hours. Plain
 * `http:` stays possible for a private host the operator listed with that
 * exact `http://` origin, a Nextcloud on the home network without a
 * certificate, because the grant names the scheme.
 */
import {
  evaluateOriginGrant,
  INVALID_ORIGIN,
  originOfUrl,
  parsePrivateOrigins,
  type OriginReason,
} from "@/lib/private-origin-policy";

export class WebdavOriginConfigError extends Error {
  constructor(redactedEntry: string, reason: string) {
    super(
      `Invalid HEALTH_CONNECT_WEBDAV_PRIVATE_ORIGINS entry "${redactedEntry}": ${reason}`,
    );
    this.name = "WebdavOriginConfigError";
  }
}

/** The operator's exact-origin grants; throws on a malformed entry. */
export function configuredWebdavPrivateOrigins(): ReadonlySet<string> {
  return parsePrivateOrigins(
    process.env.HEALTH_CONNECT_WEBDAV_PRIVATE_ORIGINS,
    (redactedEntry, reason) => {
      throw new WebdavOriginConfigError(redactedEntry, reason);
    },
  );
}

/** A public folder address over plain `http:`. */
export const HTTPS_REQUIRED = "https_required" as const;

export type WebdavReason = OriginReason | typeof HTTPS_REQUIRED;

export interface WebdavTarget {
  allowed: boolean;
  /** The folder URL without a trailing slash, null when unusable. */
  folderUrl: string | null;
  origin: string | null;
  privateOriginApproved: boolean;
  reasonCode: WebdavReason | null;
}

/**
 * Resolve a folder URL against the grants. Credentials in the URL, a query
 * and a fragment make it unusable: the credentials travel in a header.
 */
export function evaluateWebdavFolderUrl(
  value: string,
  privateOrigins: ReadonlySet<string>,
): WebdavTarget {
  const refused = (reasonCode: WebdavReason): WebdavTarget => ({
    allowed: false,
    folderUrl: null,
    origin: null,
    privateOriginApproved: false,
    reasonCode,
  });
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return refused(INVALID_ORIGIN);
  }
  if (url.username || url.password || url.search || url.hash) {
    return refused(INVALID_ORIGIN);
  }
  const origin = originOfUrl(value);
  if (!origin) return refused(INVALID_ORIGIN);
  const verdict = evaluateOriginGrant(origin, privateOrigins, value);
  if (
    verdict.allowed &&
    !verdict.privateOriginApproved &&
    url.protocol !== "https:"
  ) {
    return refused(HTTPS_REQUIRED);
  }
  const path = url.pathname.replace(/\/+$/, "");
  return {
    allowed: verdict.allowed,
    folderUrl: verdict.allowed ? `${origin}${path}` : null,
    origin,
    privateOriginApproved: verdict.privateOriginApproved,
    reasonCode: verdict.reasonCode,
  };
}
