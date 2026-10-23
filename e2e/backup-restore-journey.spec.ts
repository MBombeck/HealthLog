/**
 * A record, a snapshot of it, and the snapshot put back — one journey.
 *
 * The script this file is checked against:
 *
 *   1. an account records readings across three domains — two measurements, a
 *      medication with one dose, a mood entry — and files a small PDF in the
 *      vault;
 *   2. it downloads its own record as the passphrase-sealed archive the export
 *      card offers, and the bytes are the `HLX1` envelope
 *      `src/lib/export/passphrase-archive.ts` documents, not a JSON file with
 *      a new extension;
 *   3. an admin takes a snapshot from the backups console, waits for the
 *      pg-boss pass by asking the console's own endpoint what it holds, and
 *      downloads the stored copy;
 *   4. the account loses a reading and a dose, gains a reading the snapshot
 *      never saw, and the snapshot is restored over it from the same console;
 *   5. what was deleted is back under its ORIGINAL id, and what arrived after
 *      the snapshot is gone — which is what "the restore replaces the
 *      account's data tables" in `docs/ops/backup-restore.md` means when it is
 *      spelled out;
 *   6. a second person downloads their own full backup, their account is
 *      recreated empty under the same id (the runbook's new host), the admin
 *      uploads the file and restores it, and the person signs in to the same
 *      rows under the same ids.
 *
 * Refusing controls, because a restore path that cannot say no is worse than
 * none: a stored copy with one flipped ciphertext byte is refused and changes
 * nothing, and a delegate holding whole-record READ inside the account sees no
 * backup surface at all and is refused by every route behind it.
 *
 * One act reaches past this account, and by design: "Backup now" enqueues the
 * `data-backup` pass, which writes a `WEEKLY_AUTO` row for EVERY account on the
 * instance. The journey reads only its own row and deletes only its own rows,
 * but it is not true that it touches nothing else. The restore is the other
 * direction and is confined: the transaction is scoped to the snapshot's owner,
 * and the instance-wide settings a disaster-recovery payload also carries are
 * written only when the dialog's opt-in is ticked, which this file never ticks
 * and asserts it never ticks.
 *
 * Everything the journey does, it does through the app: the readings and the
 * document ride the page's own `fetch`, the archive and the snapshot ride the
 * real buttons, the restore rides the typed-confirmation dialog. The only
 * things reaching Postgres directly are the ones a browser cannot express —
 * resetting the accounts between repetitions, corrupting one stored copy so
 * the authenticated envelope has something to refuse (both in
 * `setup/backup-journey-fixture.ts`), and recreating the second account under
 * its own id (`setup/critical-fixture.ts`).
 *
 * Serial and single-project: the five tests are five acts of one journey, they
 * mutate the accounts destructively, and the last one moves a session's record
 * selector. Its jar is its own for the reason `global-setup.ts` spells out.
 */
import { readFile } from "node:fs/promises";

import type { Page, Response } from "@playwright/test";

import { EXPORT_ARGON2_PARAMS } from "@/lib/export/passphrase-archive";

import {
  BACKUP_DELEGATE_STORAGE_STATE_PATH,
  BACKUP_STORAGE_STATE_PATH,
  E2E_BACKUP_ADMIN,
} from "./setup/global-setup";
import {
  backupAccountId,
  deleteStoredCopy,
  resetBackupJourney,
  storedIntakeIds,
  storedMeasurements,
  storeTamperedCopy,
} from "./setup/backup-journey-fixture";
import {
  accountRowCounts,
  clearLoginBuckets,
  criticalAccount,
  recreateCriticalAccount,
  resetCriticalAccount,
} from "./setup/critical-fixture";
import {
  actWithReproof,
  completeReproofWithPassword,
  expireRecentProof,
  useStaleSession,
} from "./setup/recent-proof";
import { expect, test } from "./setup/test";

test.describe.configure({ mode: "serial" });

/**
 * The pass backs up every account in the database, the restore rewrites a
 * dozen tables in one transaction, and the archive runs Argon2id at the OWASP
 * cost. None of that fits the suite's 30-second default on a loaded runner.
 * On top of that, a test must hold the restore wait below in full.
 */
test.setTimeout(240_000);

/**
 * How long a queued restore may take to finish. The restore shares the heavy
 * lane with the backup pass, and a restore that finds the lane taken goes
 * back to the queue for `LANE_DEFER_SECONDS` (60 s, `src/lib/jobs/heavy-lane.ts`).
 * The pass this journey starts can still be finishing when the restore is
 * asked for: on a loaded machine its tail ran 15 s, the restore was put back
 * by 60, and a 60-second wait ran out one second before it started. The
 * budget holds one deferral and a second yield with room to run.
 */
const RESTORE_BUDGET_MS = 135_000;

/** Long enough to clear the export card's own 12-character minimum. */
const ARCHIVE_PASSPHRASE = "e2e-backup-journey-passphrase";

/** The reading the journey deletes and expects back, by value and by id. */
const RESTORED_WEIGHT_KG = 81.4;
/** The reading nothing touches — a restore that wiped it would be a defect. */
const UNTOUCHED_PULSE_BPM = 58;
/** The reading that arrives AFTER the snapshot and must not survive it. */
const POST_SNAPSHOT_PULSE_BPM = 66;
/** The second account's reading, carried through its own backup. */
const FRESH_ACCOUNT_WEIGHT_KG = 67.3;

const MEDICATION_NAME = "E2E Backup Tablet";

/** The console's row list is painted, or its honest empty state is. */
const BACKUPS_SETTLED = '[data-slot="backup-rows"], [data-slot="empty-state"]';
/** The measurements list has finished its read, either way. */
const MEASUREMENTS_SETTLED =
  '[data-slot="measurement-rows"], [data-slot="empty-state"]';

/** One stored snapshot as the console's own endpoint reports it. */
interface ConsoleRow {
  id: string;
  username: string;
  type: string;
  sizeBytes: number;
  createdAt: string;
}

interface SeededRecord {
  weightId: string;
  intakeId: string;
  medicationId: string;
  documentId: string;
}

/** What the journey wrote, once the first act has written it. */
let seeded: SeededRecord | null = null;
/** The stored snapshot the first act takes; every later act addresses it. */
let snapshotId: string | null = null;
/** The deliberately corrupted copy, held so the file can take it away again. */
let tamperedCopyId: string | null = null;

function requireSeeded(): SeededRecord {
  if (!seeded) throw new Error("the record was never seeded");
  return seeded;
}

function requireSnapshot(): string {
  if (!snapshotId) throw new Error("no snapshot was taken");
  return snapshotId;
}

/**
 * Write the record through the app's own routes, from the page's origin.
 *
 * The page's `fetch` rather than a Playwright request context, for the reason
 * `glucose-journey.spec.ts` gives: a pooled context can hand a POST to a
 * keep-alive socket the server has already closed, and the retry lands as a
 * second row.
 */
function seedRecord(page: Page): Promise<SeededRecord> {
  return page.evaluate(
    async ([weightKg, pulseBpm, medicationName]: [number, number, string]) => {
      const post = async (path: string, body: unknown): Promise<string> => {
        const res = await fetch(path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const json = (await res.json()) as {
          data: { id: string } | null;
          error: string | null;
        };
        if (!res.ok || !json.data) {
          throw new Error(`${path} answered ${res.status}: ${json.error}`);
        }
        return json.data.id;
      };
      const at = (minutesAgo: number) =>
        new Date(Date.now() - minutesAgo * 60_000).toISOString();

      const weightId = await post("/api/measurements", {
        type: "WEIGHT",
        value: weightKg,
        measuredAt: at(180),
      });
      await post("/api/measurements", {
        type: "PULSE",
        value: pulseBpm,
        measuredAt: at(170),
      });
      const medicationId = await post("/api/medications", {
        name: medicationName,
        dose: "5 mg",
        schedules: [{ windowStart: "08:00", windowEnd: "09:00" }],
      });
      const intakeId = await post(`/api/medications/${medicationId}/intake`, {
        takenAt: at(160),
      });
      await post("/api/mood-entries", {
        mood: "GUT",
        note: "backup journey",
        moodLoggedAt: at(150),
      });

      // The vault, through the same multipart body the upload card sends. A
      // real minimal PDF: the route classifies by magic bytes and never trusts
      // the wire content-type, so bytes that only claim to be one are refused.
      const pdf = new TextEncoder().encode(
        "%PDF-1.4\n%e2e-backup-journey\n" +
          "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
          "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
          "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n" +
          "xref\n0 4\ntrailer<</Size 4/Root 1 0 R>>\n%%EOF\n",
      );
      const form = new FormData();
      form.append(
        "file",
        new File([pdf], "backup-journey.pdf", { type: "application/pdf" }),
      );
      form.append("title", "Backup journey probe");
      const docRes = await fetch("/api/documents/inbound", {
        method: "POST",
        body: form,
      });
      const docJson = (await docRes.json()) as {
        data: { id: string } | null;
        error: string | null;
      };
      if (!docRes.ok || !docJson.data) {
        throw new Error(
          `/api/documents/inbound answered ${docRes.status}: ${docJson.error}`,
        );
      }

      return { weightId, medicationId, intakeId, documentId: docJson.data.id };
    },
    [RESTORED_WEIGHT_KG, UNTOUCHED_PULSE_BPM, MEDICATION_NAME] as [
      number,
      number,
      string,
    ],
  );
}

/** This account's scheduled snapshot as the console's endpoint reports it. */
function readConsoleRow(page: Page): Promise<ConsoleRow | null> {
  return page.evaluate(async (username: string) => {
    const res = await fetch("/api/admin/backups", { credentials: "include" });
    const body = (await res.json()) as {
      data: { rows: ConsoleRow[] } | null;
    };
    const mine = (body.data?.rows ?? []).filter(
      (row) => row.username === username && row.type === "WEEKLY_AUTO",
    );
    return mine[0] ?? null;
  }, E2E_BACKUP_ADMIN.username);
}

/** Open the backups console and wait for its row list to settle. */
async function openBackupsConsole(page: Page): Promise<void> {
  await page.goto("/admin/backups", { waitUntil: "domcontentloaded" });
  await expect(page.locator(BACKUPS_SETTLED).first()).toBeVisible({
    timeout: 30_000,
  });
}

/**
 * The console's row for one snapshot, at whichever layout is painting.
 *
 * Both the wide table and the narrow card list are in the tree — only CSS
 * hides one — so the `:visible` filter is what keeps this a single element
 * rather than a pair. This file runs in the desktop project alone (see the
 * `chromium-mobile` ignore list in `playwright.config.ts`), so the table row is
 * the one that answers; the card's identical attributes are what let the same
 * handle hold if it ever runs narrow, and are not exercised here.
 */
function snapshotRow(page: Page, id: string) {
  return page.locator(`[data-backup-id="${id}"]:visible`);
}

/**
 * Drive the typed-confirmation dialog on one row and hand back the answer.
 *
 * A restore asks for a recent proof, and the session is made stale first, so
 * the first POST is always refused and the answer waited for is the one to
 * the retry the page sends after the re-proof dialog.
 */
async function restoreThroughDialog(page: Page, id: string) {
  await expireRecentProof(page);
  const answered = page.waitForResponse(
    (response) =>
      response.url().includes(`/api/admin/backups/${id}/restore`) &&
      response.request().method() === "POST" &&
      response.status() !== 401,
  );
  await snapshotRow(page, id).getByTestId("backup-restore-trigger").click();
  // The instance-wide opt-in, left exactly where the dialog puts it. Asserted
  // rather than merely not clicked: a default that flipped would hand this
  // journey the power to rewrite the host's settings — the document size cap
  // among them — for every other spec sharing the server.
  await expect(
    page.getByTestId("backup-restore-instance-settings"),
  ).not.toBeChecked();
  await page.getByTestId("backup-restore-prompt").fill("RESTORE");
  await page.getByTestId("backup-restore-confirm").click();
  await completeReproofWithPassword(page, E2E_BACKUP_ADMIN.password);
  return answered;
}

/**
 * Wait for a queued restore to finish, and fail with its code if it failed.
 *
 * The restore runs on the `backup-restore` queue: the request answers 202
 * with the job and its status route, and the worker inside the server under
 * test does the work. Nothing after this is read until the job says it is
 * done, so every assertion is about the finished restore rather than a moment
 * in the middle of it.
 */
async function awaitRestore(page: Page, response: Response): Promise<void> {
  expect(response.status()).toBe(202);
  const queued = (await response.json()) as {
    data: { jobId: string; status: string; statusUrl: string };
  };
  expect(queued.data.status).toBe("queued");
  expect(queued.data.statusUrl).toBe(
    `/api/admin/backups/restores/${queued.data.jobId}`,
  );
  await expect
    .poll(
      async () => {
        const res = await page.request.get(queued.data.statusUrl);
        const body = (await res.json()) as {
          data: {
            status: string;
            failure: { code: string } | null;
          } | null;
        };
        // A failed job ends the wait with its code in the message instead of
        // running the clock out on a state that will never change.
        return body.data?.status === "failed"
          ? `failed: ${body.data.failure?.code ?? "unknown"}`
          : body.data?.status;
      },
      { timeout: RESTORE_BUDGET_MS, intervals: [250, 500, 1_000] },
    )
    .toBe("succeeded");
}

test.describe("Backup and restore, through the settings surfaces", () => {
  test.use({ storageState: BACKUP_STORAGE_STATE_PATH });

  // The archive, the snapshot download and every restore ask for a recent
  // proof. Each test acts from a session of its own that is made stale before
  // each of those presses, so the re-proof dialog is met every time, whatever
  // minute of the run the journey lands in.
  let endStaleSession: (() => Promise<void>) | null = null;
  test.beforeEach(async ({ page }) => {
    endStaleSession = await useStaleSession(page, E2E_BACKUP_ADMIN.username);
  });
  test.afterEach(async () => {
    await endStaleSession?.();
    endStaleSession = null;
  });

  test.beforeAll(async () => {
    seeded = null;
    snapshotId = null;
    tamperedCopyId = null;
    await resetBackupJourney();
  });

  test.afterAll(async () => {
    if (tamperedCopyId) await deleteStoredCopy(tamperedCopyId);
    tamperedCopyId = null;
  });

  test("a record is written, sealed into an HLX1 archive, and snapshotted @critical", async ({
    page,
  }) => {
    await page.goto("/measurements", { waitUntil: "domcontentloaded" });
    await expect(page.locator(MEASUREMENTS_SETTLED).first()).toBeVisible({
      timeout: 30_000,
    });
    seeded = await seedRecord(page);
    const record = seeded;

    // On the list, by the number the row carries rather than by the text the
    // formatter prints for whoever is looking. The attribute holds the
    // DISPLAYED value, after the account's unit preference is applied — the
    // same number as the stored one under this account's default metric
    // preference, and deliberately not a claim about the stored row. The
    // database-side assertions later in the file are that claim.
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(
      page
        .locator(
          '[data-testid="measurement-row"][data-measurement-type="WEIGHT"]' +
            `[data-measurement-value="${RESTORED_WEIGHT_KG}"]`,
        )
        .first(),
    ).toBeVisible({ timeout: 30_000 });

    // ── the account's own archive ────────────────────────────────────────
    await page.goto("/settings/export", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("export-card-full-backup")).toBeVisible({
      timeout: 30_000,
    });
    await page.getByTestId("export-full-backup-encrypt").click();
    await page
      .getByTestId("export-full-backup-passphrase")
      .fill(ARCHIVE_PASSPHRASE);
    const archiveDownload = page.waitForEvent("download");
    await actWithReproof(page, E2E_BACKUP_ADMIN.password, () =>
      page.getByTestId("export-action-full-backup").click(),
    );
    const bytes = await readFile(await (await archiveDownload).path());

    // The header `passphrase-archive.ts` documents, field by field: magic,
    // version, KDF id, then the Argon2 cost the archive carries so a later
    // cost bump still opens it. Asserted as bytes, because "a file arrived"
    // is equally true of plaintext JSON under a new extension.
    expect(bytes.subarray(0, 4).toString("ascii")).toBe("HLX1");
    expect(bytes[4], "HLX1 version").toBe(0x01);
    expect(bytes[5], "KDF id — Argon2id").toBe(0x01);
    // The cost travels in the file so it may change, so it is asserted against
    // the constant the writer uses rather than against today's numbers: a
    // legitimate cost bump is a correct product change, not a red spec.
    expect(bytes.readUInt32BE(6), "Argon2 memory cost, KiB").toBe(
      EXPORT_ARGON2_PARAMS.memoryCost,
    );
    expect(bytes.readUInt32BE(10), "Argon2 time cost").toBe(
      EXPORT_ARGON2_PARAMS.timeCost,
    );
    expect(bytes[14], "Argon2 parallelism").toBe(
      EXPORT_ARGON2_PARAMS.parallelism,
    );
    expect(bytes[15], "salt length").toBe(16);
    // A record carrying five sections is not a header and an auth tag.
    expect(bytes.byteLength).toBeGreaterThan(1024);

    // ── the instance's own snapshot ──────────────────────────────────────
    await openBackupsConsole(page);
    // The row this account had before the click, or none. The poll below asks
    // "is the stored copy a different one", and the server's own clock is the
    // only one both sides share — comparing a server timestamp against the
    // runner's would pass on a stale row under any clock skew.
    const previous = await readConsoleRow(page);
    const enqueued = page.waitForResponse(
      (response) =>
        response.url().includes("/api/admin/backups/run") &&
        response.request().method() === "POST",
    );
    // The list is populated by now, so it is the card action that runs the
    // pass; the empty state's CTA carries its own id.
    await page.getByTestId("backup-run-now").click();
    // Named here rather than left to the poll: with no pg-boss instance in the
    // process the route answers 503 and nothing is ever enqueued, and the poll
    // would spend two minutes to report that the pass stored no copy — true,
    // and about the wrong subsystem. 429 is the same story on a reset that
    // stopped clearing the run bucket.
    expect(
      (await enqueued).status(),
      "the manual pass was enqueued (503 = no worker in this process, 429 = rate limit)",
    ).toBe(200);

    // The pass runs on pg-boss inside this process, so the console cannot know
    // when it finished — it can only be asked. Poll the endpoint the page
    // itself reads until this account's stored copy is newer than the click.
    // No sleep: a fixed wait would be a guess about a queue.
    const found: { row: ConsoleRow | null } = { row: null };
    await expect
      .poll(
        async () => {
          const row = await readConsoleRow(page);
          const fresh =
            row !== null &&
            (previous === null ||
              row.id !== previous.id ||
              row.createdAt !== previous.createdAt);
          if (fresh) found.row = row;
          return fresh;
        },
        {
          timeout: 120_000,
          intervals: [500, 1_000, 2_000],
          message: "the data-backup pass never stored a copy of this account",
        },
      )
      .toBe(true);

    const row = found.row;
    if (!row) throw new Error("the poll reported a row it did not keep");
    expect(
      row.sizeBytes,
      "a stored copy of a record is not empty",
    ).toBeGreaterThan(512);
    snapshotId = row.id;

    // The console paints it, and the row's own actions are on screen.
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(snapshotRow(page, row.id)).toHaveCount(1, { timeout: 30_000 });
    await expect(
      snapshotRow(page, row.id).getByTestId("backup-restore-trigger"),
    ).toBeVisible();

    // ── what the stored copy actually carries ────────────────────────────
    const snapshotDownload = page.waitForEvent("download");
    await actWithReproof(page, E2E_BACKUP_ADMIN.password, () =>
      snapshotRow(page, row.id).getByTestId("backup-download").click(),
    );
    const payload = JSON.parse(
      await readFile(await (await snapshotDownload).path(), "utf8"),
    ) as {
      measurements: Array<{ id: string }>;
      intakeEvents: Array<{ id: string }>;
      moodEntries: unknown[];
      documents: Array<{ id: string; contentEncrypted?: string }>;
    };

    expect(payload.measurements.map((m) => m.id)).toContain(record.weightId);
    expect(payload.intakeEvents.map((e) => e.id)).toContain(record.intakeId);
    expect(payload.moodEntries).toHaveLength(1);
    expect(payload.documents.map((d) => d.id)).toContain(record.documentId);
    // A disaster-recovery copy carries document content as ciphertext, and the
    // restore refuses a file that brought only metadata — so an empty field
    // here is a snapshot nobody could restore.
    expect(
      payload.documents.find((d) => d.id === record.documentId)
        ?.contentEncrypted ?? "",
    ).not.toBe("");
  });

  test("a stored copy with one flipped byte is refused and changes nothing", async ({
    page,
  }) => {
    const before = await storedMeasurements();
    const tamperedId = await storeTamperedCopy(requireSnapshot());
    // Dropped again as soon as the control is done with it, rather than at the
    // next repetition's reset: until then it is a broken row in the console's
    // list for anyone who opens `/admin/backups`.
    tamperedCopyId = tamperedId;

    await openBackupsConsole(page);
    const response = await restoreThroughDialog(page, tamperedId);

    // The envelope is AES-256-GCM and its tag covers every ciphertext byte, so
    // the flip is caught before the transaction opens. 422 and
    // `backup.payload.undecryptable` are the refusal the route documents —
    // `docs/api/openapi.yaml`, and `docs/ops/backup-restore.md` for the
    // operator reading it after a key rotation — rather than whatever the
    // handler happened to answer. The code is asserted and not the sentence:
    // the sentence is prose that may be reworded, the code is the contract.
    expect(response.status()).toBe(422);
    expect(await response.json()).toMatchObject({
      data: null,
      meta: { errorCode: "backup.payload.undecryptable" },
    });

    // A refusal that still wrote something would be worse than no refusal.
    expect(await storedMeasurements()).toEqual(before);
  });

  test("the snapshot puts back what was deleted and drops what came after @critical", async ({
    page,
  }) => {
    const record = requireSeeded();

    await page.goto("/measurements", { waitUntil: "domcontentloaded" });
    await expect(page.locator(MEASUREMENTS_SETTLED).first()).toBeVisible({
      timeout: 30_000,
    });

    // One reading and one dose go, and a reading the snapshot never saw
    // arrives. Both deletions are tombstones — the app soft-deletes a reading
    // and a dose — so "back" has to mean live again, not merely present.
    const laterId = await page.evaluate(
      async ([weightId, medicationId, intakeId, pulse]: [
        string,
        string,
        string,
        number,
      ]) => {
        const del = async (path: string) => {
          const res = await fetch(path, { method: "DELETE" });
          if (!res.ok) throw new Error(`${path} answered ${res.status}`);
        };
        await del(`/api/measurements/${weightId}`);
        await del(`/api/medications/${medicationId}/intake/${intakeId}`);

        const res = await fetch("/api/measurements", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "PULSE",
            value: pulse,
            measuredAt: new Date(Date.now() - 60_000).toISOString(),
          }),
        });
        const body = (await res.json()) as { data: { id: string } | null };
        if (!res.ok || !body.data) {
          throw new Error(`/api/measurements answered ${res.status}`);
        }
        return body.data.id;
      },
      [
        record.weightId,
        record.medicationId,
        record.intakeId,
        POST_SNAPSHOT_PULSE_BPM,
      ] as [string, string, string, number],
    );

    const beforeRestore = await storedMeasurements();
    expect(
      beforeRestore.find((m) => m.id === record.weightId)?.deletedAt,
      "the reading really is tombstoned before the restore",
    ).not.toBeNull();
    expect(beforeRestore.map((m) => m.id)).toContain(laterId);

    await openBackupsConsole(page);
    await awaitRestore(
      page,
      await restoreThroughDialog(page, requireSnapshot()),
    );

    const afterRestore = await storedMeasurements();

    // Identity, not merely equivalence. The payload carries each row's own id,
    // so a restore that re-created the reading under a fresh one would have
    // written a different record that happens to read the same.
    const weight = afterRestore.find((m) => m.id === record.weightId);
    expect(
      weight,
      "the deleted reading is back under its own id",
    ).toBeDefined();
    expect(weight?.value).toBe(RESTORED_WEIGHT_KG);
    expect(
      weight?.deletedAt,
      "and it is live, not still tombstoned",
    ).toBeNull();

    const dose = (await storedIntakeIds()).find(
      (e) => e.id === record.intakeId,
    );
    expect(dose, "the deleted dose is back under its own id").toBeDefined();
    expect(dose?.deletedAt).toBeNull();

    // The reading nothing touched is still there. Without this, an emptied
    // account would satisfy every assertion above about the tombstones.
    expect(
      afterRestore.filter((m) => m.value === UNTOUCHED_PULSE_BPM),
    ).toHaveLength(1);

    // And the reading that arrived after the snapshot is gone.
    // `docs/ops/backup-restore.md` says the restore "replaces the account's
    // data tables", and `restore-backup.ts` puts it as "one transaction replaces
    // every serialized owner-scoped class". Replacing is not merging: whoever
    // restores yesterday's copy loses today's readings, and that is the
    // documented behaviour rather than an accident of the implementation.
    expect(afterRestore.map((m) => m.id)).not.toContain(laterId);

    // The list agrees with the database.
    await page.goto("/measurements", { waitUntil: "domcontentloaded" });
    await expect(
      page
        .locator(
          '[data-testid="measurement-row"][data-measurement-type="WEIGHT"]' +
            `[data-measurement-value="${RESTORED_WEIGHT_KG}"]`,
        )
        .first(),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      page.locator(
        '[data-testid="measurement-row"][data-measurement-type="PULSE"]' +
          `[data-measurement-value="${POST_SNAPSHOT_PULSE_BPM}"]`,
      ),
    ).toHaveCount(0);
  });

  test("a full backup the operator restores brings the record back into a fresh account @critical", async ({
    page,
    browser,
  }, testInfo) => {
    // The second account: a person with a record of their own, who downloads
    // the file the export card offers. Its jar is its own; the act below
    // gives it a session that needs a re-proof, like the admin's.
    const person = criticalAccount("restore", testInfo);
    await resetCriticalAccount(person, [
      "DELETE FROM measurement_rollups WHERE user_id = $1",
      "DELETE FROM measurements WHERE user_id = $1",
      "DELETE FROM mood_entry_rollups WHERE user_id = $1",
      "DELETE FROM mood_entries WHERE user_id = $1",
      "DELETE FROM rate_limits WHERE key = 'export:' || $1",
    ]);

    const context = await browser.newContext({
      storageState: person.storageStatePath,
      baseURL: testInfo.project.use.baseURL,
    });
    let backupPath = "";
    let written: { weightId: string; moodId: string };
    try {
      const own = await context.newPage();
      const endOwnSession = await useStaleSession(own, person.username);
      try {
        await own.goto("/measurements", { waitUntil: "domcontentloaded" });
        await expect(own.locator(MEASUREMENTS_SETTLED).first()).toBeVisible({
          timeout: 30_000,
        });
        written = await own.evaluate(async (weightKg: number) => {
          const post = async (path: string, body: unknown) => {
            const res = await fetch(path, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            });
            const json = (await res.json()) as { data: { id: string } | null };
            if (!res.ok || !json.data) {
              throw new Error(`${path} answered ${res.status}`);
            }
            return json.data.id;
          };
          const at = new Date(Date.now() - 90 * 60_000).toISOString();
          return {
            weightId: await post("/api/measurements", {
              type: "WEIGHT",
              value: weightKg,
              measuredAt: at,
            }),
            moodId: await post("/api/mood-entries", {
              mood: "OKAY",
              moodLoggedAt: at,
            }),
          };
        }, FRESH_ACCOUNT_WEIGHT_KG);

        await own.goto("/settings/export", { waitUntil: "domcontentloaded" });
        await expect(own.getByTestId("export-card-full-backup")).toBeVisible({
          timeout: 30_000,
        });
        const download = own.waitForEvent("download");
        await actWithReproof(own, person.password, () =>
          own.getByTestId("export-action-full-backup").click(),
        );
        // Kept past the context: a download's own file goes with it.
        backupPath = testInfo.outputPath("full-backup.json");
        await (await download).saveAs(backupPath);
      } finally {
        await endOwnSession();
      }
    } finally {
      await context.close();
    }

    // ── the account is gone, and comes back empty under the same id ──────
    // What a new host is to the runbook (`docs/ops/backup-restore.md`): the
    // backup names its owner by id, so the account is recreated under it
    // before the upload. A browser cannot express this; it is the one act
    // here that goes to Postgres.
    await recreateCriticalAccount(person);
    expect(await accountRowCounts(person)).toEqual({
      measurements: 0,
      moodEntries: 0,
    });

    // ── the operator uploads the file and restores it ───────────────────
    await openBackupsConsole(page);
    const uploaded = page.waitForResponse(
      (res) =>
        new URL(res.url()).pathname === "/api/admin/backups/upload" &&
        res.request().method() === "POST" &&
        res.status() !== 401,
    );
    await actWithReproof(page, E2E_BACKUP_ADMIN.password, () =>
      page
        .locator('input[type="file"][accept*="application/gzip"]')
        .setInputFiles(backupPath),
    );
    const upload = await uploaded;
    expect(upload.status(), (await upload.text()).slice(0, 400)).toBe(201);
    const uploadId = ((await upload.json()) as { data: { id: string } }).data
      .id;
    await expect(snapshotRow(page, uploadId)).toHaveCount(1, {
      timeout: 30_000,
    });
    await awaitRestore(page, await restoreThroughDialog(page, uploadId));

    // ── and the person signs in to their record ──────────────────────────
    const back = await browser.newContext({
      baseURL: testInfo.project.use.baseURL,
    });
    try {
      await clearLoginBuckets();
      const login = await back.request.post("/api/auth/login", {
        data: { email: person.username, password: person.password },
      });
      expect(login.status()).toBe(200);
      const signedIn = await back.newPage();

      // The same rows, under their own ids: a restore, not a re-entry.
      const measurements = (
        (await (await signedIn.request.get("/api/measurements")).json()) as {
          data: { measurements: Array<{ id: string; value: number }> };
        }
      ).data.measurements;
      expect(measurements).toEqual([
        expect.objectContaining({
          id: written.weightId,
          value: FRESH_ACCOUNT_WEIGHT_KG,
        }),
      ]);
      const moods = (
        (await (await signedIn.request.get("/api/mood-entries")).json()) as {
          data: { entries: Array<{ id: string; mood: string }> };
        }
      ).data.entries;
      expect(moods).toEqual([
        expect.objectContaining({ id: written.moodId, mood: "OKAY" }),
      ]);

      await signedIn.goto("/measurements", { waitUntil: "domcontentloaded" });
      await expect(
        signedIn
          .locator(
            '[data-testid="measurement-row"][data-measurement-type="WEIGHT"]' +
              `[data-measurement-value="${FRESH_ACCOUNT_WEIGHT_KG}"]`,
          )
          .first(),
      ).toBeVisible({ timeout: 30_000 });
    } finally {
      await back.close();
    }

    // The admin's own record is untouched by a restore aimed at somebody else.
    expect(
      (await storedMeasurements()).filter((m) => m.deletedAt === null),
    ).toHaveLength(2);
  });
});

test.describe("A read-level delegate inside the record", () => {
  test.use({ storageState: BACKUP_DELEGATE_STORAGE_STATE_PATH });

  test("sees no backup surface, and every route behind it refuses", async ({
    page,
  }) => {
    // Switched in through the switcher a person uses, not by a stamp written
    // behind the app's back. The switcher is a slice of the user menu, so the
    // menu opens first — the same two steps `v137-record-session-fence.spec.ts`
    // takes, and the trigger's accessible name is the only handle it has.
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const userMenu = page.getByRole("button", { name: "User menu" }).first();
    await expect(userMenu).toBeVisible({ timeout: 30_000 });
    await userMenu.click();
    const trigger = page.locator('[data-slot="account-switcher-trigger"]');
    await expect(trigger).toBeVisible({ timeout: 30_000 });
    await trigger.click();
    const entry = page.locator(
      '[data-slot="account-switcher-entry"]' +
        `[data-account-username="${E2E_BACKUP_ADMIN.username}"]`,
    );
    await expect(entry).toBeVisible({ timeout: 30_000 });
    await entry.click();

    // Wait for the shell to say the switch landed, not merely that the click
    // did. The stamp is written on the session row by a request the click
    // fires, so navigating straight afterwards can load the next page under
    // the delegate's OWN record and find every actor surface exactly where it
    // belongs — a pass that says nothing. The banner names the record and the
    // affordance it resolved, so this waits for both; `view` is what
    // `resolveRecordPresentation` calls a READ grant, and a grant that had
    // widened would paint `view-and-add` here instead of matching.
    await expect(
      page.locator(
        '[data-slot="shared-record-banner"]' +
          `[data-account-id="${await backupAccountId()}"]` +
          '[data-access-level="view"][data-record-kind="shared"]',
      ),
    ).toBeVisible({ timeout: 30_000 });

    // Settings destinations that belong to the ACTOR do not mount inside
    // somebody else's record: the shell paints the not-covered panel in place
    // of the whole section. That panel is the positive half of this check —
    // without it, an absent export card would only mean the page had not
    // finished painting.
    await page.goto("/settings/export", { waitUntil: "domcontentloaded" });
    await expect(
      page.locator('[data-slot="shared-record-unavailable"]'),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("export-card-full-backup")).toHaveCount(0);
    await expect(page.getByTestId("export-action-full-backup")).toHaveCount(0);

    // The console is not a place a non-admin lands: `AuthShell` sends them to
    // the dashboard and the admin frame paints nothing on the way.
    await page.goto("/admin/backups", { waitUntil: "domcontentloaded" });
    // The dashboard, by path. `/\/$/` also matches an admin URL that merely
    // ends in a slash, which is the one outcome this assertion exists to rule
    // out.
    await expect
      .poll(() => new URL(page.url()).pathname, { timeout: 30_000 })
      .toBe("/");
    await expect(page.getByTestId("backup-run-now")).toHaveCount(0);
    await expect(page.getByTestId("backup-run-now-empty")).toHaveCount(0);
    await expect(page.getByTestId("backup-restore-trigger")).toHaveCount(0);

    // And the routes underneath, asked from the delegate's own session.
    // `requireAdmin()` is cookie-only and refuses before the row is read, so
    // the restore below names the REAL snapshot: a 403 on an id that does not
    // exist would prove nothing about the one that does.
    const refusals = await page.evaluate(async (snapshot: string) => {
      const call = async (path: string, init?: RequestInit) => {
        const res = await fetch(path, init);
        const body = (await res.json()) as { error: string | null };
        return { status: res.status, error: body.error };
      };
      return {
        list: await call("/api/admin/backups"),
        run: await call("/api/admin/backups/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        }),
        restore: await call(`/api/admin/backups/${snapshot}/restore`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ confirm: "RESTORE" }),
        }),
      };
    }, requireSnapshot());

    // Each refusal is named, not merely counted. A switched session is also
    // fenced off non-allowlisted endpoints (`sharing.not_permitted`), and that
    // fence answers 403 too — so a bare status check would stay green through
    // an admin gate that had been removed, with the second guard quietly
    // covering for it. The sentence says which boundary spoke.
    for (const refusal of [
      refusals.list,
      refusals.run,
      refusals.restore,
    ] as const) {
      expect(refusal.status).toBe(403);
      expect(refusal.error).toBe("Admin access required");
    }

    // The refused restore left the owner's record where the previous act put
    // it, rather than half-applying and reporting a refusal.
    const owner = await storedMeasurements();
    expect(owner.filter((m) => m.value === RESTORED_WEIGHT_KG)).toHaveLength(1);
  });
});
