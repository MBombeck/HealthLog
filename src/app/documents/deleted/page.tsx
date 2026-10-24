import { RecentlyDeletedView } from "@/components/documents/trash/recently-deleted-view";

/**
 * Recently deleted — server shell only. The client surface owns the module
 * gate, the owner-only redirect and the list; the AuthShell owns the frame.
 */
export default function RecentlyDeletedPage() {
  return <RecentlyDeletedView />;
}
