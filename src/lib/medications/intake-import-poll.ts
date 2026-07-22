import { apiGet } from "@/lib/api/api-fetch";

export interface MedicationIntakeImportResult {
  imported: number;
  skippedDuplicates: number;
  skippedInvalid: number;
}

interface MedicationIntakeImportStatus {
  status: "queued" | "running" | "done" | "failed";
  result: MedicationIntakeImportResult | null;
  failureReason?: string | null;
}

interface MedicationIntakeImportPollOptions {
  readStatus?: (statusUrl: string) => Promise<MedicationIntakeImportStatus>;
  wait?: () => Promise<void>;
  maxAttempts?: number;
}

export class MedicationIntakeImportError extends Error {
  constructor(message = "Medication intake import failed") {
    super(message);
    this.name = "MedicationIntakeImportError";
  }
}

const waitForNextPoll = () =>
  new Promise<void>((resolve) => setTimeout(resolve, 1_000));

export async function waitForMedicationIntakeImport(
  statusUrl: string,
  options: MedicationIntakeImportPollOptions = {},
): Promise<MedicationIntakeImportResult> {
  const readStatus = options.readStatus ?? apiGet<MedicationIntakeImportStatus>;
  const wait = options.wait ?? waitForNextPoll;
  const maxAttempts = options.maxAttempts ?? 300;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const job = await readStatus(statusUrl);
    if (job.status === "done") {
      if (!job.result) throw new MedicationIntakeImportError();
      return job.result;
    }
    if (job.status === "failed") {
      throw new MedicationIntakeImportError(job.failureReason ?? undefined);
    }
    if (attempt + 1 < maxAttempts) await wait();
  }

  throw new MedicationIntakeImportError("Medication intake import timed out");
}
