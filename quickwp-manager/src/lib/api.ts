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

export interface EngineStatus {
  engine: string;
  series: string;
  version: string;
  installed: boolean;
  running: boolean;
  port: number;
  data_dir: string;
}

export interface DbCredentials {
  name: string;
  user: string;
  password: string;
  host: string;
  port: number;
}

export interface WpItem {
  name: string;
  status: string;
  version: string;
  update: string;
  title: string;
}

export interface WpInstallResult {
  url: string;
  admin_user: string;
  /** Shown once. Never stored in the clear. */
  admin_password: string;
  db: DbCredentials;
}

export interface FoundSite {
  name: string;
  domain: string;
  aliases: string[];
  path: string;
  source: string;
  php_minor: string | null;
  is_wordpress: boolean;
  importable: boolean;
  note: string | null;
}

export interface ScanResult {
  sites: FoundSite[];
  tools: string[];
  stale_resolvers: string[];
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
  db_engine: string | null;
  db_name: string | null;
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

export interface PreflightCheck {
  id: string;
  label: string;
  ok: boolean;
  fix: string;
  /** A failed blocking check means the install cannot succeed. */
  blocking: boolean;
}

export interface VerifyItem {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
}

export interface VerifyReport {
  items: VerifyItem[];
  all_ok: boolean;
}

export interface MailStatus {
  installed: boolean;
  running: boolean;
  smtp_port: number;
  ui_port: number;
  ui_url: string;
  catch_all: boolean;
}

export interface Tunnel {
  domain: string;
  public_url: string;
  owner: "app" | "cli";
  started_at: number;
  /** Set for a share with no window to close it; the guard enforces it. */
  expires_at: number | null;
  pid: number;
}

export interface LogSource {
  id: string;
  label: string;
  path: string;
  bytes: number;
  is_app: boolean;
}

export interface DiffLine {
  line_number: number;
  before: string;
  after: string;
}

export interface ConfigDiff {
  file: string;
  changes: DiffLine[];
}

export interface DbCopyResult {
  site: string;
  source_db: string;
  target_db: string;
  tables: number;
  message: string;
}

export interface ExecLine {
  domain: string;
  stream: "stdout" | "stderr";
  text: string;
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
  httpsPreflight: () => call<PreflightCheck[]>("https_preflight"),
  httpsVerify: () => call<VerifyReport>("https_verify"),
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

  // databases
  dbList: () => call<EngineStatus[]>("db_list"),
  dbInstall: (series: string) => call<string>("db_install", { series }),
  dbStart: (series: string) => call<number>("db_start", { series }),
  dbStop: (series: string) => call<boolean>("db_stop", { series }),
  dbDatabases: (series: string) => call<string[]>("db_databases", { series }),
  dbExport: (series: string, dbName: string) =>
    call<string>("db_export", { series, dbName }),
  dbImport: (series: string, dbName: string, file: string) =>
    call<string>("db_import", { series, dbName, file }),

  // wordpress
  wpEnsureCli: () => call<string>("wp_ensure_cli"),
  wpStatus: (domain: string) =>
    call<{ is_wordpress: boolean; version: string }>("wp_status", { domain }),
  wpInstall: (
    domain: string,
    req: {
      title: string;
      admin_user: string;
      admin_email: string;
      admin_password: string | null;
      version: string | null;
    },
  ) => call<WpInstallResult>("wp_install", { domain, req }),
  wpMagicLogin: (domain: string, user: string) =>
    call<string>("wp_magic_login", { domain, user }),
  wpItems: (domain: string, kind: "plugin" | "theme") =>
    call<WpItem[]>("wp_items", { domain, kind }),
  wpInstallItem: (
    domain: string,
    kind: "plugin" | "theme",
    source: string,
    activate: boolean,
    force: boolean,
  ) => call<string>("wp_install_item", { domain, kind, source, activate, force }),
  wpSetItemState: (domain: string, kind: string, name: string, activate: boolean) =>
    call<string>("wp_set_item_state", { domain, kind, name, activate }),
  wpDeleteItem: (domain: string, kind: string, name: string) =>
    call<string>("wp_delete_item", { domain, kind, name }),
  wpSearchReplace: (domain: string, from: string, to: string, dryRun: boolean) =>
    call<string>("wp_search_replace", { domain, from, to, dryRun }),

  // migration from Herd / Valet
  migrateScan: () => call<ScanResult>("migrate_scan"),
  migrateImport: (
    requests: {
      domain: string;
      path: string;
      name: string;
      aliases: string[];
      php_minor: string;
    }[],
  ) => call<string[]>("migrate_import", { requests }),

  // mail
  mailStatus: () => call<MailStatus>("mail_status"),
  mailInstall: () => call<string>("mail_install"),
  mailStart: () => call<number>("mail_start"),
  mailStop: () => call<boolean>("mail_stop"),
  mailOpen: () => call<void>("mail_open"),
  mailSetCatchAll: (on: boolean) => call<string>("mail_set_catch_all", { on }),

  // tunnels
  tunnelStatus: () => call<{ installed: boolean; tunnels: Tunnel[] }>("tunnel_status"),
  tunnelInstall: () => call<string>("tunnel_install"),
  tunnelStart: (domain: string) => call<string>("tunnel_start", { domain }),
  tunnelStop: (domain: string) => call<boolean>("tunnel_stop", { domain }),

  // logs
  logsSources: () => call<LogSource[]>("logs_sources"),
  logsTail: (id: string, lines?: number) => call<string>("logs_tail", { id, lines }),

  // terminal — a real PTY
  ptyOpen: (id: string, domain: string, cols: number, rows: number) =>
    call<void>("pty_open", { id, domain, cols, rows }),
  ptyWrite: (id: string, data: string) => call<void>("pty_write", { id, data }),
  ptyResize: (id: string, cols: number, rows: number) =>
    call<void>("pty_resize", { id, cols, rows }),
  ptyClose: (id: string) => call<boolean>("pty_close", { id }),
  siteTerminal: (domain: string) => call<void>("site_terminal", { domain }),

  // migration stages 2 and 3
  migrateCopyDatabase: (domain: string) => call<DbCopyResult>("migrate_copy_database", { domain }),
  migratePreviewConfig: (domain: string) => call<ConfigDiff>("migrate_preview_config", { domain }),
  migrateApplyConfig: (domain: string) => call<string>("migrate_apply_config", { domain }),

  // settings
  settingsGet: () => call<Settings>("settings_get"),
  settingsSet: (key: string, value: string) => call<void>("settings_set", { key, value }),

  onInstallProgress: (cb: (p: InstallProgress) => void) => {
    if (!hasBackend) return Promise.resolve(() => {});
    return listen<InstallProgress>("php-install-progress", (e) => cb(e.payload));
  },

  onDownloadProgress: (cb: (p: InstallProgress & { id: string }) => void) => {
    if (!hasBackend) return Promise.resolve(() => {});
    return listen<InstallProgress & { id: string }>("download-progress", (e) => cb(e.payload));
  },

  onExecLine: (cb: (l: ExecLine) => void) => {
    if (!hasBackend) return Promise.resolve(() => {});
    return listen<ExecLine>("exec-line", (e) => cb(e.payload));
  },

  onPtyOutput: (cb: (p: { id: string; data: string }) => void) => {
    if (!hasBackend) return Promise.resolve(() => {});
    return listen<{ id: string; data: string }>("pty-output", (e) => cb(e.payload));
  },

  onPtyExit: (cb: (p: { id: string }) => void) => {
    if (!hasBackend) return Promise.resolve(() => {});
    return listen<{ id: string }>("pty-exit", (e) => cb(e.payload));
  },
};

/** Backend errors arrive as strings. Keep the message; it is written to be read. */
export function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}
