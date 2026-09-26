#!/usr/bin/env node
/**
 * Copy documents from Paperless-ngx or Papra into the HealthLog document vault.
 *
 * Runs wherever you are, not inside the HealthLog container: it talks to two
 * HTTP APIs and needs nothing but Node 22 (no dependencies, no install).
 *
 *   node import-documents.mjs paperless --paperless-url https://paperless.lan \
 *     --healthlog-url https://health.example --tag HealthLog
 *
 *   node import-documents.mjs papra --papra-url https://papra.lan \
 *     --papra-org <organization id> --healthlog-url https://health.example \
 *     --tag Health
 *
 * Credentials come from the environment, never from flags (flags end up in
 * shell history):
 *
 *   HEALTHLOG_TOKEN   a document token from HealthLog Settings > API & Tokens
 *   PAPERLESS_TOKEN   a Paperless-ngx API token (My Profile)
 *   PAPRA_TOKEN       a Papra API key with documents:read and tags:read
 *
 * Options:
 *   --tag <name>          only documents carrying this tag (recommended)
 *   --since YYYY-MM-DD    only documents dated on or after this day
 *   --kind <KIND>         document type for everything imported
 *   --kind-map "A=KIND,B=KIND"
 *                         type by Paperless document type or Papra tag name;
 *                         anything unmatched gets --kind, or HealthLog's OTHER
 *   --dry-run             list what would be imported, with sizes; send nothing
 *   --ai-read             let HealthLog read the documents with AI as they
 *                         arrive (by default automatic reading is held back)
 *   --help                this text
 *
 * One document at a time, one file in memory at a time. A document that is
 * already in HealthLog, or that you deleted there, is skipped by HealthLog
 * itself, so running the script again is safe and simply picks up where it
 * stopped. HealthLog's rate limit answers 429 with Retry-After; the script
 * waits and carries on.
 */
import { parseArgs } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";

const KINDS = [
  "DOCTOR_REPORT",
  "DISCHARGE_LETTER",
  "LAB_RESULT",
  "IMAGING",
  "PRESCRIPTION",
  "REFERRAL",
  "INSURANCE",
  "VACCINATION",
  "OTHER",
];
const TITLE_MAX = 200;
const SOURCE_ID_MAX = 128;
const PAGE_SIZE = 100;
/** Attempts for a server error or a dropped connection, per request. */
const TRANSIENT_ATTEMPTS = 3;
const TRANSIENT_BACKOFF_MS = [5_000, 15_000, 45_000];
/** Longest single wait we accept from a Retry-After header, in seconds. */
const MAX_RETRY_AFTER_S = 3_600;

class StopError extends Error {}

const out = (line = "") => process.stdout.write(`${line}\n`);
const err = (line) => process.stderr.write(`${line}\n`);

function usage() {
  const text = [];
  let inside = false;
  for (const line of SELF_DOC.split("\n")) {
    if (line.startsWith("/**")) inside = true;
    else if (line.startsWith(" */")) break;
    else if (inside) text.push(line.replace(/^ \* ?/, ""));
  }
  return text.join("\n");
}

// ── Arguments ──────────────────────────────────────────────────────────────

function readOptions(argv, env) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      "healthlog-url": { type: "string" },
      "paperless-url": { type: "string" },
      "papra-url": { type: "string" },
      "papra-org": { type: "string" },
      tag: { type: "string" },
      since: { type: "string" },
      kind: { type: "string" },
      "kind-map": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "ai-read": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) return { help: true };

  const source = positionals[0];
  if (source !== "paperless" && source !== "papra") {
    throw new StopError(
      'Name the source first: "paperless" or "papra". Run with --help for the options.',
    );
  }
  const dryRun = values["dry-run"];
  const healthlogUrl = trimSlash(values["healthlog-url"] ?? env.HEALTHLOG_URL);
  if (!dryRun && !healthlogUrl) {
    throw new StopError("--healthlog-url is required (or HEALTHLOG_URL).");
  }
  if (!dryRun && !env.HEALTHLOG_TOKEN) {
    throw new StopError(
      "HEALTHLOG_TOKEN is not set. Create a document token in HealthLog under Settings > API & Tokens.",
    );
  }
  if (values.since && !/^\d{4}-\d{2}-\d{2}$/.test(values.since)) {
    throw new StopError("--since expects a date as YYYY-MM-DD.");
  }
  const kind = values.kind ? checkKind(values.kind, "--kind") : null;
  const kindMap = new Map();
  if (values["kind-map"]) {
    for (const pair of values["kind-map"].split(",")) {
      const at = pair.lastIndexOf("=");
      if (at <= 0)
        throw new StopError(`--kind-map: "${pair}" is not NAME=KIND.`);
      kindMap.set(
        pair.slice(0, at).trim().toLowerCase(),
        checkKind(pair.slice(at + 1).trim(), "--kind-map"),
      );
    }
  }

  const options = {
    source,
    healthlogUrl,
    healthlogToken: env.HEALTHLOG_TOKEN ?? "",
    tag: values.tag ?? null,
    since: values.since ?? null,
    kind,
    kindMap,
    dryRun,
    aiRead: values["ai-read"],
  };
  if (source === "paperless") {
    options.baseUrl = trimSlash(values["paperless-url"] ?? env.PAPERLESS_URL);
    options.sourceToken = env.PAPERLESS_TOKEN;
    if (!options.baseUrl) throw new StopError("--paperless-url is required.");
    if (!options.sourceToken)
      throw new StopError("PAPERLESS_TOKEN is not set.");
  } else {
    options.baseUrl = trimSlash(values["papra-url"] ?? env.PAPRA_URL);
    options.organizationId = values["papra-org"] ?? env.PAPRA_ORG;
    options.sourceToken = env.PAPRA_TOKEN;
    if (!options.baseUrl) throw new StopError("--papra-url is required.");
    if (!options.organizationId) {
      throw new StopError(
        "--papra-org is required: the organization id from the Papra address bar.",
      );
    }
    if (!options.sourceToken) throw new StopError("PAPRA_TOKEN is not set.");
  }
  return options;
}

function checkKind(value, flag) {
  const upper = value.toUpperCase();
  if (!KINDS.includes(upper)) {
    throw new StopError(
      `${flag}: "${value}" is not one of ${KINDS.join(", ")}.`,
    );
  }
  return upper;
}

function trimSlash(url) {
  return url ? url.replace(/\/+$/, "") : url;
}

// ── HTTP ───────────────────────────────────────────────────────────────────

function retryAfterSeconds(response, fallback) {
  const raw = response.headers.get("retry-after");
  if (!raw) return fallback;
  const seconds = Number(raw);
  if (Number.isFinite(seconds))
    return Math.min(Math.max(0, seconds), MAX_RETRY_AFTER_S);
  const at = Date.parse(raw);
  if (Number.isFinite(at)) {
    return Math.min(
      Math.max(0, Math.ceil((at - Date.now()) / 1000)),
      MAX_RETRY_AFTER_S,
    );
  }
  return fallback;
}

/**
 * Fetch with the waiting rules shared by all three services: a 429 waits for
 * Retry-After and tries again (as often as it takes, since that is the
 * service pacing us), a 5xx or a dropped connection is retried a few times
 * with a growing pause, and anything else is returned to the caller.
 */
async function request(label, url, init, makeBody, { waitOn429 = true } = {}) {
  let transient = 0;
  for (;;) {
    let response;
    try {
      response = await fetch(url, {
        ...init,
        body: makeBody ? makeBody() : undefined,
        redirect: "manual",
      });
    } catch (cause) {
      if (transient >= TRANSIENT_ATTEMPTS) {
        throw new Error(`${label}: could not connect (${cause.message})`);
      }
      await wait(TRANSIENT_BACKOFF_MS[transient++], `${label} did not answer`);
      continue;
    }
    if (response.status === 429 && waitOn429) {
      await response.arrayBuffer().catch(() => {});
      const seconds = retryAfterSeconds(response, 60);
      await wait(seconds * 1000, `${label} asked to slow down`);
      continue;
    }
    if (response.status >= 500 || response.status === 408) {
      await response.arrayBuffer().catch(() => {});
      if (transient >= TRANSIENT_ATTEMPTS) return response;
      await wait(
        TRANSIENT_BACKOFF_MS[transient++],
        `${label} answered ${response.status}`,
      );
      continue;
    }
    return response;
  }
}

async function wait(ms, why) {
  if (ms > 0) out(`  … ${why}, waiting ${Math.round(ms / 1000)} s`);
  await sleep(ms);
}

async function sourceJson(label, url, headers) {
  const response = await request(label, url, { headers });
  if (response.status === 401 || response.status === 403) {
    throw new StopError(
      `${label} refused the token (${response.status}). Check the token and its permissions.`,
    );
  }
  if (!response.ok) {
    throw new StopError(`${label} answered ${response.status} for ${url}`);
  }
  return response.json();
}

/** Keep the source's own origin: a `next` link behind a proxy may name another. */
function sameOrigin(base, link) {
  const next = new URL(link, base);
  const origin = new URL(base);
  next.protocol = origin.protocol;
  next.host = origin.host;
  return next.toString();
}

function filenameFrom(response, fallback) {
  const header = response.headers.get("content-disposition") ?? "";
  const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ""));
    } catch {
      /* fall through */
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain ? plain[1] : fallback;
}

// ── Paperless-ngx ──────────────────────────────────────────────────────────

function paperless(options) {
  const headers = {
    Authorization: `Token ${options.sourceToken}`,
    // API version 9 (Paperless-ngx 2.16 and later): the lowest the current
    // servers still accept, and the one where `created` became a plain date.
    Accept: "application/json; version=9",
  };
  const base = options.baseUrl;
  const label = "Paperless-ngx";

  async function* pages(firstUrl) {
    let url = firstUrl;
    while (url) {
      const page = await sourceJson(label, url, headers);
      for (const item of page.results ?? []) yield item;
      url = page.next ? sameOrigin(base, page.next) : null;
    }
  }

  return {
    system: "PAPERLESS",
    label,
    async *documents() {
      const query = new URLSearchParams({
        page_size: String(PAGE_SIZE),
        ordering: "id",
      });
      let tagId = null;
      if (options.tag) {
        const found = [];
        for await (const tag of pages(
          `${base}/api/tags/?${new URLSearchParams({ name__iexact: options.tag, page_size: String(PAGE_SIZE) })}`,
        )) {
          if (String(tag.name).toLowerCase() === options.tag.toLowerCase())
            found.push(tag);
        }
        if (found.length === 0) {
          throw new StopError(
            `Paperless-ngx has no tag named "${options.tag}".`,
          );
        }
        tagId = found[0].id;
        query.set("tags__id__all", String(tagId));
      }
      if (options.since) query.set("created__date__gte", options.since);

      let typeNames = new Map();
      if (options.kindMap.size > 0) {
        for await (const type of pages(
          `${base}/api/document_types/?page_size=${PAGE_SIZE}`,
        )) {
          typeNames.set(type.id, String(type.name));
        }
      }

      for await (const doc of pages(`${base}/api/documents/?${query}`)) {
        // The server filters too; checking again keeps an older Paperless
        // that ignores a parameter from importing the whole archive.
        if (
          tagId !== null &&
          Array.isArray(doc.tags) &&
          !doc.tags.includes(tagId)
        ) {
          continue;
        }
        const created = dayOf(doc.created);
        const added = dayOf(doc.added);
        const date = created ?? added;
        // Checked here as well: an older server may ignore the date filter.
        if (options.since && date && date < options.since) continue;
        yield {
          sourceId: String(doc.id),
          title: titleOf(
            doc.title,
            doc.original_file_name,
            `Paperless ${doc.id}`,
          ),
          date,
          dateFallback: created ? null : added ? "added" : "none",
          filename: doc.original_file_name ?? null,
          kindKeys:
            doc.document_type != null && typeNames.has(doc.document_type)
              ? [typeNames.get(doc.document_type)]
              : [],
          size: null,
        };
      }
    },
    async size(doc) {
      const meta = await sourceJson(
        label,
        `${base}/api/documents/${encodeURIComponent(doc.sourceId)}/metadata/`,
        headers,
      );
      return typeof meta.original_size === "number" ? meta.original_size : null;
    },
    async download(doc) {
      const response = await request(
        label,
        `${base}/api/documents/${encodeURIComponent(doc.sourceId)}/download/?original=true`,
        { headers: { Authorization: headers.Authorization } },
      );
      return readDownload(label, response, doc);
    },
  };
}

// ── Papra ──────────────────────────────────────────────────────────────────

function papra(options) {
  const headers = {
    Authorization: `Bearer ${options.sourceToken}`,
    Accept: "application/json",
  };
  const org = `${options.baseUrl}/api/organizations/${encodeURIComponent(options.organizationId)}`;
  const label = "Papra";

  return {
    system: "PAPRA",
    label,
    async *documents() {
      let tagId = null;
      if (options.tag) {
        const body = await sourceJson(label, `${org}/tags`, headers);
        const tag = (body.tags ?? []).find(
          (t) => String(t.name).toLowerCase() === options.tag.toLowerCase(),
        );
        if (!tag)
          throw new StopError(`Papra has no tag named "${options.tag}".`);
        tagId = tag.id;
      }
      const search = options.tag
        ? `tag:${/\s/.test(options.tag) ? JSON.stringify(options.tag) : options.tag}`
        : "";
      for (let pageIndex = 0; ; pageIndex++) {
        const query = new URLSearchParams({
          pageIndex: String(pageIndex),
          pageSize: String(PAGE_SIZE),
        });
        if (search) query.set("searchQuery", search);
        const body = await sourceJson(
          label,
          `${org}/documents?${query}`,
          headers,
        );
        const documents = body.documents ?? [];
        for (const doc of documents) {
          const tags = Array.isArray(doc.tags) ? doc.tags : null;
          if (tagId !== null && tags && !tags.some((t) => t.id === tagId))
            continue;
          const documentDate = dayOf(doc.documentDate);
          const created = dayOf(doc.createdAt);
          const date = documentDate ?? created;
          // Papra's search dates differ between versions; the date is
          // checked here instead of trusting a query syntax.
          if (options.since && date && date < options.since) continue;
          yield {
            sourceId: String(doc.id),
            title: titleOf(
              stripExtension(doc.name),
              doc.originalName,
              `Papra ${doc.id}`,
            ),
            date,
            dateFallback: documentDate ? null : created ? "added" : "none",
            filename: doc.originalName ?? doc.name ?? null,
            kindKeys: (tags ?? []).map((t) => String(t.name)),
            size:
              typeof doc.originalSize === "number" ? doc.originalSize : null,
          };
        }
        const total =
          typeof body.documentsCount === "number" ? body.documentsCount : null;
        if (documents.length < PAGE_SIZE) break;
        if (total !== null && (pageIndex + 1) * PAGE_SIZE >= total) break;
      }
    },
    async size(doc) {
      return doc.size;
    },
    async download(doc) {
      const response = await request(
        label,
        `${org}/documents/${encodeURIComponent(doc.sourceId)}/file`,
        { headers: { Authorization: headers.Authorization } },
      );
      return readDownload(label, response, doc);
    },
  };
}

async function readDownload(label, response, doc) {
  if (response.status === 401 || response.status === 403) {
    throw new StopError(`${label} refused the download (${response.status}).`);
  }
  if (!response.ok) {
    return { skip: `${label} could not deliver the file (${response.status})` };
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  return {
    bytes,
    filename:
      doc.filename ?? filenameFrom(response, `document-${doc.sourceId}`),
    type: response.headers.get("content-type") ?? "application/octet-stream",
  };
}

function dayOf(value) {
  if (typeof value !== "string") return null;
  const day = value.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

/**
 * A title that is not blank: the source's title, else its file name without
 * the extension, else a placeholder naming the source id. HealthLog refuses a
 * blank title.
 */
function titleOf(title, filename, fallback) {
  return (
    (typeof title === "string" ? title.trim() : "") ||
    stripExtension(filename).trim() ||
    fallback
  );
}

function stripExtension(name) {
  if (typeof name !== "string") return "";
  return name.replace(/\.[A-Za-z0-9]{1,5}$/, "");
}

// ── HealthLog ──────────────────────────────────────────────────────────────

function kindFor(options, doc) {
  for (const key of doc.kindKeys) {
    const mapped = options.kindMap.get(key.toLowerCase());
    if (mapped) return mapped;
  }
  return options.kind;
}

/** The source key as query parameters, which HealthLog reads before the body. */
function keyQuery(source, doc) {
  return new URLSearchParams({
    sourceSystem: source.system,
    sourceId: doc.sourceId.slice(0, SOURCE_ID_MAX),
  });
}

async function readBody(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** Refusals that end the run, whichever HealthLog request met them. */
function stopOnRefusal(response, body, url) {
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    throw new StopError(
      `The HealthLog address redirects${location ? ` to ${new URL(location, url).origin}` : ""}. Use that address with --healthlog-url.`,
    );
  }
  if (response.status === 401) {
    throw new StopError(
      "HealthLog refused the token (401). It may be expired or revoked; create a new document token.",
    );
  }
  if (response.status === 403) {
    if (body?.meta?.errorCode === "module.disabled") {
      throw new StopError(
        "The document vault is switched off in HealthLog. Turn on Documents in Settings, then run the script again.",
      );
    }
    throw new StopError(
      "HealthLog refused the request (403). Use a document token from Settings > API & Tokens; other tokens cannot upload documents.",
    );
  }
}

/**
 * Ask HealthLog whether it already holds this document, before downloading
 * it from the source. Null when the answer is "no", or when the HealthLog
 * version has no lookup yet (the upload then decides, as before).
 */
async function lookup(options, source, doc) {
  const url = `${options.healthlogUrl}/api/documents/inbound/source?${keyQuery(source, doc)}`;
  // Not worth waiting for: if the lookups are spent, the upload with the key
  // answers the same question.
  const response = await request(
    "HealthLog",
    url,
    {
      headers: {
        Authorization: `Bearer ${options.healthlogToken}`,
        Accept: "application/json",
      },
    },
    undefined,
    { waitOn429: false },
  );
  const body = await readBody(response);
  stopOnRefusal(response, body, url);
  if (!response.ok || !body?.data?.known) return null;
  return body.data.deleted ? { outcome: "deleted" } : { outcome: "duplicate" };
}

async function upload(options, source, doc, file) {
  // The key goes in the form only. In the address HealthLog would check it
  // against the lookup allowance first, and the lookup just asked that
  // question; when the lookups are spent, the upload would then be refused
  // with a 429 as well. In the form it costs one upload, like any other.
  const url = `${options.healthlogUrl}/api/documents/inbound`;
  const kind = kindFor(options, doc);
  const response = await request(
    "HealthLog",
    url,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${options.healthlogToken}` },
    },
    // Rebuilt per attempt: a body stream is spent once it has been sent.
    () => {
      const form = new FormData();
      form.append(
        "file",
        new Blob([file.bytes], { type: file.type }),
        file.filename,
      );
      form.append("title", doc.title.slice(0, TITLE_MAX));
      if (doc.date) form.append("documentDate", doc.date);
      if (kind) form.append("kind", kind);
      if (!options.aiRead) form.append("aiRead", "defer");
      form.append("sourceSystem", source.system);
      form.append("sourceId", doc.sourceId.slice(0, SOURCE_ID_MAX));
      return form;
    },
  );

  const body = await readBody(response);
  stopOnRefusal(response, body, url);
  const meta = body?.meta ?? {};
  switch (response.status) {
    case 201:
      return { outcome: "imported" };
    case 200:
      return body?.data?.deleted
        ? { outcome: "deleted" }
        : { outcome: "duplicate" };
    case 413:
      if (meta.reason === "quotaExceeded") {
        throw new StopError(
          "Your HealthLog storage is full. An admin can raise the limit in the admin area, for everyone or just for your account.",
        );
      }
      return {
        outcome: "skipped",
        reason: `larger than HealthLog accepts${meta.maxFileBytes ? ` (${mib(meta.maxFileBytes)})` : ""}`,
      };
    case 415:
      return {
        outcome: "skipped",
        reason: "HealthLog does not accept this file type",
      };
    case 422:
      return {
        outcome: "skipped",
        reason: `HealthLog refused the details: ${body?.error ?? "invalid"}`,
      };
    default:
      return {
        outcome: "skipped",
        reason: `HealthLog answered ${response.status}${body?.error ? `: ${body.error}` : ""}`,
      };
  }
}

function mib(bytes) {
  if (typeof bytes !== "number") return "?";
  return bytes >= 1024 * 1024 * 1024
    ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
    : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

// ── Run ────────────────────────────────────────────────────────────────────

async function run(argv, env = process.env) {
  let options;
  try {
    options = readOptions(argv, env);
  } catch (error) {
    if (
      error instanceof StopError ||
      error?.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION"
    ) {
      err(error.message);
      return 2;
    }
    throw error;
  }
  if (options.help) {
    out(usage());
    return 0;
  }

  const source =
    options.source === "paperless" ? paperless(options) : papra(options);
  const tally = {
    imported: 0,
    duplicate: 0,
    deleted: 0,
    skipped: [],
    fallback: [],
  };
  let listed = 0;
  let totalBytes = 0;
  let unknownSizes = 0;

  out(
    `${options.dryRun ? "Dry run: listing" : "Importing"} documents from ${source.label}` +
      `${options.tag ? ` tagged "${options.tag}"` : ""}${options.since ? ` since ${options.since}` : ""}.`,
  );

  try {
    for await (const doc of source.documents()) {
      listed++;
      const where = `${source.label} ${doc.sourceId} "${doc.title}"`;
      if (doc.dateFallback)
        tally.fallback.push({ where, dateFallback: doc.dateFallback });

      if (options.dryRun) {
        const size = await source.size(doc);
        if (size === null) unknownSizes++;
        else totalBytes += size;
        const kind = kindFor(options, doc) ?? "OTHER";
        out(
          `  ${doc.date ?? "no date"}  ${kind.padEnd(16)} ${size === null ? "?" : mib(size)}  ${where}`,
        );
        continue;
      }

      // Asked first so a document HealthLog already holds is not downloaded.
      const known = await lookup(options, source, doc);
      if (known) {
        if (known.outcome === "duplicate") {
          tally.duplicate++;
          out(`  present   ${where}`);
        } else {
          tally.deleted++;
          out(`  deleted   ${where} (you deleted it in HealthLog; left alone)`);
        }
        continue;
      }

      const file = await source.download(doc);
      if (file.skip) {
        tally.skipped.push({ where, reason: file.skip });
        out(`  skipped   ${where}: ${file.skip}`);
        continue;
      }
      const result = await upload(options, source, doc, file);
      if (result.outcome === "imported") {
        tally.imported++;
        out(`  imported  ${where}`);
      } else if (result.outcome === "duplicate") {
        tally.duplicate++;
        out(`  present   ${where}`);
      } else if (result.outcome === "deleted") {
        tally.deleted++;
        out(`  deleted   ${where} (you deleted it in HealthLog; left alone)`);
      } else {
        tally.skipped.push({ where, reason: result.reason });
        out(`  skipped   ${where}: ${result.reason}`);
      }
    }
  } catch (error) {
    printSummary(options, tally, listed, totalBytes, unknownSizes);
    err("");
    err(`Stopped: ${error.message}`);
    return 1;
  }

  printSummary(options, tally, listed, totalBytes, unknownSizes);
  return tally.skipped.length > 0 ? 3 : 0;
}

function printSummary(options, tally, listed, totalBytes, unknownSizes) {
  out("");
  if (options.dryRun) {
    out(
      `${listed} document(s) would be imported, about ${mib(totalBytes)}` +
        `${unknownSizes > 0 ? ` (size unknown for ${unknownSizes})` : ""}.`,
    );
    out(
      "HealthLog's default storage limit is 1 GB per person; an admin can raise it.",
    );
    out(
      "Documents already in HealthLog, or deleted there, will be skipped by HealthLog.",
    );
  } else {
    out(`Imported: ${tally.imported}`);
    out(`Already in HealthLog: ${tally.duplicate}`);
    out(`Deleted in HealthLog, left alone: ${tally.deleted}`);
    out(`Skipped: ${tally.skipped.length}`);
    for (const { where, reason } of tally.skipped) out(`  ${where}: ${reason}`);
  }
  if (tally.fallback.length > 0) {
    out(
      `No document date in the source for ${tally.fallback.length} document(s):`,
    );
    for (const { where, dateFallback } of tally.fallback) {
      out(
        dateFallback === "added"
          ? `  ${where}: filed under the day it was added to the source`
          : `  ${where}: filed under the day of import`,
      );
    }
  }
  if (!options.dryRun && tally.imported > 0 && !options.aiRead) {
    out(
      `${tally.imported} document(s) imported without automatic AI reading. ` +
        "To have one read, open it in HealthLog and choose Read with AI or Generate summary.",
    );
  }
}

const SELF_DOC = await (async () => {
  const { readFile } = await import("node:fs/promises");
  return readFile(new URL(import.meta.url), "utf8");
})();

process.exitCode = await run(process.argv.slice(2));
