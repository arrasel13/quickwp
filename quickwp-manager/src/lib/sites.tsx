// The site list and which site is open, shared by the sidebar (where sites are
// listed and picked) and the Sites screen (which shows the one picked and owns
// the New site dialog).

import { createContext, useContext, useState, type ReactNode } from "react";
import { api } from "./api";
import { useAsync } from "./useAsync";

function useSitesState() {
  // Keyed, so a reload -- after starting or stopping a site, say -- keeps the
  // list on screen and refreshes it underneath. Unkeyed, every reload went
  // back to "loading", which unmounted the whole site screen and rebuilt it:
  // the page visibly shook.
  const { data, error, loading, reload, setData } = useAsync(() => api.siteList(), [], "site-list");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // A counter rather than a flag: every press of "+" is a new request, even
  // when the last one has not been "consumed" by a re-render yet.
  const [newSiteRequest, setNewSiteRequest] = useState(0);

  const sites = data ?? [];
  // Falls back to the first site, so deleting the open one lands somewhere
  // real instead of on nothing.
  const selected = sites.find((s) => String(s.id) === selectedId) ?? sites[0] ?? null;

  return {
    sites,
    error,
    loading,
    reload,
    /** Change the list on screen ahead of the backend, as an optimistic update. */
    setSites: setData,
    selected,
    select: (id: string) => setSelectedId(id),
    newSiteRequest,
    requestNewSite: () => setNewSiteRequest((n) => n + 1),
  };
}

const SitesContext = createContext<ReturnType<typeof useSitesState> | null>(null);

export function SitesProvider({ children }: { children: ReactNode }) {
  const value = useSitesState();
  return <SitesContext.Provider value={value}>{children}</SitesContext.Provider>;
}

export function useSites() {
  const value = useContext(SitesContext);
  if (!value) throw new Error("useSites is only available inside <SitesProvider>");
  return value;
}
