// What the whole app shows about Nexora itself -- its settings, services and
// sites -- read once, kept, and shared.
//
// Every screen reading the same thing reads it under one key, so they show
// one answer: a change made on one screen (PHP installed from the New site
// dialog, MySQL stopped from Services, a site imported from Herd) reaches all
// of them. The commands that change each key are listed in `api.ts`; after
// one succeeds, the key is fetched again for every screen showing it.
//
// It is all fetched once in the background at launch, so Nexora Settings
// opens on its values instead of on "Loading…"; each screen then refreshes
// underneath as it opens.

import { api, hasBackend, onDataChanged } from "./api";
import { prefetch, refresh, useAsync } from "./useAsync";

const FETCH = {
  settings: () => api.settingsGet(),
  "apps-installed": () => api.appsInstalled(),
  "site-list": () => api.siteList(),
  "stack-status": () => api.stackStatus(),
  "setup-status": () => api.setupStatus(),
  doctor: () => api.doctor(),
  "php-list": () => api.phpList(),
  "db-list": () => api.dbList(),
  "mariadb-list": () => api.mariadbList(),
  "adminer-status": () => api.adminerStatus(),
  "node-list": () => api.nodeList(),
  "node-lines": () => api.nodeLines(),
  "tunnel-status": () => api.tunnelStatus(),
  "migrate-scan": () => api.migrateScan(),
  "service-updates": () => api.updatesList(),
} as const;

export type AppKey = keyof typeof FETCH;
type Of<K extends AppKey> = Awaited<ReturnType<(typeof FETCH)[K]>>;

/** One piece of app data, shared with every other screen showing it. */
export function useAppData<K extends AppKey>(key: K) {
  return useAsync<Of<K>>(FETCH[key] as () => Promise<Of<K>>, [], key);
}

let started = false;

/**
 * Fetch everything in the background, once, and keep it current after
 * every change a command makes.
 */
export function startAppData() {
  if (started || !hasBackend) return;
  started = true;
  onDataChanged((keys) => refresh(keys));
  for (const key of Object.keys(FETCH) as AppKey[]) prefetch(key, FETCH[key] as () => Promise<unknown>);
}

/** Fetch these again for every screen showing them. */
export function refreshAppData(...keys: AppKey[]) {
  refresh(keys);
}
