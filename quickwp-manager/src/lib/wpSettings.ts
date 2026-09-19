// What the Settings and Debugging tabs read from a WordPress site.
//
// One snapshot for the lot -- WP-CLI is a process per call, and a tab that
// asked for each field separately took seconds to open. Read ahead when a site
// is selected, so a tab opens with its values already there.

import { api, type WpDebugState, type WpSettingsSnapshot } from "./api";
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
 * Read a site's settings before its tabs are opened. Called when a site is
 * selected, so Settings and Debugging have their values the moment they are
 * clicked.
 */
export function prefetchSiteSettings(domain: string) {
  prefetch(snapshotKey(domain), () => readSnapshot(domain));
  prefetch(debugKey(domain), () => api.wpDebugState(domain));
  prefetch(`wp-languages:${domain}`, () => api.wpLanguages(domain));
}
