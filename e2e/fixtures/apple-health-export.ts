/**
 * Synthetic Apple Health `export.zip` fixtures for the import journey.
 *
 * The archives are built in memory rather than committed as binaries, for
 * two reasons. The XML stays readable in the diff — a fixture whose content
 * only exists inside a blob is a fixture nobody reviews — and the bytes stay
 * deterministic, which the kick-off route's content-hash idempotency needs:
 * a re-run of the same spec (`--repeat-each`) must resolve to the job the
 * first run created instead of queueing a second import of the same export.
 *
 * The data is invented. No real reading, account, device or name appears
 * here; every source is a fixture label and every timestamp is a fixed day
 * in the past chosen so it cannot collide with anything the rest of the
 * suite writes.
 */
import { crc32, deflateRawSync } from "node:zlib";

/** The calendar day (Europe/Berlin) every fixture record is stamped on. */
export const FIXTURE_DAY = "2019-03-04";

/**
 * What the archive claims, and what the measurements list must show for it.
 *
 * `value` is the number the row carries once the import has run, in the
 * canonical DB unit — which is NOT always the unit the record was written
 * in. That gap is the point of the walking-distance entry below.
 */
export const FIXTURE_READINGS = {
  weight: { type: "WEIGHT", value: 74.2, unit: "kg" },
  systolic: { type: "BLOOD_PRESSURE_SYS", value: 118, unit: "mmHg" },
  diastolic: { type: "BLOOD_PRESSURE_DIA", value: 76, unit: "mmHg" },
  steps: { type: "ACTIVITY_STEPS", value: 8421, unit: "steps" },
  /**
   * Written as `unit="km"`, stored in metres: 2.484 km is 2484 m. Issue #944
   * — the parser reads the mapping's unit and ignores the record's own, so
   * today the row lands as 2.484 m.
   */
  walkingDistance: { type: "WALKING_RUNNING_DISTANCE", value: 2484, unit: "m" },
} as const;

/** The refusal the extractor raises for an archive with no `export.xml`. */
export const MISSING_EXPORT_XML_REASON =
  "Archive is missing the `apple_health_export/export.xml` member";

const EXPORT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE HealthData [<!ELEMENT HealthData (Record|Workout|ClinicalRecord)*>]>
<HealthData locale="en_US">
  <ExportDate value="${FIXTURE_DAY} 21:00:00 +0100"/>
  <Me HKCharacteristicTypeIdentifierDateOfBirth="1980-01-01"/>

  <Record type="HKQuantityTypeIdentifierBodyMass"
          unit="kg"
          startDate="${FIXTURE_DAY} 07:15:00 +0100"
          endDate="${FIXTURE_DAY} 07:15:00 +0100"
          value="${FIXTURE_READINGS.weight.value}"
          sourceName="Fixture Scale"
          sourceVersion="1.0"/>

  <Record type="HKQuantityTypeIdentifierBloodPressureSystolic"
          unit="mmHg"
          startDate="${FIXTURE_DAY} 07:20:00 +0100"
          endDate="${FIXTURE_DAY} 07:20:00 +0100"
          value="${FIXTURE_READINGS.systolic.value}"
          sourceName="Fixture Cuff"
          sourceVersion="1.0"/>

  <Record type="HKQuantityTypeIdentifierBloodPressureDiastolic"
          unit="mmHg"
          startDate="${FIXTURE_DAY} 07:20:00 +0100"
          endDate="${FIXTURE_DAY} 07:20:00 +0100"
          value="${FIXTURE_READINGS.diastolic.value}"
          sourceName="Fixture Cuff"
          sourceVersion="1.0"/>

  <Record type="HKQuantityTypeIdentifierStepCount"
          unit="count"
          startDate="${FIXTURE_DAY} 09:00:00 +0100"
          endDate="${FIXTURE_DAY} 09:30:00 +0100"
          value="${FIXTURE_READINGS.steps.value}"
          sourceName="Fixture Phone"
          sourceVersion="1.0"/>

  <Record type="HKQuantityTypeIdentifierDistanceWalkingRunning"
          unit="km"
          startDate="${FIXTURE_DAY} 09:00:00 +0100"
          endDate="${FIXTURE_DAY} 09:30:00 +0100"
          value="2.484"
          sourceName="Fixture Phone"
          sourceVersion="1.0"/>
</HealthData>
`;

interface ZipMember {
  name: string;
  payload: Buffer;
}

/**
 * Minimal ZIP writer — deflate-compressed members, no Zip64, fixed
 * (zeroed) modification stamps so the same members always produce the same
 * bytes. Mirrors the hand-built archives in
 * `src/lib/import/__tests__/unzip-export-xml.test.ts`; the extractor under
 * test reads the central directory, which is what this emits.
 */
function buildZip(members: readonly ZipMember[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const member of members) {
    const nameBuf = Buffer.from(member.name, "utf8");
    const compressed = deflateRawSync(member.payload);
    const crc = crc32(member.payload);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0, 6); // flags
    localHeader.writeUInt16LE(8, 8); // method: deflate
    localHeader.writeUInt16LE(0, 10); // mtime
    localHeader.writeUInt16LE(0, 12); // mdate
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(member.payload.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra length

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0, 8); // flags
    centralHeader.writeUInt16LE(8, 10); // method: deflate
    centralHeader.writeUInt16LE(0, 12); // mtime
    centralHeader.writeUInt16LE(0, 14); // mdate
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(member.payload.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra
    centralHeader.writeUInt16LE(0, 32); // comment
    centralHeader.writeUInt16LE(0, 34); // disk number
    centralHeader.writeUInt16LE(0, 36); // internal attrs
    centralHeader.writeUInt32LE(0, 38); // external attrs
    centralHeader.writeUInt32LE(offset, 42);

    locals.push(localHeader, nameBuf, compressed);
    central.push(centralHeader, nameBuf);
    offset += localHeader.length + nameBuf.length + compressed.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk
  eocd.writeUInt16LE(0, 6); // disk with central directory
  eocd.writeUInt16LE(members.length, 8);
  eocd.writeUInt16LE(members.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...locals, centralBuf, eocd]);
}

/** A well-formed export archive carrying the five fixture records. */
export function appleHealthExportZip(): Buffer {
  return buildZip([
    {
      name: "apple_health_export/export.xml",
      payload: Buffer.from(EXPORT_XML, "utf8"),
    },
  ]);
}

/**
 * An archive that is a valid ZIP and carries no `export.xml` — the shape a
 * person produces by zipping the wrong folder. The import must refuse it and
 * write nothing.
 */
export function archiveWithoutExportXml(): Buffer {
  return buildZip([
    {
      name: "apple_health_export/export_cda.xml",
      payload: Buffer.from("<ClinicalDocument/>\n", "utf8"),
    },
  ]);
}
