// What the Settings and Debugging tabs read from a WordPress site.
//
// One snapshot for the lot -- WP-CLI is a process per call, and a tab that
// asked for each field separately took seconds to open. Read ahead when a site
// is selected, so a tab opens with its values already there.

import {
  api,
  type CoreUpdate,
  type WpDebugState,
  type WpItem,
  type WpSettingsSnapshot,
} from "./api";
import { prefetch, useAsync } from "./useAsync";

/** Every option those tabs show, fetched together. */
export const SNAPSHOT_OPTIONS = [
  "permalink_structure",
  "timezone_string",
  "gmt_offset",
  "blogname",
  "blogdescription",
  "admin_email",
  "date_format",
  "time_format",
  "start_of_week",
  "posts_per_page",
  "default_role",
  "users_can_register",
  "blog_public",
];

export const snapshotKey = (domain: string) => `wp-settings:${domain}`;
export const debugKey = (domain: string) => `wp-debug:${domain}`;
export const coreUpdateKey = (domain: string) => `wp-core-update:${domain}`;
export const itemsKey = (kind: "plugin" | "theme", domain: string) =>
  `wp-items:${kind}:${domain}`;

/** How many plugins or themes have an update waiting. */
export function useItemUpdates(kind: "plugin" | "theme", domain: string) {
  const { data } = useAsync<WpItem[]>(
    () => (domain ? api.wpItems(domain, kind) : Promise.resolve([])),
    [domain, kind],
    domain ? itemsKey(kind, domain) : undefined,
  );
  return (data ?? []).filter((i) => i.update && i.update !== "none").length;
}

const readSnapshot = (domain: string) => api.wpSettingsSnapshot(domain, SNAPSHOT_OPTIONS);

export type Snapshot = {
  data: WpSettingsSnapshot | null;
  reload: () => Promise<void>;
  /** Record options just saved, so the next visit opens with them. */
  patch: (options: Record<string, string>) => void;
};

/** The site's options and wp-config.php switches, shared through the cache. */
export function useSettingsSnapshot(domain: string): Snapshot {
  const { data, reload, setData } = useAsync(
    () => readSnapshot(domain),
    [domain],
    snapshotKey(domain),
  );
  return {
    data,
    reload,
    patch: (options) =>
      setData((prev) => (prev ? { ...prev, options: { ...prev.options, ...options } } : prev)),
  };
}

/** What wp-config.php says about debug logging, and the site's own code. */
export function useDebugState(domain: string) {
  return useAsync<WpDebugState>(() => api.wpDebugState(domain), [domain], debugKey(domain));
}

/**
 * Whether WordPress has a newer release for this site -- the dashboard's own
 * notice, from the same source.
 */
export function useCoreUpdate(domain: string) {
  // An empty domain is "no WordPress site here", not a site to ask about.
  return useAsync<CoreUpdate | null>(
    () => (domain ? api.wpCoreUpdateCheck(domain) : Promise.resolve(null)),
    [domain],
    domain ? coreUpdateKey(domain) : undefined,
  );
}

/**
 * Read a site's settings before its tabs are opened. Called when a site is
 * selected, so Settings and Debugging have their values the moment they are
 * clicked.
 */
export function prefetchSiteSettings(domain: string) {
  prefetch(snapshotKey(domain), () => readSnapshot(domain));
  prefetch(debugKey(domain), () => api.wpDebugState(domain));
  prefetch(`wp-languages:${domain}`, () => api.wpLanguages(domain));
  prefetch(coreUpdateKey(domain), () => api.wpCoreUpdateCheck(domain));
  // What the WordPress tab marks: plugins and themes with updates.
  prefetch(itemsKey("plugin", domain), () => api.wpItems(domain, "plugin"));
  prefetch(itemsKey("theme", domain), () => api.wpItems(domain, "theme"));
}
