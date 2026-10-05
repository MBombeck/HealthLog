/**
 * Document-vault e2e fixture — seeded straight through Postgres (`pg`, the
 * same transport `global-setup.ts` uses) because the doctor-flow script
 * needs 60 documents and the upload endpoint's per-user rate bucket is
 * 60/hour: seeding through the API would burn the whole budget before the
 * first genuine upload test runs, and the two Playwright projects (desktop
 * + mobile) each re-run the seed.
 *
 * The seed is deterministic and idempotent:
 *   - fixed row ids (`e2evault…`), upserted with `ON CONFLICT (id) DO
 *     UPDATE` so a re-run self-heals whatever a previous run mutated;
 *   - per-document unique plaintext (an id marker inside the bytes) so the
 *     `(user_id, content_sha256)` live-dedupe partial unique index never
 *     trips across rows;
 *   - blobs encrypted with the SAME binary2 layout the server writes
 *     (`[0x02][keyIdLen][keyId][iv 12][tag 16][ciphertext]`, AES-256-GCM
 *     under the env key), so the serve route decrypts and previews them
 *     like real uploads.
 *
 * Corpus (mirrors the plan's §1A doctor-flow seed): 60 documents across
 * 3 years, one IllnessEpisode "Knie", an MRI report (IMAGING, "MRT Knie",
 * last autumn, linked to Knie) plus two adjacent image documents on the
 * same date and link. `seedNamespaceDocs` adds disposable per-test
 * namespaces (bulk flows) that never collide with the doctor-flow corpus.
 */
import {
  createCipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
} from "node:crypto";

import pg from "pg";

import { E2E_USER } from "./global-setup";

// ─── binary2 codec (mirrors src/lib/crypto.ts encryptBytes) ────────────────

function resolveActiveKey(): { id: string; key: Buffer } {
  const mapRaw = process.env.ENCRYPTION_KEYS;
  if (mapRaw) {
    const map = JSON.parse(mapRaw) as Record<string, string>;
    const id =
      process.env.ENCRYPTION_ACTIVE_KEY_ID ?? Object.keys(map)[0] ?? "v1";
    const hex = map[id];
    if (!hex) {
      throw new Error(`[vault-fixture] key id '${id}' not in ENCRYPTION_KEYS`);
    }
    return { id, key: Buffer.from(hex, "hex") };
  }
  const legacy = process.env.ENCRYPTION_KEY;
  if (!legacy) {
    throw new Error(
      "[vault-fixture] neither ENCRYPTION_KEYS nor ENCRYPTION_KEY is set",
    );
  }
  return { id: "v1", key: Buffer.from(legacy, "hex") };
}

function encryptBinary2(plaintext: Buffer): Buffer {
  const { id, key } = resolveActiveKey();
  const keyId = Buffer.from(id, "ascii");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([
    Buffer.from([0x02, keyId.byteLength]),
    keyId,
    iv,
    tag,
    ct,
  ]);
}

/**
 * Encrypt a plaintext string into the `encrypt()`-string-as-UTF-8 Bytes shape
 * the content index stores `text_encrypted` in (`<keyId>.<base64(iv|tag|ct)>`
 * → UTF-8 bytes). Mirrors src/lib/crypto.ts `encrypt` + the coach bytes codec.
 */
function encryptStringToBytes(plaintext: string): Buffer {
  const { id, key } = resolveActiveKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload = Buffer.concat([iv, tag, enc]).toString("base64");
  return Buffer.from(`${id}.${payload}`, "utf8");
}

// ─── Blind content-index tokens (mirrors src/lib/documents/content-index) ────
//
// HKDF-derived index subkey off the ACTIVE encryption key + domain label, then
// each normalised token HMAC-SHA256'd and truncated to a 16-char hex tag. The
// server hashes a search query the same way, so a body-only word seeded here is
// findable through the real GIN union without ever storing the word in clear.

const CONTENT_INDEX_INFO = "healthlog:document-content-index:v1";

function indexSubkey(): Buffer {
  const { key } = resolveActiveKey();
  return Buffer.from(
    hkdfSync("sha256", key, new Uint8Array(0), CONTENT_INDEX_INFO, 32),
  );
}

/** Tokenise like the server: NFKD de-accent, lowercase, alnum runs, len 3..64.
 *  The seeded words are deliberately non-stopwords, so the stopword drop the
 *  server also applies is a no-op here and the tag sets match exactly. */
function tokenise(text: string): string[] {
  const normalised = text
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
  const seen = new Set<string>();
  for (const raw of normalised.split(/[^\p{L}\p{N}]+/u)) {
    const token = raw.trim();
    if (token.length < 3 || token.length > 64) continue;
    seen.add(token);
  }
  return [...seen];
}

function tokeniseAndHash(text: string): string[] {
  const subkey = indexSubkey();
  const hashes = new Set<string>();
  for (const token of tokenise(text)) {
    hashes.add(
      createHmac("sha256", subkey)
        .update(token, "utf8")
        .digest("hex")
        .slice(0, 16),
    );
  }
  return [...hashes];
}

// ─── Deterministic tiny documents ───────────────────────────────────────────

/** Minimal single-page PDF; `marker` lands in a comment so every doc's bytes
 *  (and therefore sha256) are unique. */
function tinyPdf(marker: string): Buffer {
  return Buffer.from(
    `%PDF-1.4\n%${marker}\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n` +
      `2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n` +
      `3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n` +
      `xref\n0 4\ntrailer<</Size 4/Root 1 0 R>>\n%%EOF\n`,
    "utf8",
  );
}

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABXvMqOgAAAABJRU5ErkJggg==",
  "base64",
);

/** 1×1 PNG + a trailing marker (decoders ignore bytes past IEND). */
function tinyPng(marker: string): Buffer {
  return Buffer.concat([PNG_1X1, Buffer.from(marker, "utf8")]);
}

/**
 * A minimal JPEG carrying a GPS marker inside an APP1 (Exif) segment so the
 * share serve route's egress EXIF strip is observable end-to-end: the stored
 * bytes contain `GPSLatitude`, the served bytes must not. SOI → APP1(Exif) →
 * SOS(+entropy). Not a decodable photo — the serve route sniffs the STORED
 * mime type, never re-decodes pixels, so this is enough to exercise the strip.
 */
function jpegWithGps(marker: string): Buffer {
  const payload = Buffer.concat([
    Buffer.from("Exif\0\0"),
    Buffer.from(`GPSLatitude=48.137 ${marker}`),
  ]);
  const lenField = Buffer.alloc(2);
  lenField.writeUInt16BE(payload.length + 2);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), lenField, payload]);
  const sos = Buffer.concat([
    Buffer.from([0xff, 0xda]),
    Buffer.from([0x00, 0x08]),
    Buffer.from([0x01, 0x01, 0x00, 0x3f, 0x00, 0x00]),
    Buffer.from([0xaa, 0xbb]),
  ]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, sos]);
}

// ─── Fixture identity ───────────────────────────────────────────────────────

export const KNIE_EPISODE_ID = "e2evaultknie000000000001";
export const MRT_DOC_ID = "e2evaultmrt0000000000001";
/** A stored PDF the AI-assist specs drive (mocked provider); title/kind are
 *  bland so an applied suggestion is visibly different. */
export const AI_PROBE_DOC_ID = "e2evaultaiprobe000000001";
/** A stored document whose searchable body word lives ONLY in its content
 *  index — never in the title or filename — so content search is the only
 *  route to it. */
export const CONTENT_DOC_ID = "e2evaultcontent00000001";
/** The whole word that appears only in `CONTENT_DOC_ID`'s indexed body. */
export const CONTENT_BODY_WORD = "pneumothorax";

/**
 * v1.28 (Phase 3) — a fixed trio the clinician-share e2e attaches to a link and
 * serves through the public `/c/<token>/d/<id>` route:
 *   - a PDF (Class A, inline preview via <iframe>),
 *   - a JPEG carrying an Exif GPS marker (Class A image, inline <img>; the
 *     serve route strips the marker on egress — the stored bytes keep it),
 *   - a text/plain document (Class B, download-only opaque attachment).
 * Titles carry the `Share e2e` prefix so the owner picker's search isolates
 * exactly this set. Idempotent (fixed ids upserted).
 */
export const SHARE_PDF_DOC_ID = "e2eshare0000000000000pdf";
export const SHARE_JPEG_DOC_ID = "e2eshare000000000000jpeg";
export const SHARE_TEXT_DOC_ID = "e2eshare000000000000text";
export const SHARE_DOC_PREFIX = "Share e2e";
/** Filing date of the MRT report — "last autumn" relative to the fixture. */
const MRT_DOC_DATE = "2025-10-14";

const FIXTURE_KINDS = [
  "DOCTOR_REPORT",
  "LAB_RESULT",
  "PRESCRIPTION",
  "IMAGING",
  "OTHER",
  "DISCHARGE_LETTER",
  "INSURANCE",
] as const;

interface DocRow {
  id: string;
  kind: string;
  title: string;
  filename: string;
  mimeType: string;
  documentDate: string; // YYYY-MM-DD
  bytes: Buffer;
}

/**
 * Advisory-lock key that serialises the vault-fixture seeders across Playwright
 * workers. `fullyParallel: true` spreads a spec's tests across workers and each
 * worker re-runs the file's `beforeAll`; two workers seeding at once race on the
 * fixed-id inserts, and `ON CONFLICT` only suppresses a conflict on its named
 * arbiter index — a concurrent duplicate on a DIFFERENT unique index (e.g. the
 * `document_condition_links` primary key) still throws. Holding this lock for the
 * span of a seeder makes the concurrent runs sequential, so every insert re-runs
 * as a clean idempotent upsert.
 */
const VAULT_SEED_LOCK_KEY = 792244;

/**
 * Run `body` while holding the vault-seed advisory lock on a dedicated pooled
 * connection, so concurrent workers seed one-at-a-time. The lock auto-releases
 * if the connection drops; the explicit unlock keeps the pool clean for reuse.
 */
async function withVaultSeedLock(
  pool: pg.Pool,
  body: () => Promise<void>,
): Promise<void> {
  const lock = await pool.connect();
  try {
    await lock.query("SELECT pg_advisory_lock($1)", [VAULT_SEED_LOCK_KEY]);
    await body();
  } finally {
    await lock
      .query("SELECT pg_advisory_unlock($1)", [VAULT_SEED_LOCK_KEY])
      .catch(() => {});
    lock.release();
  }
}

async function getUserId(pool: pg.Pool): Promise<string> {
  const res = await pool.query<{ id: string }>(
    "SELECT id FROM users WHERE username = $1",
    [E2E_USER.username],
  );
  const id = res.rows[0]?.id;
  if (!id) {
    throw new Error(
      "[vault-fixture] e2e user not seeded — global-setup must run first",
    );
  }
  return id;
}

async function upsertDocs(
  pool: pg.Pool,
  userId: string,
  docs: DocRow[],
): Promise<void> {
  for (const doc of docs) {
    const encrypted = encryptBinary2(doc.bytes);
    const sha = createHash("sha256").update(doc.bytes).digest("hex");
    await pool.query(
      `INSERT INTO inbound_documents
        (id, user_id, kind, title, filename, mime_type, byte_size,
         content_encrypted, content_codec, content_sha256, status,
         document_date, created_at, updated_at, deleted_at)
       VALUES ($1, $2, $3::inbound_document_kind, $4, $5, $6, $7,
               $8, 'binary2', $9, 'STORED',
               $10::timestamp, NOW(), NOW(), NULL)
       ON CONFLICT (id) DO UPDATE SET
         user_id = EXCLUDED.user_id,
         kind = EXCLUDED.kind,
         title = EXCLUDED.title,
         filename = EXCLUDED.filename,
         mime_type = EXCLUDED.mime_type,
         byte_size = EXCLUDED.byte_size,
         content_encrypted = EXCLUDED.content_encrypted,
         content_codec = EXCLUDED.content_codec,
         content_sha256 = EXCLUDED.content_sha256,
         document_date = EXCLUDED.document_date,
         status = 'STORED',
         deleted_at = NULL,
         updated_at = NOW()`,
      [
        doc.id,
        userId,
        doc.kind,
        doc.title,
        doc.filename,
        doc.mimeType,
        doc.bytes.byteLength,
        encrypted,
        sha,
        `${doc.documentDate}T00:00:00Z`,
      ],
    );
  }
}

/**
 * Remove the seeded e2e user's visits and their document links.
 *
 * The incidental-linking spec asserts a GLOBAL verdict — "exactly one visit
 * falls in this document's ±7-day window" — so it must own the window it counts
 * against. A visit created by an earlier run, a Playwright retry, or a second
 * project sharing the account would leave two rows in the window and turn the
 * single-candidate branch into the picker branch. Clearing first makes the
 * count the test creates the only count it reads. `encounter_document_links`
 * goes first for the FK; both are user-scoped.
 */
export async function resetEncounters(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("[vault-fixture] DATABASE_URL is not set");
  const pool = new pg.Pool({ connectionString: url });
  try {
    const userId = await getUserId(pool);
    await pool.query(
      "DELETE FROM encounter_document_links WHERE user_id = $1",
      [userId],
    );
    await pool.query("DELETE FROM encounters WHERE user_id = $1", [userId]);
  } finally {
    await pool.end();
  }
}

/**
 * Enable the vault module for the seeded e2e user and plant the doctor-flow
 * corpus. Safe to call from every spec's beforeAll — every statement
 * upserts.
 */
export async function ensureVaultFixture(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("[vault-fixture] DATABASE_URL is not set");
  const pool = new pg.Pool({ connectionString: url });
  try {
    await withVaultSeedLock(pool, async () => {
      const userId = await getUserId(pool);

      // Opt-in module: merge, never overwrite other module preferences.
      await pool.query(
        `UPDATE users
       SET module_preferences_json =
         COALESCE(module_preferences_json, '{}'::jsonb)
         || '{"inboundDocuments": true}'::jsonb
       WHERE id = $1`,
        [userId],
      );

      // The "Knie" condition episode the MRT report files under.
      await pool.query(
        `INSERT INTO illness_episodes
        (id, user_id, label, type, lifecycle, onset_at, created_at, updated_at)
       VALUES ($1, $2, 'Knie', 'INJURY', 'ACUTE', '2025-09-01T00:00:00Z', NOW(), NOW())
       ON CONFLICT (id) DO UPDATE SET
         label = EXCLUDED.label, deleted_at = NULL, updated_at = NOW()`,
        [KNIE_EPISODE_ID, userId],
      );

      // 60 background documents spread over 36 months (newest ~current).
      const docs: DocRow[] = [];
      for (let i = 0; i < 60; i++) {
        const monthsBack = Math.floor((i * 36) / 60);
        const anchor = new Date(Date.UTC(2026, 5 - monthsBack, 1 + (i % 25)));
        const id = `e2evaultdoc${String(i).padStart(12, "0")}`;
        docs.push({
          id,
          kind: FIXTURE_KINDS[i % FIXTURE_KINDS.length],
          title: `Befund ${String(i + 1).padStart(2, "0")}`,
          filename: `befund-${i + 1}.pdf`,
          mimeType: "application/pdf",
          documentDate: anchor.toISOString().slice(0, 10),
          bytes: tinyPdf(id),
        });
      }
      // The MRT report + two adjacent images, same date, all linked to Knie.
      docs.push({
        id: MRT_DOC_ID,
        kind: "IMAGING",
        title: "MRT Knie",
        filename: "mrt-knie.pdf",
        mimeType: "application/pdf",
        documentDate: MRT_DOC_DATE,
        bytes: tinyPdf(MRT_DOC_ID),
      });
      for (const n of [1, 2]) {
        docs.push({
          id: `e2evaultimg000000000000${n}`,
          kind: "IMAGING",
          title: `MRT Aufnahme ${n}`,
          filename: `mrt-aufnahme-${n}.png`,
          mimeType: "image/png",
          documentDate: MRT_DOC_DATE,
          bytes: tinyPng(`e2evaultimg${n}`),
        });
      }
      await upsertDocs(pool, userId, docs);

      // Condition links for the three MRT-day documents.
      const linked = [
        MRT_DOC_ID,
        "e2evaultimg0000000000001",
        "e2evaultimg0000000000002",
      ];
      for (const [i, docId] of linked.entries()) {
        await pool.query(
          `INSERT INTO document_condition_links
          (id, document_id, episode_id, user_id, created_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (document_id, episode_id) DO NOTHING`,
          [`e2evaultlink00000000000${i + 1}`, docId, KNIE_EPISODE_ID, userId],
        );
      }
    });
  } finally {
    await pool.end();
  }
}

/**
 * Seed the P2 AI-assist + content-search fixtures:
 *   - a bland PDF the assist / summary specs drive against a mocked provider;
 *   - a document whose only searchable word (`CONTENT_BODY_WORD`) lives in its
 *     blind content index, not its title/filename, so content search is the
 *     sole route to it — exercising the real GIN token union end-to-end.
 * Idempotent (fixed ids upserted); safe to call from every spec's beforeAll.
 */
export async function ensureVaultAiFixture(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("[vault-fixture] DATABASE_URL is not set");
  const pool = new pg.Pool({ connectionString: url });
  try {
    await withVaultSeedLock(pool, async () => {
      const userId = await getUserId(pool);

      await upsertDocs(pool, userId, [
        {
          id: AI_PROBE_DOC_ID,
          kind: "OTHER",
          title: "AI probe report",
          filename: "ai-probe-report.pdf",
          mimeType: "application/pdf",
          documentDate: "2026-04-02",
          bytes: tinyPdf(AI_PROBE_DOC_ID),
        },
        {
          // Title + filename deliberately omit CONTENT_BODY_WORD.
          id: CONTENT_DOC_ID,
          kind: "DOCTOR_REPORT",
          title: "Radiology note",
          filename: "radiology-note.pdf",
          mimeType: "application/pdf",
          documentDate: "2026-03-10",
          bytes: tinyPdf(CONTENT_DOC_ID),
        },
      ]);

      // Seed CONTENT_DOC_ID's blind content index: the body word is only findable
      // via the token union. The plaintext text is stored encrypted (never read
      // by the search path) purely to mirror a real index row.
      const body = `Chest imaging report. Findings consistent with ${CONTENT_BODY_WORD}. No pleural effusion noted.`;
      await pool.query(
        `INSERT INTO document_content_index
        (id, document_id, user_id, text_encrypted, search_tokens, source,
         provider_type, tokenizer_version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'vision', NULL, '1', NOW(), NOW())
       ON CONFLICT (document_id) DO UPDATE SET
         text_encrypted = EXCLUDED.text_encrypted,
         search_tokens = EXCLUDED.search_tokens,
         updated_at = NOW()`,
        [
          "e2evaultcidx0000000000001",
          CONTENT_DOC_ID,
          userId,
          encryptStringToBytes(body),
          tokeniseAndHash(body),
        ],
      );
    });
  } finally {
    await pool.end();
  }
}

/**
 * Seed a disposable, namespaced batch of OTHER-kind PDF documents for the
 * bulk-flow specs (`title`/`filename` carry the prefix so a search filter
 * isolates exactly this namespace). Idempotent; re-runs reset kind/date and
 * clear tombstones so a previous run's mutations never leak into this one.
 */
export async function seedNamespaceDocs(
  prefix: string,
  count: number,
): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("[vault-fixture] DATABASE_URL is not set");
  const pool = new pg.Pool({ connectionString: url });
  try {
    const userId = await getUserId(pool);
    const docs: DocRow[] = [];
    for (let i = 0; i < count; i++) {
      const id = `e2e${prefix}${String(i).padStart(8, "0")}`;
      docs.push({
        id,
        kind: "OTHER",
        title: `${prefix} ${String(i + 1).padStart(3, "0")}`,
        filename: `${prefix}-${i + 1}.pdf`,
        mimeType: "application/pdf",
        // One shared filing date: the timeline then orders the namespace by
        // the id tiebreak (desc), so `${prefix} <count>` renders first and
        // `${prefix} 001` last — a deterministic range-selection span.
        documentDate: "2026-05-01",
        bytes: tinyPdf(id),
      });
    }
    await upsertDocs(pool, userId, docs);
  } finally {
    await pool.end();
  }
}

/** The procedure-filter fixture: two procedures, each with its own files. */
export const PROCEDURE_KNEE_ID = "e2eprocknee0000000000001";
export const PROCEDURE_APPENDIX_ID = "e2eprocappx0000000000001";
export const PROCEDURE_DOC_PREFIX = "procfilter";

/**
 * Seed the procedure-filter fixture: three namespaced documents and two
 * procedures — a knee arthroscopy (reason + body site + side) holding two of
 * them, and an appendectomy holding the third. Dated far from the MRT report
 * so the visits spec's ±7-day window never sees them. Idempotent: the rows
 * upsert by fixed id and come back live, so a `resetEncounters` from the visits
 * spec between runs is repaired by the next call.
 */
export async function ensureProcedureFixture(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("[vault-fixture] DATABASE_URL is not set");
  await seedNamespaceDocs(PROCEDURE_DOC_PREFIX, 3);
  const pool = new pg.Pool({ connectionString: url });
  try {
    const userId = await getUserId(pool);
    const procedures = [
      {
        id: PROCEDURE_KNEE_ID,
        at: "2024-03-12T08:00:00Z",
        reason: "Knee arthroscopy",
        site: "Knee",
        side: "LEFT",
        docs: [0, 1],
      },
      {
        id: PROCEDURE_APPENDIX_ID,
        at: "2023-06-20T08:00:00Z",
        reason: "Appendectomy",
        site: null,
        side: null,
        docs: [2],
      },
    ];
    for (const p of procedures) {
      await pool.query(
        `INSERT INTO encounters
           (id, user_id, occurred_at, status, kind, reason_encrypted,
            body_site_encrypted, laterality, created_at, updated_at)
         VALUES ($1, $2, $3, 'DONE', 'PROCEDURE', $4, $5, $6::laterality, NOW(), NOW())
         ON CONFLICT (id) DO UPDATE SET
           occurred_at = EXCLUDED.occurred_at, kind = 'PROCEDURE',
           status = 'DONE', reason_encrypted = EXCLUDED.reason_encrypted,
           body_site_encrypted = EXCLUDED.body_site_encrypted,
           laterality = EXCLUDED.laterality, deleted_at = NULL,
           updated_at = NOW()`,
        [
          p.id,
          userId,
          p.at,
          encryptStringToBytes(p.reason),
          p.site ? encryptStringToBytes(p.site) : null,
          p.side,
        ],
      );
      for (const n of p.docs) {
        const docId = `e2e${PROCEDURE_DOC_PREFIX}${String(n).padStart(8, "0")}`;
        await pool.query(
          `INSERT INTO encounter_document_links
             (id, encounter_id, document_id, user_id, created_at)
           VALUES ($1, $2, $3, $4, NOW())
           ON CONFLICT (encounter_id, document_id) DO NOTHING`,
          [`${p.id.slice(0, 16)}lnk${n}`, p.id, docId, userId],
        );
      }
    }
  } finally {
    await pool.end();
  }
}

/**
 * v1.28 — seed the clinician-share document trio (see the `SHARE_*_DOC_ID`
 * constants). Enables the vault module for the e2e user and upserts one
 * inline-PDF, one Exif/GPS-bearing JPEG, and one download-only text document,
 * all owned by the seeded account. Idempotent; safe from a spec `beforeAll`.
 */
export async function ensureShareDocFixture(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("[vault-fixture] DATABASE_URL is not set");
  const pool = new pg.Pool({ connectionString: url });
  try {
    const userId = await getUserId(pool);
    await pool.query(
      `UPDATE users
       SET module_preferences_json =
         COALESCE(module_preferences_json, '{}'::jsonb)
         || '{"inboundDocuments": true}'::jsonb
       WHERE id = $1`,
      [userId],
    );
    await upsertDocs(pool, userId, [
      {
        id: SHARE_PDF_DOC_ID,
        kind: "DOCTOR_REPORT",
        title: `${SHARE_DOC_PREFIX} report`,
        filename: "share-report.pdf",
        mimeType: "application/pdf",
        documentDate: "2026-05-20",
        bytes: tinyPdf(SHARE_PDF_DOC_ID),
      },
      {
        id: SHARE_JPEG_DOC_ID,
        kind: "IMAGING",
        title: `${SHARE_DOC_PREFIX} scan`,
        filename: "share-scan.jpg",
        mimeType: "image/jpeg",
        documentDate: "2026-05-21",
        bytes: jpegWithGps(SHARE_JPEG_DOC_ID),
      },
      {
        id: SHARE_TEXT_DOC_ID,
        kind: "OTHER",
        title: `${SHARE_DOC_PREFIX} notes`,
        filename: "share-notes.txt",
        mimeType: "text/plain",
        documentDate: "2026-05-22",
        bytes: Buffer.from(`share e2e class-B payload ${SHARE_TEXT_DOC_ID}`),
      },
    ]);
  } finally {
    await pool.end();
  }
}
