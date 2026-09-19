import { useState, useEffect, useMemo, useRef } from "react";
import { DrawerRightIcon } from "../ui/DrawerIcons";
import { api, errorText, FolderStatus, hasBackend } from "../../lib/api";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useAsync } from "../../lib/useAsync";
import { Tab, Dialog, Transition } from "@headlessui/react";
import {
  GlobeAltIcon,
  PlusIcon,
  XMarkIcon,
  CodeBracketIcon,
  FolderIcon,
  ArrowDownTrayIcon,
  ExclamationTriangleIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  EyeIcon,
  EyeSlashIcon,
} from "@heroicons/react/24/outline";
import clsx from "clsx";
import { Fragment } from "react";
import SiteOverview from "../site/SiteOverview";
import SitePreview, { type PreviewMode } from "../site/SitePreview";
import SiteHeaderMenu from "../site/SiteHeaderMenu";
import { usePref } from "../../lib/usePref";
import SiteWordPress from "../site/SiteWordPress";
import SiteSettings from "../site/SiteSettings";
import SiteDebugging from "../site/SiteDebugging";
import { prefetchSiteSettings } from "../../lib/wpSettings";
import WindowDragStrip from "../WindowDragStrip";
import { unlessWindowDrag } from "../../lib/windowDrag";
import { useSites } from "../../lib/sites";

interface WordPressSite {
  id: string;
  name: string;
  url: string;
  path: string;
  linkedPath: string;
  /** "wordpress" or "php" — WordPress sites have no Node step. */
  kind: string;
  phpVersion: string;
  status: "running" | "stopped" | "error";
}

interface SiteConfig {
  siteTitle: string;
  /** Derived from the name: the folder, and the domain's first label. */
  folderName: string;
  siteUrl: string;
  /** Where the site lives. Follows the name until a folder is chosen. */
  localPath: string;
  pathChosen: boolean;
  /** "auto": the latest release, left to update itself. "pick": `wpVersion`, held there. */
  wpVersionMode: "auto" | "pick";
  wpVersion: string;
  phpVersion: string;
  adminUser: string;
  adminPassword: string;
  adminEmail: string;
}

/** Used when the admin email is left empty -- the field's placeholder. */
const DEFAULT_ADMIN_EMAIL = "admin@localhost.com";

/** A strong admin password, so the form can be submitted as it opens. */
function generatePassword(length = 24) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#%*-_";
  const bytes = crypto.getRandomValues(new Uint32Array(length));
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

const blankConfig = (): SiteConfig => ({
  siteTitle: "",
  folderName: "",
  siteUrl: "",
  localPath: "",
  pathChosen: false,
  wpVersionMode: "auto",
  wpVersion: "",
  phpVersion: "8.3",
  adminUser: "admin",
  adminPassword: generatePassword(),
  adminEmail: "",
});

// The New site form's own look: small uppercase labels and plain section
// titles, one column.
const formLabel = "mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-gray-700";
const sectionTitle = "mb-3 text-[15px] font-semibold text-gray-900";
const radioClass = "h-4 w-4 border-gray-300 text-blue-600 focus:ring-2 focus:ring-blue-500/30";

type ProjectType = "laravel" | "existing" | "wordpress";

// Tailwind only keeps classes it can see spelled out, so the per-option colours
// are written here rather than assembled from ProjectOption.color at runtime.
const optionTones: Record<string, { bg: string; text: string }> = {
  red: { bg: "bg-red-50", text: "text-red-600" },
  blue: { bg: "bg-blue-50", text: "text-blue-600" },
  green: { bg: "bg-green-50", text: "text-green-600" },
};

// One definition for every control in the dialog. The fields had drifted into
// three different paddings, and every one of them carried `focus:ring-0`
// alongside `focus:ring-blue-300` -- the ring-0 won, so tabbing through the
// form showed no focus at all.
const fieldClass =
  "w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 " +
  "placeholder-gray-400 transition-colors focus:border-blue-500 focus:outline-none " +
  "focus:ring-2 focus:ring-blue-500/30";


// A docroot folder, a .test hostname and a database name have to survive
// exactly as typed. Left alone, the webview offers autofill, capitalises the
// first letter and underlines the lot in red, so every text field in the New
// Site dialog opts out.
// The version list is read from wordpress.org rather than baked into the app —
// a hard-coded list is how this dropdown ended up offering 6.4 as its newest
// choice long after 7.x shipped. Kept for the life of the process because the
// Sites tab remounts on every sidebar switch and the answer rarely changes.
let wpReleaseCache: string[] | null = null;

/** Stands in when the machine is offline. Correct as of the 7.1 release. */
const WP_FALLBACK_VERSIONS = ["7.1", "7.0.4", "6.9.7", "6.8.8", "6.7.7"];

/** Newest first. Descending, so a negative result means `a` is the newer one. */
function compareVersions(a: string, b: string): number {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
  }
  return 0;
}

async function fetchWpVersions(): Promise<string[]> {
  if (wpReleaseCache) return wpReleaseCache;
  const res = await fetch("https://api.wordpress.org/core/stable-check/1.0/");
  if (!res.ok) throw new Error(`wordpress.org replied ${res.status}`);
  const all = (await res.json()) as Record<string, string>;

  // One entry per release line, keeping its newest patch. Listing 7.0.1
  // through 7.0.4 as four separate choices is noise; 7.0.4 is the one anyone
  // picking "the 7.0 line" actually wants.
  const newestOfLine = new Map<string, string>();
  for (const v of Object.keys(all)) {
    const line = v.split(".").slice(0, 2).join(".");
    const held = newestOfLine.get(line);
    if (!held || compareVersions(v, held) < 0) newestOfLine.set(line, v);
  }

  wpReleaseCache = [...newestOfLine.values()].sort(compareVersions).slice(0, 5);
  return wpReleaseCache;
}

const noAutoFill = {
  autoComplete: "off",
  autoCorrect: "off",
  autoCapitalize: "off",
  spellCheck: false,
} as const;

// The traffic lights sit over the page on macOS (tauri.conf.json:
// titleBarStyle "Overlay").
const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.userAgent);

/** Narrowest the details pane goes, and the least it leaves the preview. */
const MIN_DETAILS = 360;
const MIN_PREVIEW = 320;

interface ProjectOption {
  id: ProjectType;
  name: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  color: string;
  /** Laravel has no implementation yet; the card says so instead of alerting. */
  available?: boolean;
}

export default function SitesTab({ sidebarHidden = false }: { sidebarHidden?: boolean }) {
  // Real sites, from the Rust backend. There is no mock data here any more:
  // an empty list means you have not created a site yet, and says so.
  // Whether the stack can serve a real name yet decides which URL is honest.
  const { data: stack } = useAsync(() => api.stackStatus(), [], "stack-status");
  const httpsReady = stack?.https_ready ?? false;

  // What Node this machine already has. Nexora installs none of its own, so
  // the list is whatever nvm/fnm/Volta/Homebrew/asdf put there — newest first.
  const { data: nodeInstalls } = useAsync(() => api.nodeList(), [], "node-list");
  const nodeVersions = useMemo(
    () => (nodeInstalls ?? []).map((n) => n.version),
    [nodeInstalls],
  );
  /** Newest installed, and the default selection for every site. */
  const latestNode = nodeVersions[0] ?? null;

  // The list, the selection and the "+" request are shared with the sidebar,
  // which is where sites are listed and picked.
  const {
    sites: backendSites,
    error: sitesError,
    loading: sitesLoading,
    reload: reloadSites,
    selected,
    select,
    newSiteRequest,
  } = useSites();

  const sites: WordPressSite[] = useMemo(
    () =>
      (backendSites ?? []).map((s) => ({
        id: String(s.id),
        name: s.domain,
        // The name the site answers on. The loopback address is shown beneath
        // it as the fallback, not offered as the site's address.
        url: `${httpsReady ? "https" : "http"}://${s.domain}/`,
        path: s.docroot,
        // A linked site's folder is yours; Nexora never copies or deletes it.
        linkedPath: s.is_linked ? s.docroot : "—",
        kind: s.kind,
        phpVersion: s.php_minor,
        status: s.enabled ? "running" : "stopped",
      })),
    [backendSites, httpsReady],
  );

  const selectedId = selected ? String(selected.id) : null;
  /** The unmapped row: panels need db_engine, aliases and docroot verbatim. */
  const selectedBackendSite = useMemo(
    () =>
      (backendSites ?? []).find((b) => String(b.id) === selectedId) ??
      (backendSites ?? [])[0] ??
      null,
    [backendSites, selectedId],
  );
  const selectedSite: WordPressSite | null =
    sites.find((s) => s.id === selectedId) ?? sites[0] ?? null;
  // Node is not persisted per site by the backend yet, so a choice lasts for
  // the session. It defaults to the newest version actually installed.
  const [nodeChoice, setNodeChoice] = useState<Record<string, string>>({});
  const nodeForSelected = selectedSite
    ? nodeChoice[selectedSite.id] ?? latestNode ?? "—"
    : "—";


  // Modal states
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [modalStep, setModalStep] = useState<"select" | "wordpress">("select");
  const [selectedProjectType, setSelectedProjectType] =
    useState<ProjectType | null>(null);

  // WordPress site creation states
  const [config, setConfig] = useState<SiteConfig>(blankConfig);
  // The default site directory, where a new site goes unless a folder is chosen.
  const [sitesDir, setSitesDir] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  /** What the chosen folder holds; null until one is chosen. */
  const [pathStatus, setPathStatus] = useState<FolderStatus | null>(null);
  // Populated from wordpress.org the first time the WordPress step is opened.
  const [wpVersions, setWpVersions] = useState<string[]>(WP_FALLBACK_VERSIONS);
  const [isInstalling, setIsInstalling] = useState(false);
  // What Create is doing right now, shown beside the button.
  const [currentStep, setCurrentStep] = useState("");
  /** Why the last Create failed, shown under the form. */
  const [createError, setCreateError] = useState<string | null>(null);

  // Project type options
  const projectOptions: ProjectOption[] = [
    {
      id: "laravel",
      name: "Laravel project",
      description: "Not built yet.",
      icon: CodeBracketIcon,
      color: "red",
      available: false,
    },
    {
      id: "existing",
      name: "Link a folder",
      description:
        "Serve a folder where it already is. Nothing is copied or moved.",
      icon: FolderIcon,
      color: "blue",
    },
    {
      id: "wordpress",
      name: "WordPress site",
      description:
        "WordPress, PHP and a database — downloaded and wired up for you.",
      icon: GlobeAltIcon,
      color: "green",
    },
  ];

  // Available versions
  // PHP as Nexora ships it, installed or not, read from the backend. The
  // hard-coded list this replaces had drifted to offer 7.4, which is not
  // shipped, and to leave out 8.4 and 8.5.
  const { data: phpList, reload: reloadPhp } = useAsync(() => api.phpList(), [], "php-list");
  /** A site can only be switched to a PHP that is actually installed. */
  const phpVersions = useMemo(
    () => (phpList ?? []).filter((p) => p.installed).map((p) => p.minor),
    [phpList],
  );
  // What a WordPress site needs beyond PHP. The first run installs both, so
  // creating a site uses them as they are; only one genuinely missing is
  // fetched, and the dialog says so before Create is pressed.
  const { data: setup, reload: reloadSetup } = useAsync(
    () => api.setupStatus(),
    [],
    "setup-status",
  );
  const componentReady = (id: string) =>
    setup?.components.find((c) => c.id === id)?.installed ?? false;
  const [phpDownload, setPhpDownload] = useState<{
    minor: string;
    pct: number | null;
    error: string | null;
  } | null>(null);

  // What is shown beside the details is not a tab here: the preview shows
  // the database, the logs and the mail, and its open menu starts a terminal.
  // The panels below follow this order.
  const siteDetailTabs = [
    { name: "Overview", id: "overview" },
    { name: "WordPress", id: "wordpress" },
    { name: "Settings", id: "settings" },
    { name: "Debugging", id: "debugging" },
  ];

  /** Overview opens first: what the site is, and where to go from it. */
  const DEFAULT_SITE_TAB = 0;
  // Controlled rather than defaultIndex, so switching sites can put the
  // selection back on Overview instead of wherever the last site was left.
  const [siteTab, setSiteTab] = useState(DEFAULT_SITE_TAB);
  // Tabs opened for this site stay mounted when you move between them, so
  // going back is instant: nothing refetches, and each keeps its state. Tabs
  // never opened load nothing. A new site starts over.
  const [visited, setVisited] = useState<Set<number>>(() => new Set([DEFAULT_SITE_TAB]));
  const openSiteTab = (i: number) => {
    setSiteTab(i);
    setVisited((v) => (v.has(i) ? v : new Set(v).add(i)));
  };
  useEffect(() => {
    setSiteTab(DEFAULT_SITE_TAB);
    setVisited(new Set([DEFAULT_SITE_TAB]));
  }, [selectedId]);

  // Settings is ready before it is clicked. Once Overview has had its turn,
  // its WordPress values are read in the background and the tab is built
  // hidden, so opening it shows everything at once instead of a wait on
  // WP-CLI behind "Loading…".
  const settingsDomain = selectedBackendSite?.domain;
  const settingsWordPress = selectedBackendSite?.kind === "wordpress";
  useEffect(() => {
    if (!settingsDomain || !hasBackend) return;
    const timer = window.setTimeout(() => {
      if (settingsWordPress) prefetchSiteSettings(settingsDomain);
      // Settings, and Debugging for a WordPress site.
      setVisited((v) => {
        const next = new Set(v).add(2);
        if (settingsWordPress) next.add(3);
        return next;
      });
    }, 600);
    return () => window.clearTimeout(timer);
  }, [settingsDomain, settingsWordPress]);

  // The live preview beside the details. Open, the details can be hidden to
  // give it the whole sheet ("full preview"); closed, the details have it.
  const [previewOpen, setPreviewOpen] = usePref("nexora.preview-open", true);
  // Full preview hides the sidebar too, so it is shared with the layout.
  const { fullPreview, setFullPreview } = useSites();
  const [previewMode, setPreviewMode] = usePref<PreviewMode>("nexora.preview-mode", "fit");
  const [detailsWidth, setDetailsWidth] = usePref("nexora.details-width", 480);
  const [resizing, setResizing] = useState(false);
  const splitRef = useRef<HTMLDivElement>(null);
  const detailsHidden = previewOpen && fullPreview;

  // A deleted site, or one moved to another domain, leaves no page behind.
  const domainsKey = (backendSites ?? []).map((s) => s.domain).join("\n");
  useEffect(() => {
    if (!hasBackend || sitesLoading || sitesError) return;
    void api.previewPrune(domainsKey ? domainsKey.split("\n") : []).catch(() => {});
  }, [domainsKey, sitesLoading, sitesError]);

  // Fetched lazily: opening the dialog is the first moment the list matters,
  // and an offline machine simply keeps the fallback.
  useEffect(() => {
    if (modalStep !== "wordpress") return;
    let cancelled = false;
    void fetchWpVersions()
      .then((v) => {
        if (!cancelled && v.length) setWpVersions(v);
      })
      .catch(() => {
        /* offline, or wordpress.org is down: WP_FALLBACK_VERSIONS stands */
      });
    return () => {
      cancelled = true;
    };
  }, [modalStep]);

  // The folder, the domain and -- until a folder is chosen -- the path all
  // follow the name.
  useEffect(() => {
    const folderName = config.siteTitle
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-");
    setConfig((prev) => ({
      ...prev,
      folderName,
      siteUrl: folderName ? `${folderName}.test` : "",
      localPath: prev.pathChosen
        ? prev.localPath
        : sitesDir && folderName
          ? `${sitesDir}/${folderName}`
          : sitesDir,
    }));
  }, [config.siteTitle, sitesDir]);

  // Helper functions
  const handleInputChange = (
    field: keyof SiteConfig,
    value: string | boolean
  ) => {
    setConfig((prev) => ({
      ...prev,
      [field]: value,
    }));
  };

  const openModal = () => {
    setIsModalOpen(true);
    setModalStep("select");
    setSelectedProjectType(null);
    setPhpDownload(null);
    void api
      .settingsGet()
      .then((st) => setSitesDir(st.sites_dir))
      .catch(() => {});
    // Start from a PHP that is installed -- the default when it is -- so a new
    // site is never held up behind a download nobody asked for.
    const list = phpList ?? [];
    const start = list.find((p) => p.is_default && p.installed) ?? list.find((p) => p.installed);
    if (start) setConfig((c) => ({ ...c, phpVersion: start.minor }));
    void reloadPhp();
    void reloadSetup();
  };

  const selectedPhp = (phpList ?? []).find((p) => p.minor === config.phpVersion);
  const downloadingPhp = phpDownload !== null && phpDownload.error === null;

  // A PHP that still needs downloading lives under Advanced settings; open it
  // so the reason Create is disabled is on screen.
  useEffect(() => {
    if (modalStep === "wordpress" && selectedPhp && !selectedPhp.installed) setAdvancedOpen(true);
  }, [modalStep, selectedPhp?.minor, selectedPhp?.installed]);

  /** Pick the site's folder. It must be empty, or already hold a WordPress site. */
  const chooseFolder = async () => {
    const picked = await openDialog({
      directory: true,
      multiple: false,
      defaultPath: config.pathChosen ? config.localPath : sitesDir || undefined,
    }).catch(() => null);
    if (typeof picked !== "string") return;
    setConfig((c) => ({ ...c, localPath: picked, pathChosen: true }));
    setPathStatus(await api.folderStatus(picked).catch(() => null));
  };

  const adoptingExisting = config.pathChosen && pathStatus === "wordpress";
  const pathProblem =
    config.pathChosen && pathStatus && pathStatus !== "empty" && pathStatus !== "wordpress"
      ? "This folder isn't empty. Select an empty directory or a directory with an existing WordPress site."
      : null;
  const userProblem = !adoptingExisting && !config.adminUser.trim() ? "Enter an admin username." : null;
  const passwordProblem = !adoptingExisting && !config.adminPassword ? "Enter an admin password." : null;
  const emailProblem =
    !adoptingExisting && config.adminEmail.trim() && !/^[^\s@]+@[^\s@]+$/.test(config.adminEmail.trim())
      ? "Enter a valid email address."
      : null;
  const canCreate =
    !!config.siteTitle.trim() &&
    !pathProblem &&
    !userProblem &&
    !passwordProblem &&
    !emailProblem &&
    !!selectedPhp?.installed &&
    !downloadingPhp;

  /** Download one PHP version from the dialog, beside its picker. */
  const downloadPhp = async (minor: string) => {
    setPhpDownload({ minor, pct: 0, error: null });
    const unlisten = await api.onInstallProgress((p) => {
      if (p.minor !== minor) return;
      setPhpDownload({
        minor,
        pct: p.total ? Math.round((p.received / p.total) * 100) : null,
        error: null,
      });
    });
    try {
      await api.phpInstall(minor);
      await reloadPhp();
      setPhpDownload(null);
    } catch (e) {
      setPhpDownload({ minor, pct: null, error: errorText(e) });
    } finally {
      unlisten();
    }
  };

  // The sidebar's "+" asks for the dialog; this screen owns it.
  useEffect(() => {
    if (newSiteRequest > 0) openModal();
  }, [newSiteRequest]);

  const closeModal = () => {
    setIsModalOpen(false);
    setModalStep("select");
    setSelectedProjectType(null);
    setConfig(blankConfig());
    setAdvancedOpen(false);
    setShowPassword(false);
    setPathStatus(null);
    setCreateError(null);
    setCurrentStep("");
    setIsInstalling(false);
  };

  const handleProjectSelect = async (projectType: ProjectType) => {
    setSelectedProjectType(projectType);
    if (projectType === "wordpress") {
      setModalStep("wordpress");
      return;
    }
    if (projectType === "existing") {
      // Linking serves a folder where it already is. Nothing is copied, and
      // deleting the site later removes only Nexora's record of it.
      const path = prompt(
        "Link an existing folder\n\nNexora serves it where it is — nothing is copied or " +
          "moved, and deleting the site later leaves your folder alone.\n\nFull path:",
      );
      if (!path) return;
      const suggested = path.split("/").filter(Boolean).pop() ?? "site";
      const domain = prompt("Domain for this site:", `${suggested}.test`);
      if (!domain) return;
      try {
        const linked = await api.siteCreate({
          name: suggested,
          domain,
          kind: "php",
          php_minor: "",
          link_path: path,
        });
        await reloadSites();
        select(String(linked.id));
        closeModal();
      } catch (e) {
        alert(errorText(e));
      }
      return;
    }
    alert("Laravel projects are not built yet.");
    closeModal();
  };

  const createSite = async () => {
    setIsInstalling(true);
    setCreateError(null);
    const wantsWordPress = selectedProjectType === "wordpress";

    try {
      const versions = await api.phpList();
      const chosen = versions.find((v) => v.minor === config.phpVersion);
      if (!chosen) throw new Error(`PHP ${config.phpVersion} is not a version Nexora ships.`);
      // Never downloaded here: the dialog offers the download beside the
      // version, and Create stays disabled until it is done.
      if (!chosen.installed) {
        throw new Error(`PHP ${config.phpVersion} is not installed. Download it first.`);
      }

      if (wantsWordPress) {
        const engines = await api.dbList();
        const engine = engines.find((e) => e.installed) ?? engines[0];
        const cliReady =
          (await api.setupStatus()).components.find((c) => c.id === "wp-cli")?.installed ?? false;
        // Only what is genuinely missing is fetched -- normally nothing, since
        // the first run installs both.
        if (!engine.installed) {
          setCurrentStep(`Downloading MySQL ${engine.series}…`);
          await api.dbInstall(engine.series);
        }
        if (!engine.running) {
          setCurrentStep("Starting MySQL…");
          await api.dbStart(engine.series);
        }
        if (!cliReady) {
          setCurrentStep("Downloading WP-CLI…");
          await api.wpEnsureCli();
        }
      }

      // A chosen folder is checked again now: it may have changed since.
      let adoptExisting = false;
      if (wantsWordPress && config.pathChosen) {
        const status = await api.folderStatus(config.localPath);
        if (status !== "empty" && status !== "wordpress") {
          throw new Error(
            `${config.localPath} isn't empty. Select an empty directory or a directory with an existing WordPress site.`,
          );
        }
        adoptExisting = status === "wordpress";
      }

      setCurrentStep("Creating the site…");
      const site = await api.siteCreate({
        name: config.siteTitle || config.folderName,
        domain: config.siteUrl,
        kind: wantsWordPress ? "wordpress" : "php",
        php_minor: config.phpVersion,
        link_path: wantsWordPress && config.pathChosen ? config.localPath : null,
      });

      setCurrentStep("Starting PHP…");
      await api.phpStart(site.php_minor);
      await api.stackStart();

      // A folder that already holds WordPress is linked as it is: `wp core
      // download --force` and a fresh wp-config.php would overwrite it.
      if (wantsWordPress && !adoptExisting) {
        const pinned = config.wpVersionMode === "pick" && config.wpVersion ? config.wpVersion : null;
        setCurrentStep("Installing WordPress…");
        // The admin password goes to the login keychain, so Overview can copy it.
        await api.wpInstall(site.domain, {
          title: config.siteTitle || site.domain,
          admin_user: config.adminUser.trim() || "admin",
          admin_email: config.adminEmail.trim() || DEFAULT_ADMIN_EMAIL,
          admin_password: config.adminPassword || null,
          version: pinned,
        });
        if (pinned) {
          // Held at the chosen release; core auto-updates would move it on.
          // Not worth failing a finished site over.
          await api.wpConfigSetBool(site.domain, "WP_AUTO_UPDATE_CORE", false).catch(() => {});
        }
      }

      await reloadSites();
      // No success screen: the new site opens, and its Overview is the result.
      closeModal();
      select(String(site.id));
    } catch (e) {
      setCreateError(errorText(e));
      setIsInstalling(false);
      setCurrentStep("");
    }
  };

  // Version switching functions
  const handlePhpVersionChange = async (version: string) => {
    if (!selectedSite) return;
    try {
      // A site stores a minor, never a patch. Switching regenerates no config
      // and touches no certificate -- it just points at another pool.
      await api.siteSetPhp(selectedSite.name, version);
      await reloadSites();
    } catch (e) {
      alert(errorText(e));
    }
  };

  const handleNodeVersionChange = (version: string) => {
    if (!selectedSite) return;
    // Remembered for the session only: there is no per-site Node column in
    // the database yet, so nothing would survive a restart.
    setNodeChoice((prev) => ({ ...prev, [selectedSite.id]: version }));
  };

  // Every hook above this point runs unconditionally; these early returns are
  // after the last one, so the order stays stable.
  if (sitesError) {
    return (
      <div className="p-8">
        <div className="max-w-xl border border-red-200 bg-red-50 rounded-lg p-5">
          <h2 className="text-sm font-semibold text-red-900 mb-1">
            Could not read your sites
          </h2>
          <p className="text-xs text-red-800 leading-relaxed">{sitesError}</p>
        </div>
      </div>
    );
  }

  // Only the very first load has nothing to show. A reload keeps the screen
  // it has -- replacing it with "Loading" and back is what made it shake.
  if (sitesLoading && backendSites.length === 0) {
    return (
      <div className="p-8 text-xs text-gray-500">Loading sites…</div>
    );
  }


  return (
    // h-full, not h-screen: the tab sits in an inset sheet shorter than the
    // window, and a screen-tall root would overflow it.
    <div className="h-full flex flex-col">
      {/* The dialog below must stay mounted even with no sites, or
          "New site" sets state with nothing there to show it. */}
      {selectedSite ? (
        <>
      <div ref={splitRef} className="flex min-h-0 flex-1">
      {/* The details. Hidden, not unmounted, in full preview: the terminal
          and Adminer keep their state. */}
      <div
        className={clsx(
          "flex min-w-0 flex-col",
          previewOpen ? "flex-shrink-0" : "flex-1",
          detailsHidden && "hidden",
        )}
        style={
          previewOpen
            ? { width: detailsWidth, minWidth: MIN_DETAILS, maxWidth: `calc(100% - ${MIN_PREVIEW}px)` }
            : undefined
        }
      >
      {/* Header: the site in view, named the way the sidebar names it. */}
      <div
        data-tauri-drag-region="deep"
        className={clsx(
          "flex-shrink-0 px-3 pb-3",
          // With no sidebar the window's traffic lights are over this row, so
          // the site drops below them rather than being pushed aside.
          sidebarHidden && isMac ? "pt-10" : "pt-5",
        )}
      >
        {selectedBackendSite && <SiteHeaderMenu site={selectedBackendSite} />}
      </div>

      {/* Main Content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Right Content - Site Details */}
        <div className="flex-1 flex flex-col bg-gray-50 overflow-hidden min-h-0">
          {/* Site Detail Tabs */}
          <Tab.Group
            as="div"
            className="flex flex-col flex-1 min-h-0"
            selectedIndex={siteTab}
            onChange={openSiteTab}
          >
            {/* Scrolls sideways when the details pane is too narrow for
                every tab. */}
            <Tab.List data-tauri-drag-region="deep" className="no-scrollbar flex flex-shrink-0 gap-0.5 overflow-x-auto border-b border-gray-200 bg-white px-2">
              {siteDetailTabs.map((tab) => (
                <Tab
                  key={tab.id}
                  className={({ selected }) =>
                    clsx(
                      "relative flex-shrink-0 whitespace-nowrap px-2.5 py-3 text-[13px] font-medium transition-colors focus:outline-none focus-visible:outline-none focus:ring-0 active:outline-none",
                      selected ? "text-gray-900" : "text-gray-500 hover:text-gray-900"
                    )
                  }
                >
                  {({ selected }) => (
                    <>
                      {tab.name}
                      {/* An element, not a border: the global tab focus
                          rule strips borders, hiding the marker on click. */}
                      {selected && (
                        <span className="absolute inset-x-2 bottom-0 h-0.5 bg-gray-900" />
                      )}
                    </>
                  )}
                </Tab>
              ))}
            </Tab.List>

            {/* The container the tabs' pane-* breakpoints measure. */}
            <Tab.Panels className="flex-1 overflow-hidden min-h-0 [container-type:inline-size]">
              {/* Overview */}
              <LazyPanel seen={visited.has(0)} className="h-full overflow-y-auto">
                {selectedBackendSite && (
                  <SiteOverview site={selectedBackendSite} />
                )}
              </LazyPanel>

              {/* WordPress */}
              <LazyPanel seen={visited.has(1)} className="h-full overflow-y-auto">
                {selectedBackendSite && (
                  <SiteWordPress
                    domain={selectedSite.name}
                    docroot={selectedBackendSite.docroot}
                    site={selectedBackendSite}
                    onDeleted={() => void reloadSites()}
                  />
                )}
              </LazyPanel>

              {/* Settings */}
              <LazyPanel seen={visited.has(2)} className="h-full overflow-y-auto">
                {selectedBackendSite ? (
                  <SiteSettings
                    site={selectedBackendSite}
                    onChanged={async () => {
                      await reloadSites();
                    }}
                    environment={{
                      phpVersions,
                      nodeInstalls: nodeInstalls ?? [],
                      nodeSelected: nodeForSelected,
                      onNodeChange: handleNodeVersionChange,
                      onPhpChange: (v) => void handlePhpVersionChange(v),
                    }}
                  />
                ) : null}
              </LazyPanel>

              {/* Debugging */}
              <LazyPanel seen={visited.has(3)} className="h-full overflow-y-auto">
                {selectedBackendSite &&
                  (selectedBackendSite.kind === "wordpress" ? (
                    <SiteDebugging
                      site={selectedBackendSite}
                      onChanged={() => void reloadSites()}
                    />
                  ) : (
                    <p className="p-4 text-xs text-gray-500">
                      Debugging is WordPress's own: this site has no wp-config.php to set it in.
                    </p>
                  ))}
              </LazyPanel>
            </Tab.Panels>
          </Tab.Group>
        </div>
      </div>
      {/* The foot of the details, where the preview is shown and hidden. */}
      <div className="flex h-10 flex-shrink-0 items-center justify-end border-t border-gray-200 bg-white px-2">
        <button
          type="button"
          onClick={() => {
            setFullPreview(false);
            setPreviewOpen((o) => !o);
          }}
          aria-pressed={previewOpen}
          aria-label={previewOpen ? "Hide preview" : "Show preview"}
          title={previewOpen ? "Hide preview" : "Show preview"}
          className="grid h-8 w-8 place-items-center rounded-md text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-wp-blue/30"
        >
          <DrawerRightIcon className="h-5 w-5" />
        </button>
      </div>
      </div>

      {previewOpen && !detailsHidden && (
        <Resizer
          width={detailsWidth}
          onWidth={setDetailsWidth}
          onDragging={setResizing}
          containerRef={splitRef}
        />
      )}
      {/* Kept mounted while closed, so it remembers the page it was on. */}
      {selectedBackendSite && (
        <div className={clsx("min-w-0 flex-1", !previewOpen && "hidden")}>
          <SitePreview
            site={selectedBackendSite}
            visible={previewOpen && !resizing}
            mode={previewMode}
            onModeChange={setPreviewMode}
            fullPreview={detailsHidden}
            onFullPreviewChange={setFullPreview}
            onReveal={() => setPreviewOpen(true)}
            httpsReady={httpsReady}
          />
        </div>
      )}
      </div>
        </>
      ) : (
        <div data-tauri-drag-region="deep" className="flex-1 overflow-y-auto bg-gradient-to-b from-gray-50 to-white">
          <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col justify-center px-8 py-12">
            {/* Hero */}
            <div className="text-center">
              <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-blue-50 ring-1 ring-inset ring-blue-100">
                <GlobeAltIcon className="h-8 w-8 text-blue-600" />
              </div>
              <h2 className="text-2xl font-bold tracking-tight text-gray-900">
                No sites yet
              </h2>
              <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-gray-600">
                Create your first site and Nexora provisions a docroot, wires it to a
                PHP pool, and serves it on a{" "}
                <span className="font-medium text-gray-900">.test</span> name.
              </p>
              <button
                onClick={openModal}
                className="mt-6 inline-flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
              >
                <PlusIcon className="h-4 w-4" />
                New site
              </button>
            </div>

          </div>
        </div>
      )}

      {/* Add New Site Modal */}
      <Transition appear show={isModalOpen} as={Fragment}>
        <Dialog
          as="div"
          className="relative z-50"
          // Escape and backdrop clicks are ignored mid-install: closing would
          // hide a running installation, not stop it -- and would take the
          // one-time admin password with it.
          onClose={isInstalling ? () => {} : unlessWindowDrag(closeModal)}
        >
          <Transition.Child
            as={Fragment}
            enter="ease-out duration-200"
            enterFrom="opacity-0"
            enterTo="opacity-100"
            leave="ease-in duration-150"
            leaveFrom="opacity-100"
            leaveTo="opacity-0"
          >
            <div className="fixed inset-0 bg-gray-900/40" />
          </Transition.Child>

          <div className="fixed inset-0 overflow-y-auto">
            <div className="flex min-h-full items-center justify-center p-4">
              <Transition.Child
                as={Fragment}
                enter="ease-out duration-200"
                enterFrom="opacity-0 scale-95"
                enterTo="opacity-100 scale-100"
                leave="ease-in duration-150"
                leaveFrom="opacity-100 scale-100"
                leaveTo="opacity-0 scale-95"
              >
                <Dialog.Panel
                  className={clsx(
                    "flex max-h-[90vh] w-full flex-col overflow-hidden rounded-2xl bg-white text-left shadow-2xl",
                    modalStep === "select" ? "max-w-4xl" : "max-w-xl",
                  )}
                >
                  {/* Header — shared by both steps */}
                  <div className="flex items-start justify-between gap-4 border-b border-gray-200 px-6 py-4">
                    <div className="min-w-0">
                      <Dialog.Title
                        as="h3"
                        className="text-base font-semibold text-gray-900"
                      >
                        {modalStep === "select"
                          ? "Add a new site"
                          : "Create a new site"}
                      </Dialog.Title>
                      <p className="mt-0.5 text-xs text-gray-500">
                        {modalStep === "select"
                          ? "Pick what you want Nexora to serve."
                          : "Choose a name and we'll set up a fresh WordPress site on your machine."}
                      </p>
                    </div>
                    <button
                      onClick={closeModal}
                      disabled={isInstalling}
                      aria-label="Close"
                      className="-mr-1 rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600 disabled:pointer-events-none disabled:opacity-40"
                    >
                      <XMarkIcon className="h-5 w-5" />
                    </button>
                  </div>

                  {modalStep === "select" && (
                    <>
                      <div className="flex-1 overflow-y-auto p-6">
                        <div className="grid gap-3 sm:grid-cols-3">
                          {projectOptions.map((option) => {
                            const tone = optionTones[option.color];
                            const disabled = option.available === false;
                            return (
                              <button
                                key={option.id}
                                onClick={() => handleProjectSelect(option.id)}
                                disabled={disabled}
                                className={clsx(
                                  "group relative rounded-xl border p-4 text-left transition-all focus:outline-none focus:ring-2 focus:ring-blue-500",
                                  disabled
                                    ? "cursor-not-allowed border-gray-200 opacity-60"
                                    : "border-gray-200 hover:-translate-y-0.5 hover:border-blue-300 hover:shadow-md"
                                )}
                              >
                                {disabled && (
                                  <span className="absolute right-3 top-3 rounded bg-gray-200 px-1.5 py-0.5 text-[8px] font-medium text-gray-600">
                                    Soon
                                  </span>
                                )}
                                <div
                                  className={clsx(
                                    "mb-3 flex h-10 w-10 items-center justify-center rounded-lg",
                                    tone.bg
                                  )}
                                >
                                  <option.icon
                                    className={clsx("h-5 w-5", tone.text)}
                                  />
                                </div>
                                <div className="text-sm font-semibold text-gray-900">
                                  {option.name}
                                </div>
                                <p className="mt-1 text-xs leading-relaxed text-gray-500">
                                  {option.description}
                                </p>
                              </button>
                            );
                          })}
                        </div>
                      </div>

                      <div className="flex justify-end border-t border-gray-200 bg-gray-50 px-6 py-4">
                        <button
                          onClick={closeModal}
                          className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50"
                        >
                          Cancel
                        </button>
                      </div>
                    </>
                  )}

                  {modalStep === "wordpress" && (
                    <>
                      <div className="flex-1 overflow-y-auto bg-gray-50 px-5 py-6">
                        {/* The form steps aside while the site is created and
                            once it is done; a failed run shows it again, with
                            the log beneath saying why. */}
                        {/* The form stays up while the site is created --
                            disabled, with Create showing progress -- and the
                            new site opens when it is done. */}
                        <fieldset
                          disabled={isInstalling}
                          className="m-0 min-w-0 border-0 p-0 transition-opacity disabled:opacity-70"
                        >
                        {(
                          <div className="mx-auto max-w-md rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
                            <label htmlFor="wp-site-title" className={formLabel}>
                              Site name (required)
                            </label>
                            <input
                              id="wp-site-title"
                              {...noAutoFill}
                              type="text"
                              value={config.siteTitle}
                              onChange={(e) => handleInputChange("siteTitle", e.target.value)}
                              placeholder="My WordPress Website"
                              autoFocus
                              className={fieldClass}
                            />

                            <button
                              type="button"
                              onClick={() => setAdvancedOpen((o) => !o)}
                              aria-expanded={advancedOpen}
                              aria-controls="new-site-advanced"
                              className="mt-4 inline-flex items-center gap-1.5 rounded text-sm font-medium text-gray-700 transition-colors hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                            >
                              <ChevronRightIcon
                                className={clsx("h-3.5 w-3.5 transition-transform", advancedOpen && "rotate-90")}
                              />
                              Advanced settings
                            </button>

                            {advancedOpen && (
                              <div id="new-site-advanced" className="mt-5 space-y-6">
                                <section>
                                  <h4 className={sectionTitle}>Site details</h4>

                                  <label htmlFor="wp-path" className={formLabel}>
                                    Local path
                                  </label>
                                  <div
                                    className={clsx(
                                      "flex items-center rounded-lg border bg-white focus-within:ring-2 focus-within:ring-blue-500/30",
                                      pathProblem ? "border-red-400" : "border-gray-300",
                                    )}
                                  >
                                    <input
                                      id="wp-path"
                                      readOnly
                                      value={config.localPath}
                                      title={config.localPath}
                                      onClick={() => void chooseFolder()}
                                      className="min-w-0 flex-1 cursor-pointer truncate rounded-l-lg border-0 bg-transparent px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-0"
                                    />
                                    <button
                                      type="button"
                                      onClick={() => void chooseFolder()}
                                      className="flex-shrink-0 rounded-r-lg px-3 py-2 text-sm font-medium text-gray-800 transition-colors hover:text-blue-700 focus:outline-none"
                                    >
                                      Choose…
                                    </button>
                                  </div>
                                  <p
                                    className={clsx(
                                      "mt-1.5 text-xs leading-relaxed",
                                      pathProblem ? "text-red-700" : adoptingExisting ? "text-green-700" : "text-gray-500",
                                    )}
                                  >
                                    {pathProblem ??
                                      (adoptingExisting
                                        ? "This folder already has a WordPress site. Nexora links it as it is — nothing is reinstalled."
                                        : "Select an empty directory or a directory with an existing WordPress site.")}
                                  </p>

                                  {!adoptingExisting && (
                                    <div className="mt-5" role="radiogroup" aria-labelledby="wp-version-label">
                                      <p id="wp-version-label" className={formLabel}>
                                        WordPress version
                                      </p>
                                      <label className="flex cursor-pointer items-start gap-2.5">
                                        <input
                                          type="radio"
                                          name="wp-version-mode"
                                          checked={config.wpVersionMode === "auto"}
                                          onChange={() => handleInputChange("wpVersionMode", "auto")}
                                          className={clsx(radioClass, "mt-0.5")}
                                        />
                                        <span>
                                          <span className="block text-sm text-gray-900">Automatic updates</span>
                                          <span className="block text-xs leading-relaxed text-gray-500">
                                            WordPress installs updates on its own schedule.
                                            {wpVersions[0] ? ` Will install version ${wpVersions[0]}.` : ""}
                                          </span>
                                        </span>
                                      </label>
                                      <label className="mt-2 flex cursor-pointer items-center gap-2.5">
                                        <input
                                          type="radio"
                                          name="wp-version-mode"
                                          checked={config.wpVersionMode === "pick"}
                                          onChange={() =>
                                            setConfig((c) => ({
                                              ...c,
                                              wpVersionMode: "pick",
                                              wpVersion: c.wpVersion || wpVersions[0] || "",
                                            }))
                                          }
                                          className={radioClass}
                                        />
                                        <span className="text-sm text-gray-900">Select a version</span>
                                      </label>
                                      <div className="ml-6 mt-2 w-44">
                                        <select
                                          id="wp-version"
                                          aria-label="WordPress version to install"
                                          value={config.wpVersion || wpVersions[0] || ""}
                                          onChange={(e) =>
                                            setConfig((c) => ({
                                              ...c,
                                              wpVersionMode: "pick",
                                              wpVersion: e.target.value,
                                            }))
                                          }
                                          className={clsx(
                                            fieldClass,
                                            "pr-9",
                                            config.wpVersionMode !== "pick" && "text-gray-500",
                                          )}
                                        >
                                          {wpVersions.map((v) => (
                                            <option key={v} value={v}>
                                              {v}
                                            </option>
                                          ))}
                                        </select>
                                      </div>
                                    </div>
                                  )}
                                </section>

                                <section className="border-t border-gray-200 pt-6">
                                  <h4 className={sectionTitle}>PHP environment</h4>
                                  <label htmlFor="wp-php" className={formLabel}>
                                    PHP version
                                  </label>
                                  <div className="flex items-center gap-2">
                                    <div className="w-48">
                                      <select
                                        id="wp-php"
                                        value={config.phpVersion}
                                        onChange={(e) => {
                                          handleInputChange("phpVersion", e.target.value);
                                          setPhpDownload(null);
                                        }}
                                        disabled={downloadingPhp}
                                        // pr-9 keeps a long label clear of the arrow
                                        // the forms plugin draws.
                                        className={clsx(fieldClass, "pr-9")}
                                      >
                                        {(phpList ?? []).map((p) => (
                                          <option key={p.minor} value={p.minor}>
                                            {p.minor}
                                            {p.installed ? "" : " (not installed)"}
                                          </option>
                                        ))}
                                      </select>
                                    </div>
                                    {selectedPhp && !selectedPhp.installed && (
                                      <button
                                        type="button"
                                        onClick={() => void downloadPhp(selectedPhp.minor)}
                                        disabled={downloadingPhp}
                                        title={`Download PHP ${selectedPhp.minor} (about 35 MB)`}
                                        className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-lg border border-blue-600 bg-white px-3 py-2 text-sm font-medium text-blue-700 transition-colors hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-60"
                                      >
                                        <ArrowDownTrayIcon className="h-4 w-4" />
                                        {downloadingPhp
                                          ? phpDownload?.pct != null
                                            ? `${phpDownload.pct}%`
                                            : "Downloading…"
                                          : "Download"}
                                      </button>
                                    )}
                                  </div>
                                  {selectedPhp && !selectedPhp.installed && (
                                    <p
                                      className={clsx(
                                        "mt-1.5 flex items-center gap-1.5 text-xs",
                                        phpDownload?.error ? "text-red-700" : "text-amber-700",
                                      )}
                                    >
                                      <ExclamationTriangleIcon className="h-3.5 w-3.5 flex-shrink-0" />
                                      {phpDownload?.error ??
                                        `PHP ${selectedPhp.minor} isn't installed — download it before creating the site.`}
                                    </p>
                                  )}
                                  {setup && (!componentReady("mysql") || !componentReady("wp-cli")) && (
                                    <p className="mt-1.5 text-xs text-amber-700">
                                      {[
                                        !componentReady("mysql") && "MySQL",
                                        !componentReady("wp-cli") && "WP-CLI",
                                      ]
                                        .filter(Boolean)
                                        .join(" and ")}{" "}
                                      not installed yet — downloaded once when you create the site.
                                    </p>
                                  )}
                                </section>

                                {!adoptingExisting && (
                                  <section className="border-t border-gray-200 pt-6">
                                    <h4 className={sectionTitle}>WordPress admin</h4>

                                    <label htmlFor="wp-admin-user" className={formLabel}>
                                      Admin username (required)
                                    </label>
                                    <input
                                      id="wp-admin-user"
                                      {...noAutoFill}
                                      type="text"
                                      value={config.adminUser}
                                      onChange={(e) => handleInputChange("adminUser", e.target.value)}
                                      aria-invalid={!!userProblem}
                                      className={clsx(fieldClass, userProblem && "border-red-400")}
                                    />
                                    {userProblem && <p className="mt-1 text-xs text-red-700">{userProblem}</p>}

                                    <label htmlFor="wp-admin-pass" className={clsx(formLabel, "mt-4")}>
                                      Admin password (required)
                                    </label>
                                    <div className="relative">
                                      <input
                                        id="wp-admin-pass"
                                        {...noAutoFill}
                                        autoComplete="new-password"
                                        type={showPassword ? "text" : "password"}
                                        value={config.adminPassword}
                                        onChange={(e) => handleInputChange("adminPassword", e.target.value)}
                                        aria-invalid={!!passwordProblem}
                                        className={clsx(fieldClass, "pr-10", passwordProblem && "border-red-400")}
                                      />
                                      <button
                                        type="button"
                                        onClick={() => setShowPassword((v) => !v)}
                                        aria-label={showPassword ? "Hide password" : "Show password"}
                                        title={showPassword ? "Hide password" : "Show password"}
                                        className="absolute inset-y-0 right-0 flex items-center rounded-r-lg px-3 text-gray-500 transition-colors hover:text-gray-800 focus:outline-none focus-visible:text-blue-700"
                                      >
                                        {showPassword ? (
                                          <EyeSlashIcon className="h-4 w-4" />
                                        ) : (
                                          <EyeIcon className="h-4 w-4" />
                                        )}
                                      </button>
                                    </div>
                                    {passwordProblem && (
                                      <p className="mt-1 text-xs text-red-700">{passwordProblem}</p>
                                    )}

                                    <label htmlFor="wp-admin-email" className={clsx(formLabel, "mt-4")}>
                                      Admin email (required)
                                    </label>
                                    <input
                                      id="wp-admin-email"
                                      {...noAutoFill}
                                      type="email"
                                      value={config.adminEmail}
                                      onChange={(e) => handleInputChange("adminEmail", e.target.value)}
                                      placeholder={DEFAULT_ADMIN_EMAIL}
                                      aria-invalid={!!emailProblem}
                                      className={clsx(fieldClass, emailProblem && "border-red-400")}
                                    />
                                    {emailProblem && <p className="mt-1 text-xs text-red-700">{emailProblem}</p>}

                                    <p className="mt-3 text-xs leading-relaxed text-gray-500">
                                      The password is saved to your login keychain, so you can copy it
                                      later from Overview.
                                    </p>
                                  </section>
                                )}
                              </div>
                            )}
                          </div>
                        )}

                        </fieldset>

                        {createError && (
                          <div
                            role="alert"
                            className="mx-auto mt-4 flex max-w-md items-start gap-2.5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-red-800"
                          >
                            <ExclamationTriangleIcon className="mt-0.5 h-4 w-4 flex-shrink-0" />
                            <div className="min-w-0">
                              <p className="text-sm font-medium">The site could not be created</p>
                              <p className="mt-0.5 break-words text-xs leading-relaxed">{createError}</p>
                            </div>
                          </div>
                        )}
                      </div>

                      <div className="flex items-center justify-between gap-3 border-t border-gray-200 bg-white px-6 py-4">
                        <button
                          type="button"
                          onClick={() => setModalStep("select")}
                          disabled={isInstalling}
                          className="inline-flex items-center gap-1 rounded-lg px-2 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <ChevronLeftIcon className="h-4 w-4" />
                          Back
                        </button>
                        <div className="flex min-w-0 items-center gap-3">
                          {isInstalling && currentStep && (
                            <span className="truncate text-xs text-gray-500" aria-live="polite">
                              {currentStep}
                            </span>
                          )}
                          <button
                            onClick={() => void createSite()}
                            disabled={isInstalling || !canCreate}
                            aria-busy={isInstalling}
                            title={
                              selectedPhp && !selectedPhp.installed
                                ? `Download PHP ${selectedPhp.minor} first`
                                : undefined
                            }
                            className={clsx(
                              "inline-flex flex-shrink-0 items-center gap-2 rounded-lg bg-blue-600 px-5 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2",
                              isInstalling
                                ? "cursor-wait"
                                : "disabled:cursor-not-allowed disabled:opacity-50",
                            )}
                          >
                            {isInstalling ? (
                              <>
                                <span
                                  aria-hidden
                                  className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white"
                                />
                                Creating…
                              </>
                            ) : (
                              "Create site"
                            )}
                          </button>
                        </div>
                      </div>
                    </>
                  )}
                </Dialog.Panel>
              </Transition.Child>
            </div>
          </div>
          {/* The dialog covers the window's drag areas; this keeps it movable. */}
          <WindowDragStrip />
        </Dialog>
      </Transition>
    </div>
  );
}

/**
 * The line between the details and the preview, dragged to share the sheet.
 *
 * The preview is hidden for the drag: it is a native view, and a pointer that
 * crosses onto it would be its pointer, not the drag's.
 */
function Resizer({
  width,
  onWidth,
  onDragging,
  containerRef,
}: {
  width: number;
  onWidth: (w: number) => void;
  onDragging: (dragging: boolean) => void;
  containerRef: React.RefObject<HTMLDivElement>;
}) {
  const clamp = (w: number) => {
    const max = (containerRef.current?.clientWidth ?? 1200) - MIN_PREVIEW;
    return Math.round(Math.max(MIN_DETAILS, Math.min(w, max)));
  };

  const start = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    const startX = e.clientX;
    // The width on screen, which the min and max may hold away from the
    // remembered one.
    const startWidth = handle.previousElementSibling?.getBoundingClientRect().width ?? width;
    handle.setPointerCapture(e.pointerId);
    document.body.style.cursor = "col-resize";
    onDragging(true);
    const move = (ev: PointerEvent) => onWidth(clamp(startWidth + ev.clientX - startX));
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      document.body.style.cursor = "";
      onDragging(false);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the details pane"
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={start}
      onKeyDown={(e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        onWidth(clamp(width + (e.key === "ArrowRight" ? 24 : -24)));
      }}
      className="group relative w-px flex-shrink-0 cursor-col-resize bg-gray-200 focus:outline-none"
    >
      {/* A wider grip than the line it draws. */}
      <span className="absolute inset-y-0 -left-1.5 -right-1.5 z-10" />
      <span className="absolute inset-y-0 -left-px -right-px bg-wp-blue opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 group-active:opacity-100" />
    </div>
  );
}

/**
 * A site tab that renders nothing until it is first opened, then stays
 * mounted -- hidden -- so returning to it does not rebuild it.
 */
function LazyPanel({
  seen,
  className,
  children,
}: {
  seen: boolean;
  className: string;
  children: React.ReactNode;
}) {
  return (
    <Tab.Panel unmount={false} className={className}>
      {seen ? children : null}
    </Tab.Panel>
  );
}
