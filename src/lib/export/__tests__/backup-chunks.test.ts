/**
 * One sealed piece of a stored backup, and what it refuses.
 *
 * Every piece is authenticated on its own, and its sealed header names the
 * copy, its position and whether it is the last. Each case below is one way a
 * stored copy can stop being the copy that was written; each has to be refused
 * before any of the piece's content is handed on.
 */
process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import {
  BackupIntegrityError,
  newChunkStreamId,
  openBackupChunk,
  sealBackupChunk,
} from "../backup-chunks";

const PAYLOAD = Buffer.from("a piece of a gzip stream");

describe("sealed backup pieces", () => {
  it("opens to exactly the payload it sealed", () => {
    const id = newChunkStreamId();
    const sealed = sealBackupChunk(id, 3, false, PAYLOAD);
    expect(
      openBackupChunk(sealed, { streamId: id, seq: 3, last: false }),
    ).toEqual(PAYLOAD);
  });

  it("does not carry the payload in the clear", () => {
    const sealed = sealBackupChunk(newChunkStreamId(), 0, true, PAYLOAD);
    expect(sealed.includes(PAYLOAD)).toBe(false);
  });

  it("refuses a piece whose bytes were altered", () => {
    const id = newChunkStreamId();
    const sealed = sealBackupChunk(id, 0, true, PAYLOAD);
    const altered = Buffer.from(sealed);
    altered[altered.byteLength - 1]! ^= 0x01;
    expect(() =>
      openBackupChunk(altered, { streamId: id, seq: 0, last: true }),
    ).toThrow(BackupIntegrityError);
  });

  it("refuses a piece stored at another position", () => {
    const id = newChunkStreamId();
    const sealed = sealBackupChunk(id, 1, false, PAYLOAD);
    expect(() =>
      openBackupChunk(sealed, { streamId: id, seq: 2, last: false }),
    ).toThrow(/written as piece 1/);
  });

  it("refuses a piece from another copy", () => {
    const sealed = sealBackupChunk(newChunkStreamId(), 0, true, PAYLOAD);
    expect(() =>
      openBackupChunk(sealed, {
        streamId: newChunkStreamId(),
        seq: 0,
        last: true,
      }),
    ).toThrow(/different stored copy/);
  });

  it("refuses a copy cut short: the last listed piece was not written last", () => {
    const id = newChunkStreamId();
    const sealed = sealBackupChunk(id, 4, false, PAYLOAD);
    expect(() =>
      openBackupChunk(sealed, { streamId: id, seq: 4, last: true }),
    ).toThrow(/more were written/);
  });

  it("refuses a last piece followed by more", () => {
    const id = newChunkStreamId();
    const sealed = sealBackupChunk(id, 4, true, PAYLOAD);
    expect(() =>
      openBackupChunk(sealed, { streamId: id, seq: 4, last: false }),
    ).toThrow(/copy lists more/);
  });

  it("refuses a piece under a key this host does not hold", () => {
    const id = newChunkStreamId();
    const sealed = sealBackupChunk(id, 0, true, PAYLOAD);
    // Re-label the key id in the binary header ([0x02][len][id…]).
    const relabelled = Buffer.from(sealed);
    relabelled[2] = "x".charCodeAt(0);
    expect(() =>
      openBackupChunk(relabelled, { streamId: id, seq: 0, last: true }),
    ).toThrow(BackupIntegrityError);
  });
});
