// Typed bindings for the Rust backend.
//
// One module so the shape of the backend is visible in one place, and so a
// renamed command breaks at compile time rather than at runtime in a tab
// nobody opened.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface PhpVersion {
  minor: string;
  patch: string;
  installed: boolean;
  running: boolean;
  port: number;
  is_default: boolean;
  eol: boolean;
  xdebug_capable: boolean;
}

export interface Site {
  id: number;
  name: string;
  domain: string;
  docroot: string;
  kind: string;
  php_minor: string;
  server: string;
  enabled: boolean;
  is_linked: boolean;
  xdebug: boolean;
  aliases: string[];
}

export interface NewSite {
  name: string;
  domain: string;
  kind: string;
  php_minor: string;
  link_path: string | null;
}

export interface ServiceState {
  name: string;
  running: boolean;
  pid: number | null;
  port: number | null;
}

export interface SystemState {
  resolver_installed: boolean;
  resolver_path: string;
  daemon_installed: boolean;
  daemon_running: boolean;
  ca_exists: boolean;
  ca_trusted: boolean;
  tld: string;
}

export interface StackStatus {
  edge_running: boolean;
  edge_port: number;
  pools: ServiceState[];
  site_count: number;
  tld: string;
  dns_running: boolean;
  /** All four legs up. Anything less is not a green lock. */
  https_ready: boolean;
  system: SystemState;
}

export interface Finding {
  level: "ok" | "info" | "warn" | "error";
  title: string;
  detail: string;
}

export interface Settings {
  tld: string;
  default_php: string;
  root: string;
  sites_dir: string;
  logs_dir: string;
}

export interface InstallProgress {
  minor: string;
  component: string;
  received: number;
  /** null when the server sends no content-length: show an indeterminate bar. */
  total: number | null;
}

/** True when running inside Tauri. The browser dev server has no backend. */
export const hasBackend = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!hasBackend) {
    throw new Error(
      "The QuickWP backend is not running. Open the desktop app (npm run tauri dev) — " +
        "the browser dev server has no stack behind it.",
    );
  }
  return invoke<T>(cmd, args);
}

export const api = {
  // stack
  stackStatus: () => call<StackStatus>("stack_status"),
  stackStart: () => call<string>("stack_start"),
  stackStop: () => call<void>("stack_stop"),
  doctor: () => call<Finding[]>("doctor"),

  // https
  httpsEnable: () => call<string>("https_enable"),
  httpsTrustCa: () => call<string>("https_trust_ca"),
  httpsRegenerateCerts: () => call<string>("https_regenerate_certs"),
  removeSystemChanges: () => call<string>("remove_system_changes"),
  dnsStart: () => call<number>("dns_start"),
  dnsStop: () => call<void>("dns_stop"),

  // php
  phpList: () => call<PhpVersion[]>("php_list"),
  phpInstall: (minor: string) => call<string>("php_install", { minor }),
  phpUninstall: (minor: string) => call<void>("php_uninstall", { minor }),
  phpStart: (minor: string) => call<number>("php_start", { minor }),
  phpStop: (minor: string) => call<boolean>("php_stop", { minor }),
  phpHealth: (minor: string) => call<string>("php_health", { minor }),
  phpSetDefault: (minor: string) => call<void>("php_set_default", { minor }),
  phpIniGet: (minor: string) => call<[string, string][]>("php_ini_get", { minor }),
  phpIniSet: (minor: string, key: string, value: string) =>
    call<string>("php_ini_set", { minor, key, value }),

  // sites
  siteList: () => call<Site[]>("site_list"),
  siteCreate: (n: NewSite) => call<Site>("site_create", { new: n }),
  siteDelete: (domain: string) => call<void>("site_delete", { domain }),
  siteSetEnabled: (domain: string, enabled: boolean) =>
    call<void>("site_set_enabled", { domain, enabled }),
  siteSetPhp: (domain: string, minor: string) => call<void>("site_set_php", { domain, minor }),
  siteAddDomain: (domain: string, alias: string) =>
    call<void>("site_add_domain", { domain, alias }),
  siteUrl: (domain: string) => call<string>("site_url", { domain }),
  siteOpen: (domain: string) => call<void>("site_open", { domain }),

  // settings
  settingsGet: () => call<Settings>("settings_get"),
  settingsSet: (key: string, value: string) => call<void>("settings_set", { key, value }),

  onInstallProgress: (cb: (p: InstallProgress) => void) => {
    if (!hasBackend) return Promise.resolve(() => {});
    return listen<InstallProgress>("php-install-progress", (e) => cb(e.payload));
  },
};

/** Backend errors arrive as strings. Keep the message; it is written to be read. */
export function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}
