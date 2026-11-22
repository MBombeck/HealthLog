/**
 * Fetch the scheduled Health Connect export from a WebDAV or Nextcloud
 * folder and hand it to the importer.
 *
 * Health Connect's scheduled export writes `Health Connect.zip` into a cloud
 * folder again and again. Each due source is fetched once per pass:
 *
 *   1. `GET <folder>/<file>` through `safeFetch` (public host, or the
 *      operator-approved private origin; never a redirect), with Basic
 *      credentials and the last ETag as `If-None-Match`. A 304 is
 *      "unchanged".
 *   2. The body streams to a temp file, hashed on the way and cut off at
 *      {@link REMOTE_MAX_BYTES} (the upload's cap).
 *   3. A file whose hash matches the last one imported is "unchanged"; any
 *      other goes through `queueStagedHealthConnectImport`, the upload's own
 *      dedupe and queue, so a file is imported exactly once however it came.
 *
 * Backoff: a pass that found nothing new or queued an import is next due in
 * six hours; a failure doubles the wait from thirty minutes up to a day, and
 * an import already running for the account is retried in thirty minutes.
 * Outcomes are closed codes; nothing from the file or the server's answer
 * body is stored or logged.
 *
 * Every attempt is also written to the shared integration ledger under
 * `health-connect-remote`, so a fetch that keeps failing (a revoked app
 * password answering 401 every six hours) reaches Settings → Integrations,
 * `/api/integrations/status` and the assistant's integration tool like any
 * other connection, not only the import card.
 */
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OWNED_BY_ACTIVE_ACCOUNT } from "@/lib/account-deletion/active-account";
import { decrypt, encrypt } from "@/lib/crypto";
import { prisma } from "@/lib/db";
import {
  recordSyncFailure,
  recordSyncSuccess,
  type FailureKind,
} from "@/lib/integrations/status";
import { annotate } from "@/lib/logging/context";
import { safeFetch, SafeFetchError } from "@/lib/safe-fetch";

import { queueStagedHealthConnectImport } from "./queue-staged";
import {
  configuredWebdavPrivateOrigins,
  evaluateWebdavFolderUrl,
} from "./remote-origin";

/** The upload's cap: a multi-year export stays well below it. */
export const REMOTE_MAX_BYTES = 1024 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const HOUR_MS = 3_600_000;
export const REMOTE_SUCCESS_INTERVAL_MS = 6 * HOUR_MS;
const BACKOFF_BASE_MS = 30 * 60 * 1000;
const BACKOFF_MAX_MS = 24 * HOUR_MS;

export type RemoteOutcome =
  | "imported"
  | "unchanged"
  | "busy"
  | "not_found"
  | "unauthorized"
  | "redirected"
  | "upstream_error"
  | "too_large"
  | "timeout"
  | "network"
  | "private_origin_not_approved"
  | "invalid_origin"
  | "no_worker";

const SUCCESS: ReadonlySet<RemoteOutcome> = new Set(["imported", "unchanged"]);

/**
 * How each failed outcome reads on the integration ledger, with the closed
 * sentence stored as its error. `busy` is absent: another import of the
 * account is running, the folder is fine, and the attempt is retried in
 * thirty minutes, so it is neither a success nor a failure of the fetch.
 */
export const REMOTE_FAILURE: Readonly<
  Record<
    Exclude<RemoteOutcome, "imported" | "unchanged" | "busy">,
    { kind: FailureKind; message: string }
  >
> = {
  unauthorized: {
    kind: "reauth_required",
    message: "The folder refused the user name or app password.",
  },
  not_found: {
    kind: "persistent",
    message: "The export file was not found in the folder.",
  },
  redirected: {
    kind: "persistent",
    message: "The folder address answered with a redirect.",
  },
  invalid_origin: {
    kind: "persistent",
    message: "The folder address is not usable.",
  },
  private_origin_not_approved: {
    kind: "persistent",
    message: "The folder is on a private network this server does not allow.",
  },
  too_large: {
    kind: "persistent",
    message: "The export file is larger than 1 GB.",
  },
  upstream_error: {
    kind: "transient",
    message: "The folder's server answered with an error.",
  },
  timeout: {
    kind: "transient",
    message: "The folder's server did not answer in time.",
  },
  network: {
    kind: "transient",
    message: "The folder's server could not be reached.",
  },
  no_worker: {
    kind: "transient",
    message: "No background worker took the import.",
  },
};

/** Write one attempt to the shared ledger. Best effort: never fails the fetch. */
async function recordOnLedger(
  userId: string,
  outcome: RemoteOutcome,
): Promise<void> {
  try {
    if (outcome === "imported" || outcome === "unchanged") {
      await recordSyncSuccess(userId, "health-connect-remote");
      return;
    }
    if (outcome === "busy") return;
    const failure = REMOTE_FAILURE[outcome];
    await recordSyncFailure({
      userId,
      integration: "health-connect-remote",
      kind: failure.kind,
      message: failure.message,
      errorCode: outcome,
    });
  } catch {
    // The row on the source already holds the outcome; the ledger is a mirror.
  }
}

export interface RemoteCredentials {
  username: string;
  password: string;
}

export function sealCredentials(creds: RemoteCredentials): string {
  return encrypt(JSON.stringify(creds));
}

function openCredentials(sealed: string): RemoteCredentials | null {
  try {
    const parsed = JSON.parse(decrypt(sealed)) as Partial<RemoteCredentials>;
    return typeof parsed.username === "string" &&
      typeof parsed.password === "string"
      ? { username: parsed.username, password: parsed.password }
      : null;
  } catch {
    return null;
  }
}

/** When the next attempt is due after `outcome`. */
export function nextAttemptAfter(
  outcome: RemoteOutcome,
  failures: number,
  now: Date = new Date(),
): Date {
  if (SUCCESS.has(outcome)) {
    return new Date(now.getTime() + REMOTE_SUCCESS_INTERVAL_MS);
  }
  if (outcome === "busy") return new Date(now.getTime() + BACKOFF_BASE_MS);
  const wait = Math.min(
    BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1),
    BACKOFF_MAX_MS,
  );
  return new Date(now.getTime() + wait);
}

interface SourceRow {
  id: string;
  userId: string;
  folderUrl: string;
  fileName: string;
  credentialsEncrypted: string;
  lastEtag: string | null;
  lastFileSha256: string | null;
  consecutiveFailures: number;
}

type Download =
  | {
      kind: "file";
      path: string;
      bytes: number;
      sha256: string;
      etag: string | null;
    }
  | { kind: "outcome"; outcome: RemoteOutcome };

/** Stream `body` to a temp file with a byte cap, hashing on the way. */
async function streamToFile(
  body: ReadableStream<Uint8Array>,
): Promise<{ path: string; bytes: number; sha256: string } | null> {
  const path = join(
    tmpdir(),
    `healthlog-health-connect-import-${randomUUID()}.bin`,
  );
  const hash = createHash("sha256");
  const out = createWriteStream(path);
  let bytes = 0;
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > REMOTE_MAX_BYTES) {
        await reader.cancel().catch(() => {});
        out.destroy();
        await rm(path, { force: true });
        return null;
      }
      hash.update(value);
      if (!out.write(value)) {
        await new Promise<void>((resolve) => out.once("drain", resolve));
      }
    }
    await new Promise<void>((resolve, reject) =>
      out.end((err?: Error | null) => (err ? reject(err) : resolve())),
    );
    return { path, bytes, sha256: hash.digest("hex") };
  } catch (err) {
    out.destroy();
    await rm(path, { force: true });
    throw err;
  }
}

async function download(source: SourceRow): Promise<Download> {
  const target = evaluateWebdavFolderUrl(
    source.folderUrl,
    configuredWebdavPrivateOrigins(),
  );
  if (!target.allowed || !target.folderUrl || !target.origin) {
    return {
      kind: "outcome",
      // A public address over plain http (saved before that was refused)
      // reads as an unusable address: the card asks for a new one.
      outcome:
        target.reasonCode === "invalid_origin" ||
        target.reasonCode === "https_required"
          ? "invalid_origin"
          : "private_origin_not_approved",
    };
  }
  const creds = openCredentials(source.credentialsEncrypted);
  if (!creds) return { kind: "outcome", outcome: "unauthorized" };
  const url = `${target.folderUrl}/${encodeURIComponent(source.fileName)}`;
  const auth = Buffer.from(`${creds.username}:${creds.password}`).toString(
    "base64",
  );
  let res: Response;
  try {
    res = await safeFetch(
      url,
      {
        method: "GET",
        headers: {
          Authorization: `Basic ${auth}`,
          ...(source.lastEtag ? { "If-None-Match": source.lastEtag } : {}),
        },
      },
      {
        requirePublicHost: !target.privateOriginApproved,
        ...(target.privateOriginApproved
          ? { operatorApprovedPrivateOrigin: target.origin }
          : {}),
        timeoutMs: DOWNLOAD_TIMEOUT_MS,
      },
    );
  } catch (err) {
    if (err instanceof SafeFetchError) {
      return {
        kind: "outcome",
        outcome:
          err.kind === "private_host"
            ? "private_origin_not_approved"
            : err.kind === "timeout"
              ? "timeout"
              : "network",
      };
    }
    throw err;
  }
  const status = res.status;
  if (status === 304) return { kind: "outcome", outcome: "unchanged" };
  const refuse = (outcome: RemoteOutcome): Download => {
    void res.body?.cancel().catch(() => {});
    return { kind: "outcome", outcome };
  };
  if (status === 404) return refuse("not_found");
  if (status === 401 || status === 403) return refuse("unauthorized");
  if (status >= 300 && status < 400) return refuse("redirected");
  if (status < 200 || status >= 300 || !res.body) {
    return refuse("upstream_error");
  }
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > REMOTE_MAX_BYTES) return refuse("too_large");
  const file = await streamToFile(res.body);
  if (!file) return { kind: "outcome", outcome: "too_large" };
  return { kind: "file", ...file, etag: res.headers.get("etag") };
}

/** One source, one attempt, the row updated with its outcome. */
export async function fetchRemoteSource(
  source: SourceRow,
  now: Date = new Date(),
): Promise<RemoteOutcome> {
  const got = await download(source);
  let outcome: RemoteOutcome;
  let etag = source.lastEtag;
  let sha = source.lastFileSha256;
  let jobId: string | null = null;
  if (got.kind === "outcome") {
    outcome = got.outcome;
  } else if (got.sha256 === source.lastFileSha256) {
    await rm(got.path, { force: true });
    outcome = "unchanged";
    etag = got.etag;
  } else {
    const queued = await queueStagedHealthConnectImport({
      userId: source.userId,
      filePath: got.path,
      bytes: got.bytes,
      sha256: got.sha256,
    });
    switch (queued.outcome) {
      case "queued":
      case "idempotent":
        outcome = queued.outcome === "queued" ? "imported" : "unchanged";
        jobId = queued.jobId;
        etag = got.etag;
        sha = got.sha256;
        break;
      case "busy":
        outcome = "busy";
        break;
      default:
        outcome = "no_worker";
    }
  }
  const failures = SUCCESS.has(outcome) ? 0 : source.consecutiveFailures + 1;
  await prisma.healthConnectRemoteSource.update({
    where: { id: source.id },
    data: {
      lastAttemptAt: now,
      lastOutcome: outcome,
      consecutiveFailures:
        outcome === "busy" ? source.consecutiveFailures : failures,
      nextAttemptAt: nextAttemptAfter(outcome, failures, now),
      lastEtag: etag,
      lastFileSha256: sha,
      ...(jobId ? { lastImportJobId: jobId } : {}),
    },
  });
  await recordOnLedger(source.userId, outcome);
  annotate({
    action: { name: "import.health-connect.remote.fetch" },
    meta: { outcome, failures },
  });
  return outcome;
}

const SOURCE_SELECT = {
  id: true,
  userId: true,
  folderUrl: true,
  fileName: true,
  credentialsEncrypted: true,
  lastEtag: true,
  lastFileSha256: true,
  consecutiveFailures: true,
} as const;

/** Folders read at the same time in one pass. */
export const REMOTE_FETCH_CONCURRENCY = 4;
/**
 * How long a pass keeps starting folders. A download may run for
 * `DOWNLOAD_TIMEOUT_MS` once started, so the last one ends within about
 * fourteen minutes, inside the queue's fifteen-minute expiry. A folder not
 * started by then keeps its due time and is read on the next hourly pass.
 */
export const REMOTE_FETCH_START_BUDGET_MS = 4 * 60 * 1000;

/**
 * Run `work` over `items` in order, at most `concurrency` at once, starting
 * no item once `deadline` (epoch ms) has passed. Returns the results of the
 * items that ran, in the order they finished. A slow item holds one lane, so
 * the others keep moving past it.
 */
export async function runWithinBudget<T, R>(
  items: readonly T[],
  options: { concurrency: number; deadline: number; now?: () => number },
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const now = options.now ?? Date.now;
  const results: R[] = [];
  let next = 0;
  async function lane(): Promise<void> {
    while (next < items.length && now() < options.deadline) {
      const item = items[next++];
      results.push(await work(item));
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.max(1, Math.min(options.concurrency, items.length)) },
      lane,
    ),
  );
  return results;
}

/**
 * Every enabled source that is due, oldest first, at most `limit`, a few at a
 * time and within the pass's start budget: one folder on a server that
 * trickles its bytes no longer holds every other account's folder back.
 */
export async function fetchDueRemoteSources(
  now: Date = new Date(),
  limit = 20,
): Promise<Record<RemoteOutcome, number>> {
  const due = await prisma.healthConnectRemoteSource.findMany({
    where: {
      enabled: true,
      nextAttemptAt: { lte: now },
      ...OWNED_BY_ACTIVE_ACCOUNT,
    },
    orderBy: { nextAttemptAt: "asc" },
    take: limit,
    select: SOURCE_SELECT,
  });
  const outcomes = await runWithinBudget(
    due,
    {
      concurrency: REMOTE_FETCH_CONCURRENCY,
      deadline: Date.now() + REMOTE_FETCH_START_BUDGET_MS,
    },
    (source) => fetchRemoteSource(source, now),
  );
  const counts = {} as Record<RemoteOutcome, number>;
  for (const outcome of outcomes) {
    counts[outcome] = (counts[outcome] ?? 0) + 1;
  }
  annotate({
    meta: { remote_due: due.length, remote_read: outcomes.length },
  });
  return counts;
}

/** One account's source, now, whatever its schedule (the "fetch now" act). */
export async function fetchRemoteSourceNow(
  userId: string,
): Promise<RemoteOutcome | null> {
  const source = await prisma.healthConnectRemoteSource.findUnique({
    where: { userId },
    select: SOURCE_SELECT,
  });
  return source ? fetchRemoteSource(source) : null;
}
