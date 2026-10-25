/**
 * What is wrong with the nightly dump, read from its health once, for the
 * backups card and the readiness model alike, so the two cannot disagree.
 *
 * Pure and free of server imports: the card is a client component.
 */
import type { DatabaseBackupHealth } from "./health";

export interface DatabaseDumpProblems {
  /**
   * The newest run failed at or after the newest kept dump, for a reason other
   * than the upload: nothing was kept, or a later step (retention) failed.
   */
  failure: { at: string; error: string } | null;
  /**
   * The bucket is configured and the newest dump taken did not reach it.
   * `lastUploadAt` is the newest dump that did, or null when none ever did.
   */
  offhost: { at: string; error: string; lastUploadAt: string | null } | null;
}

export function databaseDumpProblems(
  health: Pick<
    DatabaseBackupHealth,
    "lastGood" | "lastFailure" | "offhostConfigured" | "offhost"
  >,
): DatabaseDumpProblems {
  const offhost =
    health.offhostConfigured && health.offhost.failure
      ? {
          ...health.offhost.failure,
          lastUploadAt: health.offhost.lastUploadAt,
        }
      : null;
  const failure = health.lastFailure;
  const good = health.lastGood;
  // At or after: a run that kept its dump and then failed is the newest good
  // dump and the newest failure, at the same instant.
  const sinceGood =
    failure !== null && (good === null || failure.at >= good.at);
  // That same run failing only its upload is the off-host problem, said once.
  const isTheUpload = offhost !== null && failure?.at === offhost.at;
  return { failure: sinceGood && !isTheUpload ? failure : null, offhost };
}
