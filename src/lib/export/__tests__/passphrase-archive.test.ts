import { describe, it, expect } from "vitest";
import { Buffer } from "node:buffer";
import {
  encryptArchive,
  encryptArchiveToFile,
  decryptArchive,
  parseArchiveHeader,
  EXPORT_ARGON2_PARAMS,
  MIN_EXPORT_PASSPHRASE_LENGTH,
} from "../passphrase-archive";

const PASSPHRASE = "correct horse battery staple";
const PAYLOAD = JSON.stringify({
  schemaVersion: 1,
  measurements: [{ type: "WEIGHT", value: 81.2, unit: "kg" }],
  note: "Zugangsdaten 🔐 € ñ",
});

describe("passphrase-encrypted export archive (HLX1)", () => {
  it("round-trips encrypt -> decrypt with the right passphrase", async () => {
    const archive = await encryptArchive(PAYLOAD, PASSPHRASE);
    const out = await decryptArchive(archive, PASSPHRASE);
    expect(out).toBe(PAYLOAD);
  });

  it("emits the HLX1 magic + version header", async () => {
    const archive = await encryptArchive(PAYLOAD, PASSPHRASE);
    expect(archive.subarray(0, 4).toString("ascii")).toBe("HLX1");
    expect(archive.readUInt8(4)).toBe(0x01); // version
    expect(archive.readUInt8(5)).toBe(0x01); // KDF = Argon2id
  });

  it("carries the Argon2id KDF params + salt in the header", async () => {
    const archive = await encryptArchive(PAYLOAD, PASSPHRASE);
    const { header, bodyOffset } = parseArchiveHeader(archive);
    expect(header.memoryCost).toBe(EXPORT_ARGON2_PARAMS.memoryCost);
    expect(header.timeCost).toBe(EXPORT_ARGON2_PARAMS.timeCost);
    expect(header.parallelism).toBe(EXPORT_ARGON2_PARAMS.parallelism);
    expect(header.salt.length).toBe(16);
    expect(bodyOffset).toBe(16 + 16 + 12 + 16); // header + salt + iv + tag
  });

  it("uses a random salt + iv so two archives of the same input differ", async () => {
    const a = await encryptArchive(PAYLOAD, PASSPHRASE);
    const b = await encryptArchive(PAYLOAD, PASSPHRASE);
    expect(Buffer.compare(a, b)).not.toBe(0);
    // ...but both decrypt back to the same plaintext.
    expect(await decryptArchive(a, PASSPHRASE)).toBe(PAYLOAD);
    expect(await decryptArchive(b, PASSPHRASE)).toBe(PAYLOAD);
  });

  it("fails cleanly with a wrong passphrase (no plaintext leak)", async () => {
    const archive = await encryptArchive(PAYLOAD, PASSPHRASE);
    await expect(
      decryptArchive(archive, "totally wrong passphrase"),
    ).rejects.toThrow(/wrong passphrase or corrupt archive/i);
  });

  it("fails when the ciphertext is tampered", async () => {
    const archive = await encryptArchive(PAYLOAD, PASSPHRASE);
    const tampered = Buffer.from(archive);
    tampered[tampered.length - 1] ^= 0xff; // flip a ciphertext bit
    await expect(decryptArchive(tampered, PASSPHRASE)).rejects.toThrow();
  });

  it("rejects a passphrase shorter than the minimum on encrypt", async () => {
    await expect(encryptArchive(PAYLOAD, "short")).rejects.toThrow(
      new RegExp(`at least ${MIN_EXPORT_PASSPHRASE_LENGTH}`),
    );
  });

  it("rejects a non-HLX1 buffer", () => {
    expect(() => parseArchiveHeader(Buffer.from("not an archive"))).toThrow();
  });

  it("accepts a Buffer payload, not only a string", async () => {
    const buf = Buffer.from(PAYLOAD, "utf8");
    const archive = await encryptArchive(buf, PASSPHRASE);
    expect(await decryptArchive(archive, PASSPHRASE)).toBe(PAYLOAD);
  });
});

/**
 * #1031: the encrypted export is sealed as it is produced and spooled to a
 * file, because holding it did not fit a 1 GB container for a large account.
 * The format must not change: an archive written this way opens with the
 * same `decryptArchive` every existing archive opens with.
 */
describe("encryptArchiveToFile", () => {
  it("writes an archive decryptArchive opens, byte for byte the same document", async () => {
    const { mkdtemp, readFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "hlx-spool-"));
    try {
      const pieces = Array.from({ length: 500 }, (_, i) =>
        JSON.stringify({ i, note: "ümlaut 🫀 ".repeat(i % 7) }),
      );
      const bodyPath = join(dir, "body");
      const spooled = await encryptArchiveToFile(
        async (write) => {
          await write("[");
          for (let i = 0; i < pieces.length; i++) {
            await write(i === 0 ? pieces[i]! : `,${pieces[i]}`);
          }
          await write(Buffer.from("]"));
        },
        PASSPHRASE,
        bodyPath,
      );
      const archive = Buffer.concat([spooled.prefix, await readFile(bodyPath)]);
      expect(archive.byteLength).toBe(spooled.byteLength);
      expect(await decryptArchive(archive, PASSPHRASE)).toBe(
        `[${pieces.join(",")}]`,
      );
      await expect(
        decryptArchive(archive, "wrong passphrase!!"),
      ).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
