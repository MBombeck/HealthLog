import { redirect } from "next/navigation";

/**
 * v1.5.4 — `/medications/new` retires.
 *
 * The medication-create surface moved into the modal wizard mounted
 * on `/medications` (`<MedicationWizardDialog>` opens whenever the
 * list page renders with `?new=1` in the URL). This page exists only
 * to keep legacy bookmarks and external links pointed at the right
 * surface; the redirect lands on the list page with the query param
 * that triggers the wizard.
 */
export default function NewMedicationRedirect() {
  redirect("/medications?new=1");
}
