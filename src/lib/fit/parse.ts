/**
 * Decode an activity FIT file: the structural scan first (`./scan.ts`), then
 * `fit-file-parser` in strict-checksum mode on exactly the bytes the scan
 * framed.
 *
 * `force: false` is not optional. The library defaults to `force: true`,
 * which skips the CRC check and recovers what it can from a damaged file;
 * the scan has already verified both checksums, and the decoder is told to
 * verify them again so a future change to the scan cannot quietly let a
 * damaged file through.
 *
 * The decoder's output is untrusted: its object keys include developer field
 * names taken from the file. Nothing reads it except `./map.ts`, which takes
 * named fields one by one through own-property checks and never spreads it.
 */
import FitParser from "fit-file-parser";

import { FitImportError } from "./errors";
import { scanFitFile, type FitScan } from "./scan";

/** The decoded file, kept opaque: only `./map.ts` reads into it. */
export type DecodedFit = Readonly<Record<string, unknown>>;

export async function decodeFitFile(
  bytes: Buffer,
): Promise<{ decoded: DecodedFit; scan: FitScan }> {
  const scan = scanFitFile(bytes);
  const parser = new FitParser({
    force: false,
    mode: "list",
    speedUnit: "m/s",
    lengthUnit: "m",
    temperatureUnit: "celsius",
  });
  try {
    const decoded = await parser.parseAsync(
      bytes.subarray(0, scan.fileLength) as Buffer<ArrayBuffer>,
    );
    return { decoded: decoded as unknown as DecodedFit, scan };
  } catch (err) {
    // The library rejects with a bare string for validation failures and an
    // Error for decoder failures; neither text is passed on, it may quote
    // the file.
    const crc =
      typeof err === "string" && /crc/i.test(err) ? "crc_mismatch" : null;
    throw new FitImportError(
      crc ?? "malformed",
      crc ? "checksum" : "the decoder refused the file",
    );
  }
}
