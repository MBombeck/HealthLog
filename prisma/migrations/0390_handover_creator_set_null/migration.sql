-- v1.42 (#959): a handover outlives the Guardian who minted it.
--
-- `created_by_id` cascaded, so a Guardian deleting their own account deleted
-- every handover they had issued, including a claimed one whose decision the
-- new owner had not made yet. The claim had already applied the proposal
-- (possibly MANAGE for a co-Guardian), and the owner lost the one place that
-- asks them to confirm it. The creator is now cleared instead; an unclaimed
-- link without a creator is refused by the claim like any link whose creator
-- lost access.
ALTER TABLE "managed_profile_handovers" ALTER COLUMN "created_by_id" DROP NOT NULL;

ALTER TABLE "managed_profile_handovers" DROP CONSTRAINT "managed_profile_handovers_created_by_id_fkey";

ALTER TABLE "managed_profile_handovers" ADD CONSTRAINT "managed_profile_handovers_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
