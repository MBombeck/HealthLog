import { AdminSetupPage } from "@/components/admin/admin-setup-page";

/**
 * Admin › Setup (1.50): every server decision of the first start, with the
 * value it has now, and the environment matters the setup leaves to Admin.
 * Each row opens its setting; a "no" shows as settled.
 */
export default function AdminSetupRoute() {
  return <AdminSetupPage />;
}
