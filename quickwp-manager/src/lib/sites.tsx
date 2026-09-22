// The site list and which site is open, shared by the sidebar (where sites are
// listed and picked) and the Sites screen (which shows the one picked and owns
// the New site dialog).

import { createContext, useContext, useState, type ReactNode } from "react";
import { useAppData } from "./appData";

const SELECTED_KEY = "nexora.selected-site";

function useSitesState() {
  // Keyed, so a reload -- after starting or stopping a site, say -- keeps the
  // list on screen and refreshes it underneath. Unkeyed, every reload went
  // back to "loading", which unmounted the whole site screen and rebuilt it:
  // the page visibly shook.
  const { data, error, loading, reload, setData } = useAppData("site-list");
  // Remembered, so Nexora reopens -- after an update, say -- on the site that
  // was open rather than on the first one.
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(SELECTED_KEY);
    } catch {
      return null;
    }
  });
  // A counter rather than a flag: every press of "+" is a new request, even
  // when the last one has not been "consumed" by a re-render yet.
  const [newSiteRequest, setNewSiteRequest] = useState(0);
  // The site preview filling the whole window: no sidebar, no details. Shared
  // because the sidebar belongs to the layout around the Sites screen. Not
  // remembered, so Nexora never opens without its sidebar.
  const [fullPreview, setFullPreview] = useState(false);

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
    select: (id: string) => {
      setSelectedId(id);
      try {
        localStorage.setItem(SELECTED_KEY, id);
      } catch {
        // Not remembered across launches; nothing else depends on it.
      }
    },
    newSiteRequest,
    requestNewSite: () => setNewSiteRequest((n) => n + 1),
    fullPreview,
    setFullPreview,
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
