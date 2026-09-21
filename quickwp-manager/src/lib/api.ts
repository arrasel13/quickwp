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

/** A Node install already on the machine. Nexora installs none of its own. */
export interface NodeVersion {
  /** Full version, no leading v: "22.19.0". */
  version: string;
  /** Major on its own: "22". */
  major: string;
  path: string;
  /** nvm, fnm, Volta, asdf, nodenv, n, Homebrew or system. */
  source: string;
}

/** What the Database tab shows: see `site_database`. */
export interface SiteDatabaseInfo {
  name: string;
  series: string;
  version: string;
  port: number;
  running: boolean;
  /** Adminer on this database, already logged in. */
  url: string | null;
  /** Why there is no url, when there is not. */
  error: string | null;
}

/** A newer Nexora waiting for "Close and Reopen". */
export interface UpdateOffer {
  /** Where the installer is mounted. */
  volume: string;
}

/** A site's WordPress debug logging, read from its wp-config.php. */
export interface WpDebugState {
  /** Whether WordPress writes a debug log now, however it was set up. */
  logging: boolean;
  /** Nexora's two standard lines are in wp-config.php. */
  standard: boolean;
  /** The custom code is in wp-config.php. */
  custom_active: boolean;
  /** The custom code in the file, or the last one saved for the site. */
  custom_code: string;
  standard_code: string;
  config_path: string;
}

/** A MariaDB series row: an engine status plus its support window. */
export interface MariadbStatus extends EngineStatus {
  /** When MariaDB stops supporting the series: "2029-05-29". */
  eol: string | null;
  /** Homebrew has a formula for it to install. */
  available: boolean;
}

/** One Node LTS line and what Nexora has installed on it. */
export interface NodeLine {
  major: string;
  codename: string;
  /** "active" or "maintenance". */
  phase: string;
  /** When Node stops supporting it: "2027-04-30". */
  end: string;
  latest: string;
  installed: string | null;
}

/** A newer release of something Nexora runs. */
export interface ServiceUpdate {
  service: "php" | "mysql" | "mariadb" | "node" | "adminer";
  id: string;
  name: string;
  installed: string;
  latest: string;
}

export interface UpdatesView {
  updates: ServiceUpdate[];
  /** Seconds since the epoch; 0 when never checked. */
  checked_at: number;
}

/** The Adminer on disk, and what this Nexora ships. */
export interface AdminerStatus {
  installed: boolean;
  version: string | null;
  latest: string;
  update_available: boolean;
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
  /** "none" or "available" — WP-CLI's flag, not a version number. */
  update: string;
  /** The version an update would move to; empty when there is none. */
  update_version: string;
  title: string;
}

/** A plugin or theme in the WordPress.org directory. */
export interface DirectoryItem {
  slug: string;
  name: string;
  version: string;
  author: string;
  description: string;
  /** The plugin's icon or the theme's screenshot. */
  image: string | null;
  /** Out of 100, as the directory scores them. */
  rating: number;
  num_ratings: number;
  /** Plugins only; zero when the directory does not report it. */
  active_installs: number;
  homepage: string;
}

/** A core release newer than the one a site runs. */
export interface CoreUpdate {
  version: string;
  /** "minor", "major" or "development", as WordPress classes it. */
  update_type: string;
}

/** What the Settings tab reads from a WordPress site, in one call. */
export interface WpSettingsSnapshot {
  /** wp-config.php's known switches: true only when defined true. */
  constants: Record<string, boolean>;
  options: Record<string, string>;
  /** get_locale(); empty when WordPress could not load. */
  locale: string;
}

export interface WpLanguage {
  language: string;
  english_name: string;
  native_name: string;
  /** "active", "installed" or "available". */
  status: string;
}

export interface CronEvent {
  hook: string;
  args: string;
  next_run_relative: string;
  recurrence: string;
}

export interface WpUser {
  id: string;
  login: string;
  display_name: string;
  email: string;
  /** Comma-separated, as WP-CLI reports them. */
  roles: string;
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

export interface SetupComponent {
  id: string;
  name: string;
  detail: string;
  version: string;
  /** The download, not the installed size: it is the number that costs time. */
  size_mb: number;
  installed: boolean;
}

export interface SetupStatus {
  done: boolean;
  default_php: string;
  default_mysql: string;
  tld: string;
  components: SetupComponent[];
  https_ready: boolean;
}

export interface SiteInfo {
  kind: string;
  db_name: string | null;
  db_engine: string | null;
  db_host: string | null;
  multisite: boolean;
}

export interface CertInfo {
  issued_at: string | null;
  expires_at: string | null;
  /** Every name the certificate covers, wildcard included. */
  names: string[];
  path: string;
  exists: boolean;
}

/** What a folder holds, as the New site dialog needs to know. */
export type FolderStatus = "missing" | "not_folder" | "empty" | "wordpress" | "other";

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

/** What stands where Nexora's HTTPS needs to be. */
export interface HttpsConflict {
  /** The other local environment involved, when one is recognised. */
  tool: string | null;
  /** 80 and/or 443, when something else listens on them. */
  ports: number[];
  /** The TLD's resolver file belongs to another tool. */
  resolver_taken: boolean;
  /** One password prompt can hand everything to Nexora. */
  can_take_over: boolean;
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

/** One address on a message, as Mailpit reports it. */
export interface MailAddress {
  Name: string;
  Address: string;
}

/** A caught message in a list. */
export interface MailSummary {
  ID: string;
  From: MailAddress | null;
  To: MailAddress[] | null;
  Subject: string;
  Created: string;
  Read: boolean;
  Snippet: string;
  Attachments: number;
  Tags: string[] | null;
}

export interface MailList {
  messages: MailSummary[];
  total: number;
  unread: number;
}

/** One caught message, whole. */
export interface MailMessage {
  ID: string;
  From: MailAddress | null;
  To: MailAddress[] | null;
  Cc: MailAddress[] | null;
  Subject: string;
  Date: string;
  HTML: string;
  Text: string;
  Attachments: unknown;
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

/** One of the four log streams that can explain a single site. */
export interface SiteLog {
  id: string;
  label: string;
  path: string;
  exists: boolean;
  bytes: number;
  /** Only for the WordPress debug log: whether WP is writing to it. */
  logging: boolean | null;
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

export type QuitBehavior = "ask" | "keep" | "restart" | "stop";

export interface Settings {
  tld: string;
  default_php: string;
  root: string;
  sites_dir: string;
  default_sites_dir: string;
  logs_dir: string;
  /** App bundle path. null when no editor Nexora knows is installed. */
  editor: string | null;
  /** App bundle path; Terminal.app when nothing was chosen. */
  terminal: string;
  /** App bundle path: the one chosen, else the system default browser. */
  browser: string | null;
  quit_behavior: QuitBehavior;
  language: string;
}

export interface InstalledApp {
  name: string;
  path: string;
  /** Terminals: whether it can be handed a command (site PHP + wp on PATH). */
  commands: boolean;
  /** The one macOS uses by default: Terminal.app, the default browser. */
  default: boolean;
}

/** A browser to open a site in. */
export interface BrowserChoice {
  name: string;
  path: string;
  default: boolean;
  /** What it calls a private window ("Incognito window"), when Nexora can open one. */
  private_window: string | null;
  /** The browser's own icon, as a PNG data URI. */
  icon: string | null;
}

/** A PHP installed outside Nexora. Reported, never used by sites. */
export interface SystemPhp {
  version: string;
  minor: string;
  source: string;
  path: string;
}

// Settings live in the backend, but several screens show what they say (the
// preferred editor's name, say). Saving announces it so they can re-read.
const SETTINGS_EVENT = "nexora:settings-changed";
export const notifySettingsChanged = () => window.dispatchEvent(new Event(SETTINGS_EVENT));
export const onSettingsChanged = (cb: () => void) => {
  window.addEventListener(SETTINGS_EVENT, cb);
  return () => window.removeEventListener(SETTINGS_EVENT, cb);
};

export interface InstallProgress {
  minor: string;
  component: string;
  received: number;
  /** null when the server sends no content-length: show an indeterminate bar. */
  total: number | null;
}

/** Where one preview webview goes, in CSS pixels of the window. */
export interface PreviewFrame {
  /** "main", or "mobile" beside it. */
  slot: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** 1 fills the frame; less shows a wider page shrunk to fit. */
  zoom: number;
}

/** What a preview shows: the site, WordPress admin, or the database in Adminer. */
export type PreviewView = "site" | "admin" | "database";

export type PreviewAction = "reload" | "back" | "forward" | "home" | "login";

export interface PreviewPage {
  domain: string;
  view: PreviewView;
  slot: string;
  url: string;
  /** True when a page starts loading, false once it has. */
  loading: boolean;
}

/** True when running inside Tauri. The browser dev server has no backend. */
export const hasBackend = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!hasBackend) {
    throw new Error(
      "The Nexora backend is not running. Open the desktop app (npm run tauri dev) — " +
        "the browser dev server has no stack behind it.",
    );
  }
  return invoke<T>(cmd, args);
}

/** A site's size by part, in bytes. */
export interface DiskBreakdown {
  plugins: number;
  themes: number;
  /** Null when the site has no database, or its size could not be read. */
  database: number | null;
  other: number;
}

export const api = {
  // stack
  stackStatus: () => call<StackStatus>("stack_status"),
  stackStart: () => call<string>("stack_start"),
  stackStop: () => call<void>("stack_stop"),
  doctor: () => call<Finding[]>("doctor"),

  // https
  httpsPreflight: (takeover = false) =>
    call<PreflightCheck[]>("https_preflight", { takeover }),
  httpsTldIsForeign: () => call<boolean>("https_tld_is_foreign"),
  httpsConflict: () => call<HttpsConflict>("https_conflict"),
  /** First-run setup's small fixed window (true), or the full app window. */
  windowSetupMode: (setup: boolean) => call<void>("window_setup_mode", { setup }),
  httpsVerify: () => call<VerifyReport>("https_verify"),
  httpsEnable: (takeover = false) => call<string>("https_enable", { takeover }),
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
  /** Newest first; empty when no Node is installed. */
  nodeList: () => call<NodeVersion[]>("node_list"),
  siteList: () => call<Site[]>("site_list"),
  siteCreate: (n: NewSite) => call<Site>("site_create", { new: n }),
  folderStatus: (path: string) => call<FolderStatus>("folder_status", { path }),
  siteDelete: (domain: string) => call<void>("site_delete", { domain }),
  /** Copy a site -- files, database and address -- as `<name>-copy`. */
  siteDuplicate: (domain: string) => call<Site>("site_duplicate", { domain }),
  siteSetEnabled: (domain: string, enabled: boolean) =>
    call<void>("site_set_enabled", { domain, enabled }),
  siteSetPhp: (domain: string, minor: string) => call<void>("site_set_php", { domain, minor }),
  siteAddDomain: (domain: string, alias: string) =>
    call<void>("site_add_domain", { domain, alias }),
  siteInfo: (domain: string) => call<SiteInfo>("site_info", { domain }),
  siteCertInfo: (domain: string) => call<CertInfo>("site_cert_info", { domain }),
  siteRegenerateCert: (domain: string) =>
    call<string>("site_regenerate_cert", { domain }),
  siteSetName: (domain: string, name: string) =>
    call<string>("site_set_name", { domain, name }),
  siteSetXdebug: (domain: string, on: boolean) =>
    call<string>("site_set_xdebug", { domain, on }),
  siteRemoveDomain: (domain: string, alias: string) =>
    call<string>("site_remove_domain", { domain, alias }),
  siteEnvGet: (domain: string) =>
    call<[string, string][]>("site_env_get", { domain }),
  siteEnvSet: (domain: string, entries: [string, string][]) =>
    call<string>("site_env_set", { domain, entries }),
  /** Rewrites URLs in the database, renames, re-issues the certificate. */
  siteChangeDomain: (domain: string, newDomain: string) =>
    call<string>("site_change_domain", { domain, newDomain }),
  siteMove: (domain: string, newPath: string) =>
    call<string>("site_move", { domain, newPath }),
  siteUrl: (domain: string) => call<string>("site_url", { domain }),
  siteOpen: (domain: string) => call<void>("site_open", { domain }),
  /** Adminer, already logged in to this site's database. Fetches it on first use. */
  siteAdminerUrl: (domain: string) => call<string>("site_adminer_url", { domain }),
  siteAdminerOpen: (domain: string) => call<void>("site_adminer_open", { domain }),
  /** Starts the site's MySQL if needed and returns everything the Database tab shows. */
  siteDatabase: (domain: string) => call<SiteDatabaseInfo>("site_database", { domain }),
  /** Bytes under the docroot. Walked, so it is a measurement, not an estimate. */
  siteDiskUsage: (domain: string) => call<number>("site_disk_usage", { domain }),
  siteDiskBreakdown: (domain: string) => call<DiskBreakdown>("site_disk_breakdown", { domain }),
  /** Files + database in one zip in ~/Downloads. Returns where it landed. */
  siteExportAll: (domain: string) => call<string>("site_export_all", { domain }),
  /** Open wp-admin logged in. `adminPath` is relative to wp-admin. */
  wpOpenAdmin: (domain: string, adminPath?: string) =>
    call<string>("wp_open_admin", { domain, adminPath: adminPath ?? null }),

  // ---- first run ----
  setupStatus: () => call<SetupStatus>("setup_status"),
  setupInstallAdminer: () => call<string>("setup_install_adminer"),
  setupFinish: (done: boolean) => call<void>("setup_finish", { done }),
  /** Reveal a path in Finder — a folder opens, a file is revealed selected. */
  pathOpen: (path: string) => call<void>("path_open", { path }),
  pathOpenInEditor: (path: string) => call<void>("path_open_in_editor", { path }),

  // databases
  dbList: () => call<EngineStatus[]>("db_list"),
  adminerStatus: () => call<AdminerStatus>("adminer_status"),
  adminerUpdate: () => call<string>("adminer_update"),
  /** Adminer on an engine: every database on it. MySQL unless a MariaDB series is named. */
  dbBrowse: (series?: string) => call<void>("db_browse", { series: series ?? null }),
  mariadbList: () => call<MariadbStatus[]>("mariadb_list"),
  /** Through Homebrew: a prebuilt bottle. */
  mariadbInstall: (series: string) => call<string>("mariadb_install", { series }),
  /** Installs first when it is not here yet. */
  mariadbStart: (series: string) => call<number>("mariadb_start", { series }),
  mariadbStop: (series: string) => call<boolean>("mariadb_stop", { series }),
  nodeLines: () => call<NodeLine[]>("node_lines"),
  nodeInstall: (version: string) => call<string>("node_install", { version }),
  nodeRemove: (version: string) => call<string>("node_remove", { version }),
  /** What the last check found, without looking again. */
  updatesList: () => call<UpdatesView>("updates_list"),
  updatesCheck: () => call<UpdatesView>("updates_check"),
  updateApply: (service: string, id: string) => call<string>("update_apply", { service, id }),
  /** The daily check found something, or an update was applied. */
  onServiceUpdates: (cb: (v: UpdatesView) => void) => {
    if (!hasBackend) return Promise.resolve(() => {});
    return listen<UpdatesView>("service-updates", (e) => cb(e.payload));
  },
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
  wpUsers: (domain: string) => call<WpUser[]>("wp_users", { domain }),
  /** The roles this install actually has, custom ones included. */
  wpRoles: (domain: string) => call<string[]>("wp_roles", { domain }),

  // wordpress tools — each maps to one WP-CLI subcommand
  /** null when the constant is not defined at all. */
  wpConfigGet: (domain: string, key: string) =>
    call<string | null>("wp_config_get", { domain, key }),
  wpConfigSetBool: (domain: string, key: string, on: boolean) =>
    call<string>("wp_config_set_bool", { domain, key, on }),
  wpCoreUpdateCheck: (domain: string) =>
    call<CoreUpdate | null>("wp_core_update_check", { domain }),
  wpSettingsSnapshot: (domain: string, options: string[]) =>
    call<WpSettingsSnapshot>("wp_settings_snapshot", { domain, options }),
  wpOptionGet: (domain: string, key: string) =>
    call<string>("wp_option_get", { domain, key }),
  wpOptionSet: (domain: string, key: string, value: string) =>
    call<string>("wp_option_set", { domain, key, value }),
  wpSetPermalinks: (domain: string, structure: string) =>
    call<string>("wp_set_permalinks", { domain, structure }),
  wpFlushRewrites: (domain: string) => call<string>("wp_flush_rewrites", { domain }),
  wpMaintenanceStatus: (domain: string) =>
    call<boolean>("wp_maintenance_status", { domain }),
  wpSetMaintenance: (domain: string, on: boolean) =>
    call<string>("wp_set_maintenance", { domain, on }),
  wpFlushCache: (domain: string) => call<string>("wp_flush_cache", { domain }),
  wpDeleteTransients: (domain: string) =>
    call<string>("wp_delete_transients", { domain }),
  /** Drops every table. Ask twice before calling this. */
  wpResetSite: (domain: string) => call<string>("wp_reset_site", { domain }),
  wpCoreVersion: (domain: string) => call<string>("wp_core_version", { domain }),
  wpCoreUpdate: (domain: string, version: string | null) =>
    call<string>("wp_core_update", { domain, version }),
  wpCoreReinstall: (domain: string) => call<string>("wp_core_reinstall", { domain }),
  wpVerifyChecksums: (domain: string) =>
    call<string>("wp_verify_checksums", { domain }),
  wpLanguages: (domain: string) => call<WpLanguage[]>("wp_languages", { domain }),
  wpSetLanguage: (domain: string, locale: string) =>
    call<string>("wp_set_language", { domain, locale }),
  wpCronEvents: (domain: string) => call<CronEvent[]>("wp_cron_events", { domain }),
  /** Omit the hook to run everything that is due. */
  wpCronRun: (domain: string, hook: string | null) =>
    call<string>("wp_cron_run", { domain, hook }),
  wpExportDatabase: (domain: string) => call<string>("wp_export_database", { domain }),
  wpImportDatabase: (domain: string, file: string) =>
    call<string>("wp_import_database", { domain, file }),
  wpExportContent: (domain: string) => call<string>("wp_export_content", { domain }),
  /** The password travels on stdin, never on a command line. */
  wpCreateUser: (
    domain: string,
    login: string,
    email: string,
    password: string,
    role: string,
    sendEmail = false,
  ) =>
    call<string>("wp_create_user", {
      domain,
      login,
      email,
      password,
      role,
      sendEmail,
    }),
  /** Replaces the user's roles with this one. */
  wpSetUserRole: (domain: string, login: string, role: string) =>
    call<string>("wp_set_user_role", { domain, login, role }),
  wpSetUserPassword: (domain: string, login: string, password: string) =>
    call<string>("wp_set_user_password", { domain, login, password }),
  /** The password Nexora saved for a user in the login keychain -- set at
   *  install or when it was last changed from here. null when it set none. */
  wpSavedPassword: (domain: string, login: string) =>
    call<string | null>("wp_saved_password", { domain, login }),
  /** "installed"; "not_installed" (the files, but no WordPress in the database); "no_database". */
  wpInstallState: (domain: string) =>
    call<"installed" | "not_installed" | "no_database">("wp_install_state", { domain }),
  /** Logins with a password saved for this site: names only. */
  wpSavedLogins: (domain: string) => call<string[]>("wp_saved_logins", { domain }),
  /** Set WordPress up again in a site whose database was lost. Returns the admin login. */
  wpSetUpAgain: (domain: string) => call<string>("wp_set_up_again", { domain }),
  wpDeleteUser: (domain: string, login: string, reassignTo: string | null) =>
    call<string>("wp_delete_user", { domain, login, reassignTo }),
  /** `updates: false` answers in a fraction of the time, with every `update`
   *  "none" -- unknown, not up to date. */
  wpItems: (domain: string, kind: "plugin" | "theme", updates = true) =>
    call<WpItem[]>("wp_items", { domain, kind, updates }),
  wpInstallItem: (
    domain: string,
    kind: "plugin" | "theme",
    source: string,
    activate: boolean,
    force: boolean,
  ) => call<string>("wp_install_item", { domain, kind, source, activate, force }),
  /** Clone a repo into wp-content. `owner/repo` means github.com. */
  wpInstallFromGit: (domain: string, kind: string, url: string, branch?: string) =>
    call<string>("wp_install_from_git", { domain, kind, url, branch: branch || null }),
  /** One page of the WordPress.org directory: a search, or what is popular. */
  wporgSearch: (kind: string, query: string, page?: number) =>
    call<DirectoryItem[]>("wporg_search", { kind, query, page: page ?? 1 }),
  wpSetItemState: (domain: string, kind: string, name: string, activate: boolean) =>
    call<string>("wp_set_item_state", { domain, kind, name, activate }),
  /** A theme/plugin screenshot as a data URI, or null when it has none. */
  wpItemScreenshot: (domain: string, kind: string, name: string) =>
    call<string | null>("wp_item_screenshot", { domain, kind, name }),
  wpUpdateItem: (domain: string, kind: string, name: string) =>
    call<string>("wp_update_item", { domain, kind, name }),
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
  /** A site's caught mail, or all of it with no domain; starts Mailpit if needed. */
  mailMessages: (domain: string | null, query: string) =>
    call<MailList>("mail_messages", { domain, query }),
  /** Opening a message marks it read. */
  mailMessage: (id: string) => call<MailMessage>("mail_message", { id }),
  mailRaw: (id: string) => call<string>("mail_raw", { id }),
  mailHeaders: (id: string) => call<Record<string, string[]>>("mail_headers", { id }),
  mailMarkRead: (ids: string[], all: boolean) => call<void>("mail_mark_read", { ids, all }),
  mailDelete: (ids: string[], all: boolean) => call<void>("mail_delete", { ids, all }),

  // tunnels
  tunnelStatus: () => call<{ installed: boolean; tunnels: Tunnel[] }>("tunnel_status"),
  tunnelInstall: () => call<string>("tunnel_install"),
  tunnelStart: (domain: string) => call<string>("tunnel_start", { domain }),
  tunnelStop: (domain: string) => call<boolean>("tunnel_stop", { domain }),

  // logs
  siteLogs: (domain: string) => call<SiteLog[]>("site_logs", { domain }),
  siteLogTail: (domain: string, id: string, lines?: number) =>
    call<string>("site_log_tail", { domain, id, lines }),
  /** Truncates rather than deletes — the writer holds the file open. */
  siteLogClear: (domain: string, id: string) =>
    call<string>("site_log_clear", { domain, id }),
  siteLogDownload: (domain: string, id: string) =>
    call<string>("site_log_download", { domain, id }),
  wpDebugState: (domain: string) => call<WpDebugState>("wp_debug_state", { domain }),
  wpDebugSet: (domain: string, on: boolean) => call<WpDebugState>("wp_debug_set", { domain, on }),
  wpDebugCustomInsert: (domain: string, code: string) =>
    call<WpDebugState>("wp_debug_custom_insert", { domain, code }),
  wpDebugCustomRemove: (domain: string) =>
    call<WpDebugState>("wp_debug_custom_remove", { domain }),
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
  /** A shell in one folder inside the site; refused if it is outside. */
  siteTerminalAt: (domain: string, path: string) =>
    call<void>("site_terminal_at", { domain, path }),

  // migration stages 2 and 3
  migrateCopyDatabase: (domain: string) => call<DbCopyResult>("migrate_copy_database", { domain }),
  migratePreviewConfig: (domain: string) => call<ConfigDiff>("migrate_preview_config", { domain }),
  migrateApplyConfig: (domain: string) => call<string>("migrate_apply_config", { domain }),

  // settings
  settingsGet: () => call<Settings>("settings_get"),
  settingsSet: (key: string, value: string) => call<string>("settings_set", { key, value }),
  appsInstalled: () =>
    call<{ editors: InstalledApp[]; terminals: InstalledApp[]; browsers: InstalledApp[] }>(
      "apps_installed",
    ),
  phpSystemList: () => call<SystemPhp[]>("php_system_list"),
  browserChoices: () => call<BrowserChoice[]>("browser_choices"),
  /** Open the site in a chosen browser, in a normal or private window. */
  siteOpenInBrowser: (domain: string, browser: string | null, privateWindow: boolean) =>
    call<string>("site_open_in_browser", { domain, browser, private: privateWindow }),
  /** Log in to wp-admin without a password, in a chosen browser. */
  wpMagicLoginIn: (domain: string, browser: string | null, privateWindow: boolean) =>
    call<void>("wp_magic_login_in", { domain, browser, private: privateWindow }),
  /**
   * Show one view of `domain`'s live preview where `frames` say and hide every
   * other one. `null`, or no frames, hides them all. `url` is Adminer's
   * address, for the database view.
   */
  previewLayout: (
    domain: string | null,
    view: PreviewView | null,
    frames: PreviewFrame[],
    url?: string | null,
  ) => call<void>("preview_layout", { domain, view, frames, url: url ?? null }),
  /** Load a view hidden, so switching to it is instant. */
  previewPreload: (domain: string, view: PreviewView, frame: PreviewFrame, url?: string | null) =>
    call<void>("preview_preload", { domain, view, frame, url: url ?? null }),
  /**
   * Drive one view of a preview. "home" goes where the view starts -- the
   * database view needs Adminer's `url` -- and "login" logs wp-admin in.
   */
  previewGo: (domain: string, view: PreviewView, action: PreviewAction, url?: string | null) =>
    call<void>("preview_go", { domain, view, action, url: url ?? null }),
  /**
   * A picture of the site's front page as a data URI, kept from the last
   * time the preview showed it. Null for a site never seen running.
   */
  siteThumbnail: (domain: string) => call<string | null>("site_thumbnail", { domain }),
  /** Load the menu overlay, hidden. See src/lib/overlay.ts. */
  overlayPrepare: () => call<void>("overlay_prepare"),
  /** Show a menu in the overlay, over a window of this size. */
  overlayShow: (menu: unknown, width: number, height: number) =>
    call<void>("overlay_show", { menu, width, height }),
  overlayHide: () => call<void>("overlay_hide"),
  /** The menu the overlay should be showing, for an overlay that just loaded. */
  overlayCurrent: () => call<unknown | null>("overlay_current"),
  /** Close the previews of sites no longer in `domains`. */
  previewPrune: (domains: string[]) => call<void>("preview_prune", { domains }),
  onPreviewPage: (cb: (p: PreviewPage) => void) => {
    if (!hasBackend) return Promise.resolve(() => {});
    return listen<PreviewPage>("preview-page", (e) => cb(e.payload));
  },
  /** Answer the quit prompt. The app exits; the promise may never settle. */
  appQuit: (mode: Exclude<QuitBehavior, "ask">, remember: boolean) =>
    call<void>("app_quit", { mode, remember }),

  onQuitRequested: (cb: () => void) => {
    if (!hasBackend) return Promise.resolve(() => {});
    return listen("quit-requested", () => cb());
  },

  /** A newer Nexora installer was opened: ask to close and reopen. */
  onUpdateAvailable: (cb: (offer: UpdateOffer) => void) => {
    if (!hasBackend) return Promise.resolve(() => {});
    return listen<UpdateOffer>("update-available", (e) => cb(e.payload));
  },

  /** The installer was ejected before the update was installed. */
  onUpdateWithdrawn: (cb: () => void) => {
    if (!hasBackend) return Promise.resolve(() => {});
    return listen("update-withdrawn", () => cb());
  },

  appUpdatePending: () => call<UpdateOffer | null>("app_update_pending"),
  /** Install the offered Nexora, keeping sites running, and reopen. */
  appUpdateRestart: () => call<void>("app_update_restart"),
  appUpdateLater: () => call<void>("app_update_later"),

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
