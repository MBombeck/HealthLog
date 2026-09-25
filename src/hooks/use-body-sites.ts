/**
 * The body sites the record holds, and what is filed at one (v1.39.2).
 *
 * One read, two callers. With no site it is the list of sites: the body-site
 * view's choices, and the suggestions a body-site field offers so the same
 * site is written the same way on a procedure and on a condition. With a site
 * it adds the visits and conditions filed there. Matching runs on the server,
 * after the decrypt; this hook sends the choice and renders the answer.
 */
import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { apiGet } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";
import type { BodySiteListDTO } from "@/lib/body-sites/dto";

export type BodySiteSide = "LEFT" | "RIGHT" | "BOTH" | null;

export function useBodySites(
  enabled: boolean,
  selection: { site: string | null; laterality: BodySiteSide } = {
    site: null,
    laterality: null,
  },
) {
  const site = selection.site?.trim() || null;
  const laterality = site ? selection.laterality : null;
  return useQuery({
    queryKey: queryKeys.bodySites(site, laterality),
    queryFn: () => {
      const sp = new URLSearchParams();
      if (site) sp.set("site", site);
      if (laterality) sp.set("laterality", laterality);
      const qs = sp.toString();
      return apiGet<BodySiteListDTO>(
        qs ? `/api/body-sites?${qs}` : "/api/body-sites",
      );
    },
    placeholderData: keepPreviousData,
    enabled,
  });
}

/**
 * The site names a body-site field suggests: every site the record holds,
 * most used first. A failed or refused read (a grant without the visits
 * section) suggests nothing and never blocks the field.
 */
export function useBodySiteSuggestions(enabled = true): string[] {
  const list = useBodySites(enabled);
  return list.data?.sites.map((site) => site.bodySite) ?? [];
}
