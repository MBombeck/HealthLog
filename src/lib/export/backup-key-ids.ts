/**
 * Which application keys the ciphertext INSIDE a backup was written under.
 *
 * A disaster-recovery backup carries every encrypted column the way the
 * database holds it: a note, a document, a coach message travel as the stored
 * ciphertext, base64-encoded, and a restore writes that ciphertext back
 * verbatim. The envelope around the whole copy is sealed separately, and key
 * rotation re-seals that envelope, but it cannot reach inside it, and it
 * cannot reach a copy in the off-host bucket or a file an operator keeps on a
 * disk at all. So a backup taken before a rotation still needs the key the
 * rotation retired, and a restore without that key writes rows back that no
 * reader can open. Nothing in the restore used to notice: the envelope opened,
 * the schema passed, and the damage showed up later as notes that would not
 * decrypt.
 *
 * This module answers the question the restore has to ask first: which key
 * ids does this file need, and are they all here. Every encrypted column in a
 * backup payload is named `…Encrypted`, and each value is one of:
 *
 *   - the string codec as stored in a text column: `<keyId>.<base64>`;
 *   - a Bytes column, base64-encoded, holding the string codec as UTF-8;
 *   - a Bytes column, base64-encoded, holding the binary codec
 *     (`0x02 | keyIdLen | keyId | iv | tag | ct`);
 *   - a legacy value with no key id, which only the `v1` key opens: in a
 *     text column the bare base64 itself, in a Bytes column that base64
 *     again, encoded.
 *
 * Two readers share the classification: a walk over a parsed document (the
 * restore, the preview, the upload and the restore drill already hold one),
 * and a text scanner for a backup that is being written, which never exists
 * as a document (`createBackupKeyIdTextScanner`).
 */
import { Buffer } from "node:buffer";

import { decrypt, decryptBytes, getConfiguredKeyIds } from "@/lib/crypto";
import { ENCRYPTED_COLUMNS } from "@/lib/crypto/encrypted-columns";

/** The key id a value with no key id prefix was written under. */
export const LEGACY_INNER_KEY_ID = "v1";

const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;
const VERSIONED = /^([A-Za-z0-9_-]{1,32})\.[A-Za-z0-9+/=]+$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const BASE64_TAIL = /^[A-Za-z0-9+/=]*$/;
/** Every byte of a decoded head is a base64 character. */
const BASE64_TEXT = /^[A-Za-z0-9+/=]+$/;
const BYTES_CODEC_VERSION = 0x02;
const MIN_CIPHERTEXT_CHARS = 40;

/** How an inner value is laid out, which decides how a sample is opened. */
export type InnerCiphertextForm = "string" | "bytes-string" | "binary";

export interface InnerCiphertext {
  keyId: string;
  form: InnerCiphertextForm;
}

/**
 * The key id one inner ciphertext value needs, or null for something that is
 * not ciphertext at all (an empty string). Decodes only a prefix, so a
 * multi-megabyte document costs the same as a note.
 */
export function innerCiphertextKeyId(value: string): InnerCiphertext | null {
  // The shortest ciphertext either codec writes is 28 bytes (nonce and tag),
  // 40 characters as base64: anything shorter is not ciphertext, and reading
  // it as a legacy value would demand a key for a field that holds none.
  if (value.length < MIN_CIPHERTEXT_CHARS) return null;
  const versioned = VERSIONED.exec(value.slice(0, 64));
  if (versioned && value.indexOf(".") === versioned[1].length) {
    return { keyId: versioned[1], form: "string" };
  }
  // A Bytes column, base64-encoded. 48 characters decode to 36 bytes, which
  // covers the longest header either codec can have (2 + 32 for the binary
  // one, 33 for `<keyId>.`).
  const head = value.slice(0, 48);
  if (!BASE64.test(head)) return null;
  const bytes = Buffer.from(head, "base64");
  if (bytes.length >= 3 && bytes[0] === BYTES_CODEC_VERSION) {
    const keyIdLen = bytes[1];
    if (keyIdLen >= 1 && keyIdLen <= 32 && bytes.length >= 2 + keyIdLen) {
      const keyId = bytes.subarray(2, 2 + keyIdLen).toString("latin1");
      if (KEY_ID.test(keyId)) return { keyId, form: "binary" };
    }
  }
  const text = bytes.toString("latin1");
  const dot = text.indexOf(".");
  // The rest of the prefix has to read as base64 too, or a legacy value's
  // random bytes could pass for `<keyId>.` about once in a thousand values.
  if (
    dot > 0 &&
    KEY_ID.test(text.slice(0, dot)) &&
    BASE64_TAIL.test(text.slice(dot + 1))
  ) {
    return { keyId: text.slice(0, dot), form: "bytes-string" };
  }
  // No key id anywhere: the legacy layout, which `decrypt` opens with `v1`.
  // Which column it came from decides how it opens. A Bytes column holding a
  // legacy value carries base64 TEXT, encoded once more, so its decoded head
  // reads as base64 characters. A text column holds the bare base64 of the
  // nonce, tag and ciphertext, whose decoded head is random bytes: reading
  // that as an encoded Bytes column would base64-decode it once too often,
  // and the key that opens it would look like the wrong one.
  return {
    keyId: LEGACY_INNER_KEY_ID,
    form: BASE64_TEXT.test(text) ? "bytes-string" : "string",
  };
}

/** Whether a member name holds inner ciphertext. */
export function isEncryptedMember(name: string): boolean {
  return name.endsWith("Encrypted") && name.length > "Encrypted".length;
}

/**
 * Sections whose restore opens every inner value with this host's keys itself,
 * and keeps out (and names in the skip report) any value it cannot open.
 *
 * The cycle day-logs, custom cycle symptoms, custom mood tags and mood
 * categories, practitioners, visits and vaccinations are here because a
 * portable file written before v1.40 carried their free text as the stored
 * ciphertext,
 * not as readable text. Such a file is still restorable onto another host:
 * what that host can open comes back, what it cannot stays out of the row and
 * is reported. Refusing the whole file over a note would cost every other
 * part of the account. The trade, stated: a disaster-recovery copy whose ONLY
 * missing key sits in these sections restores with those values reported as
 * skipped instead of being refused; any other section needing the key still
 * refuses it, which in practice is every real copy.
 */
export const RESTORE_SELF_VERIFIED_SECTIONS: ReadonlySet<string> = new Set([
  "cycleDayLogs",
  "customSymptoms",
  "customMoodTags",
  "customMoodTagCategories",
  "practitioners",
  "encounters",
  "vaccinations",
]);

/**
 * One value kept to prove a key opens what it was written under: the
 * shortest of its section, so the probe of a section the caller will not
 * write never stands in for one it will.
 */
export interface KeySample {
  value: string;
  form: InnerCiphertextForm;
  /**
   * The section it was found in. Absent on a preview stored before samples
   * were kept per section; such a sample is probed whatever is ignored.
   */
  section?: string;
  /** The member it sat under, which names the label a binary value needs. */
  member?: string;
}

interface KeyUse {
  /** How many values need this key. */
  count: number;
  /** The top-level sections they sit in (`measurements`, `appSettings`, …). */
  sections: Set<string>;
  /** The shortest openable value of each section, keyed by section. */
  samples: Map<string, KeySample>;
}

/**
 * The associated-data label a binary value under `member` is sealed with,
 * from the encrypted-column registry: `undefined` for an unlabelled column
 * (a document's content), null when no binary column has that name or two
 * with that name use different labels. A null value is not probed: GCM
 * cannot tell a wrong label from a wrong key, so opening it without the
 * right one would accuse the key.
 */
const BINARY_MEMBER_AAD: ReadonlyMap<string, string | undefined | null> =
  (() => {
    const map = new Map<string, string | undefined | null>();
    for (const column of ENCRYPTED_COLUMNS) {
      if (column.codec !== "binary2" && column.codecField === undefined) {
        continue;
      }
      if (!map.has(column.field)) map.set(column.field, column.aad);
      else if (map.get(column.field) !== column.aad)
        map.set(column.field, null);
    }
    return map;
  })();

function binaryAad(member: string | undefined): string | undefined | null {
  if (member === undefined) return null;
  const aad = BINARY_MEMBER_AAD.get(member);
  return aad === undefined && !BINARY_MEMBER_AAD.has(member) ? null : aad;
}

/** A sample longer than this is not kept; opening it proves nothing more. */
const MAX_SAMPLE_CHARS = 64 * 1024;

/**
 * Collects the key ids a backup's inner ciphertext needs, with the section
 * each one appears in and one sample per key.
 */
export class BackupKeyIdCollector {
  private readonly uses = new Map<string, KeyUse>();

  /** Record one inner value found in `section`, under `member`. */
  add(section: string, value: string, member?: string): void {
    const found = innerCiphertextKeyId(value);
    if (!found) return;
    let use = this.uses.get(found.keyId);
    if (!use) {
      use = { count: 0, sections: new Set(), samples: new Map() };
      this.uses.set(found.keyId, use);
    }
    use.count += 1;
    use.sections.add(section);
    // A sample from a self-verified section proves nothing the restore needs:
    // a value there that does not open is skipped, not fatal. A binary value
    // whose label is not known cannot prove anything either.
    if (
      RESTORE_SELF_VERIFIED_SECTIONS.has(section) ||
      value.length > MAX_SAMPLE_CHARS ||
      (found.form === "binary" && binaryAad(member) === null)
    ) {
      return;
    }
    const kept = use.samples.get(section);
    if (!kept || value.length < kept.value.length) {
      use.samples.set(section, { value, form: found.form, section, member });
    }
  }

  /**
   * Walk a parsed value and record every `…Encrypted` string in it. `section`
   * names where it sits in the file; for a whole document, pass nothing and
   * each top-level member is its own section.
   */
  visit(value: unknown, section?: string): void {
    if (section === undefined) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        for (const [key, child] of Object.entries(value)) {
          this.walk(child, key, key);
        }
      }
      return;
    }
    this.walk(value, section, null);
  }

  private walk(value: unknown, section: string, member: string | null): void {
    if (typeof value === "string") {
      if (member !== null && isEncryptedMember(member)) {
        this.add(section, value, member);
      }
      return;
    }
    if (Array.isArray(value)) {
      // Elements of an array under an `…Encrypted` member are ciphertext too.
      for (const element of value) this.walk(element, section, member);
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        this.walk(child, section, key);
      }
    }
  }

  /** Every key id seen, sorted. */
  keyIds(): string[] {
    return [...this.uses.keys()].sort();
  }

  /** How many values need `keyId`. */
  count(keyId: string): number {
    return this.uses.get(keyId)?.count ?? 0;
  }

  /** @internal for `assessBackupKeys`. */
  entries(): ReadonlyMap<string, KeyUse> {
    return this.uses;
  }

  /**
   * What was collected, as plain data, for a copy's stored preview
   * (`backup-preview.ts`): enough to hold it against this host's keys again
   * later without reading the copy.
   */
  toStored(): StoredKeyUse[] {
    return [...this.uses.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([keyId, use]) => ({
        keyId,
        count: use.count,
        sections: [...use.sections].sort(),
        samples: [...use.samples.values()]
          .sort((a, b) => (a.section ?? "").localeCompare(b.section ?? ""))
          .map((sample) => ({ ...sample })),
      }));
  }

  /** The collector {@link toStored} was taken from. */
  static fromStored(stored: readonly StoredKeyUse[]): BackupKeyIdCollector {
    const collector = new BackupKeyIdCollector();
    for (const entry of stored) {
      const samples = new Map<string, KeySample>();
      for (const sample of entry.samples ?? []) {
        samples.set(sample.section ?? "", { ...sample });
      }
      // A preview stored before samples were kept per section has one.
      if (entry.sample) samples.set("", { ...entry.sample });
      collector.uses.set(entry.keyId, {
        count: entry.count,
        sections: new Set(entry.sections),
        samples,
      });
    }
    return collector;
  }
}

/** One key id a copy needs, as {@link BackupKeyIdCollector.toStored} keeps it. */
export interface StoredKeyUse {
  keyId: string;
  count: number;
  sections: string[];
  /** The shortest openable value of each section. */
  samples?: KeySample[];
  /** The one sample a preview stored before v1.40.1 kept. */
  sample?: { value: string; form: InnerCiphertextForm } | null;
}

export interface BackupKeyAssessment {
  /** Every key id the file's inner ciphertext was written under. */
  keyIds: string[];
  /** Needed and not in `ENCRYPTION_KEYS` on this host. */
  missing: string[];
  /**
   * Configured, but the sample written under it does not open: the id is
   * there with different key material behind it.
   */
  unreadable: string[];
  /** Values that need a missing or unreadable key. */
  affectedValues: number;
}

/**
 * Open one sample. The layout is read again from the value rather than taken
 * from the record: a preview stored by v1.40.0 holds legacy text values
 * marked as encoded Bytes columns, and must not keep accusing the key.
 */
function openSample(sample: KeySample) {
  const form = innerCiphertextKeyId(sample.value)?.form ?? sample.form;
  switch (form) {
    case "string":
      decrypt(sample.value);
      return;
    case "bytes-string":
      decrypt(Buffer.from(sample.value, "base64").toString("utf8"));
      return;
    case "binary": {
      const aad = binaryAad(sample.member);
      if (aad === null) throw new Error("No label known for a binary sample");
      decryptBytes(Buffer.from(sample.value, "base64"), aad);
      return;
    }
  }
}

function opensAny(samples: readonly KeySample[]): boolean {
  for (const sample of samples) {
    try {
      openSample(sample);
      return true;
    } catch {
      // The next section's sample may still prove the key.
    }
  }
  return false;
}

/**
 * Hold what the file needs against what this host has, and open values under
 * each key to prove the key under that id is the right one.
 *
 * The probes come only from sections the verdict counts: one per section,
 * the shortest. A key is unreadable when none of them opens. One copy is
 * written by one host at one moment, when each key id had one key material
 * behind it, so a configured key that opens any of its values is the key the
 * copy was written with; a single value that does not open is damage to that
 * value, and refusing the whole restore over it would cost every other part
 * of the account.
 *
 * `ignoreSections` leaves out sections the caller will not write: the
 * instance settings, when the operator has not asked for them back. The
 * sections in {@link RESTORE_SELF_VERIFIED_SECTIONS} are always left out,
 * because their restore checks each value itself.
 */
export function assessBackupKeys(
  collector: BackupKeyIdCollector,
  options: { ignoreSections?: ReadonlySet<string> } = {},
): BackupKeyAssessment {
  const ignore = options.ignoreSections ?? new Set<string>();
  const keyIds: string[] = [];
  const missing: string[] = [];
  const unreadable: string[] = [];
  let affectedValues = 0;
  // Read lazily: a file with no inner ciphertext needs no key, and must not
  // fail on a host (or a test) that has none configured.
  let configured: Set<string> | null = null;
  for (const [keyId, use] of [...collector.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (
      [...use.sections].every(
        (section) =>
          ignore.has(section) || RESTORE_SELF_VERIFIED_SECTIONS.has(section),
      )
    ) {
      continue;
    }
    keyIds.push(keyId);
    configured ??= new Set(getConfiguredKeyIds());
    if (!configured.has(keyId)) {
      missing.push(keyId);
      affectedValues += use.count;
      continue;
    }
    const probes = [...use.samples.values()].filter(
      (sample) =>
        sample.section === undefined ||
        (!ignore.has(sample.section) &&
          !RESTORE_SELF_VERIFIED_SECTIONS.has(sample.section)),
    );
    if (probes.length === 0) continue;
    if (!opensAny(probes)) {
      unreadable.push(keyId);
      affectedValues += use.count;
    }
  }
  return { keyIds, missing, unreadable, affectedValues };
}

/** The refusal code every surface answers a key problem with. */
export const BACKUP_KEY_MISSING_CODE = "backup.key.missing";

/** One sentence an operator can act on, naming the key ids. */
export function describeBackupKeyProblem(
  assessment: BackupKeyAssessment,
): string | null {
  const parts: string[] = [];
  if (assessment.missing.length > 0) {
    const ids = assessment.missing.map((id) => `'${id}'`).join(", ");
    parts.push(
      `This backup holds ${assessment.affectedValues} encrypted ${
        assessment.affectedValues === 1 ? "value" : "values"
      } written under encryption key ${ids}, which is not in ENCRYPTION_KEYS on this server. ` +
        `Add ${assessment.missing.length === 1 ? "that key" : "those keys"} back to ENCRYPTION_KEYS and restart, then try again. Nothing was changed.`,
    );
  }
  if (assessment.unreadable.length > 0) {
    const ids = assessment.unreadable.map((id) => `'${id}'`).join(", ");
    parts.push(
      `Encryption key ${ids} is configured, but it does not open the values in this backup written under that id: ` +
        `the key material behind the id differs from the one the backup was written with. Nothing was changed.`,
    );
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

/**
 * Key ids found in backup JSON as it is written, for a copy that never exists
 * as one document. Fed the text in pieces; a member split across two pieces is
 * read once the rest of it arrives.
 */
export interface BackupKeyIdTextScanner {
  feed(piece: string | Uint8Array): void;
  keyIds(): string[];
}

const MEMBER_VALUE =
  /"([A-Za-z0-9_]*Encrypted)"\s*:\s*"([A-Za-z0-9+/=._-]{0,64})(")?/g;
/** Enough of the previous piece to finish any member that straddles it. */
const CARRY_CHARS = 256;

export function createBackupKeyIdTextScanner(): BackupKeyIdTextScanner {
  const found = new Set<string>();
  let carry = "";
  return {
    feed(piece) {
      // latin1, not utf-8: every character this looks for is ASCII, and a
      // piece may end in the middle of a multi-byte character.
      const text =
        carry +
        (typeof piece === "string"
          ? piece
          : Buffer.from(
              piece.buffer,
              piece.byteOffset,
              piece.byteLength,
            ).toString("latin1"));
      MEMBER_VALUE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = MEMBER_VALUE.exec(text)) !== null) {
        const [, member, value, closed] = match;
        if (!isEncryptedMember(member)) continue;
        // A value cut off by the end of the piece is read again next time.
        if (!closed && value.length < 64) continue;
        const inner = innerCiphertextKeyId(value);
        if (inner) found.add(inner.keyId);
      }
      carry = text.slice(-CARRY_CHARS);
    },
    keyIds() {
      return [...found].sort();
    },
  };
}
