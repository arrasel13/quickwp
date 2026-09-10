import { useState, useEffect, useMemo } from "react";
import { api, errorText } from "../../lib/api";
import { useAsync } from "../../lib/useAsync";
import { Tab, Dialog, Transition } from "@headlessui/react";
import {
  GlobeAltIcon,
  PlusIcon,
  XMarkIcon,
  ArrowLeftIcon,
  PlayIcon,
  StopIcon,
  CodeBracketIcon,
  FolderIcon,
} from "@heroicons/react/24/outline";
import clsx from "clsx";
import { Fragment } from "react";
import SiteOverview from "../site/SiteOverview";
import SiteWordPress from "../site/SiteWordPress";
import SiteDatabase from "../site/SiteDatabase";
import SiteLogs from "../site/SiteLogs";
import SiteSettings from "../site/SiteSettings";
import TerminalTab from "./TerminalTab";
import MailTab from "./MailTab";
import SiteAvatar from "../SiteAvatar";
import { useSites } from "../../lib/sites";
import ProgressBar from "../ui/ProgressBar";
import TerminalOutput from "../ui/TerminalOutput";

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
  folderName: string;
  siteUrl: string;
  databaseName: string;
  wpVersion: string;
  phpVersion: string;
  enableDebug: boolean;
  adminUser: string;
  adminPassword: string;
  adminEmail: string;
}

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

const labelClass = "mb-1.5 block text-xs font-medium text-gray-700";

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

interface ProjectOption {
  id: ProjectType;
  name: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  color: string;
  /** Laravel has no implementation yet; the card says so instead of alerting. */
  available?: boolean;
}

export default function SitesTab() {
  // Real sites, from the Rust backend. There is no mock data here any more:
  // an empty list means you have not created a site yet, and says so.
  // Whether the stack can serve a real name yet decides which URL is honest.
  const { data: stack } = useAsync(() => api.stackStatus(), []);
  const httpsReady = stack?.https_ready ?? false;

  // What Node this machine already has. QuickWP installs none of its own, so
  // the list is whatever nvm/fnm/Volta/Homebrew/asdf put there — newest first.
  const { data: nodeInstalls } = useAsync(() => api.nodeList(), []);
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
        // A linked site's folder is yours; QuickWP never copies or deletes it.
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
  const [config, setConfig] = useState<SiteConfig>({
    siteTitle: "",
    folderName: "",
    siteUrl: "",
    databaseName: "",
    wpVersion: "latest",
    phpVersion: "8.3",
    enableDebug: false,
    adminUser: "admin",
    adminPassword: "",
    adminEmail: "",
  });
  // Populated from wordpress.org the first time the WordPress step is opened.
  const [wpVersions, setWpVersions] = useState<string[]>(WP_FALLBACK_VERSIONS);
  const [isInstalling, setIsInstalling] = useState(false);
  const [progress, setProgress] = useState(0);
  const [terminalOutput, setTerminalOutput] = useState<string[]>([]);
  const [currentStep, setCurrentStep] = useState("");
  const [installDone, setInstallDone] = useState(false);

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
  const phpVersions = ["8.3", "8.2", "8.1", "8.0", "7.4"];

  const siteDetailTabs = [
    { name: "Overview", id: "overview" },
    { name: "WordPress", id: "wordpress" },
    { name: "Database", id: "database" },
    { name: "Logs", id: "logs" },
    { name: "Terminal", id: "terminal" },
    { name: "Mail", id: "mail" },
    { name: "Settings", id: "settings" },
  ];

  /** Overview opens first: what the site is, and where to go from it. */
  const DEFAULT_SITE_TAB = 0;
  // Controlled rather than defaultIndex, so switching sites can put the
  // selection back on Overview instead of wherever the last site was left.
  const [siteTab, setSiteTab] = useState(DEFAULT_SITE_TAB);
  useEffect(() => {
    setSiteTab(DEFAULT_SITE_TAB);
  }, [selectedId]);

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

  // Auto-generate values when site title changes
  useEffect(() => {
    if (config.siteTitle) {
      const folderName = config.siteTitle
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, "")
        .replace(/\s+/g, "-")
        .trim();

      const siteUrl = `${folderName}.test`;
      const databaseName = folderName.replace(/-/g, "_");

      setConfig((prev) => ({
        ...prev,
        folderName,
        siteUrl,
        databaseName,
      }));
    }
  }, [config.siteTitle]);

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
  };

  // The sidebar's "+" asks for the dialog; this screen owns it.
  useEffect(() => {
    if (newSiteRequest > 0) openModal();
  }, [newSiteRequest]);

  const closeModal = () => {
    setIsModalOpen(false);
    setModalStep("select");
    setSelectedProjectType(null);
    // Reset WordPress config
    setConfig({
      siteTitle: "",
      folderName: "",
      siteUrl: "",
      databaseName: "",
      wpVersion: "latest",
      phpVersion: "8.3",
      enableDebug: false,
      adminUser: "admin",
      adminPassword: "",
      adminEmail: "",
    });
    setTerminalOutput([]);
    setProgress(0);
    setIsInstalling(false);
    setInstallDone(false);
  };

  const handleProjectSelect = async (projectType: ProjectType) => {
    setSelectedProjectType(projectType);
    if (projectType === "wordpress") {
      setModalStep("wordpress");
      return;
    }
    if (projectType === "existing") {
      // Linking serves a folder where it already is. Nothing is copied, and
      // deleting the site later removes only QuickWP's record of it.
      const path = prompt(
        "Link an existing folder\n\nQuickWP serves it where it is — nothing is copied or " +
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

  const simulateInstallation = async () => {
    setIsInstalling(true);
    setInstallDone(false);
    setProgress(0);
    setTerminalOutput([]);

    const say = (line: string) => setTerminalOutput((prev) => [...prev, line]);
    const wantsWordPress = selectedProjectType === "wordpress";

    try {
      setCurrentStep(`Checking PHP ${config.phpVersion}...`);
      say(`> Checking PHP ${config.phpVersion}`);
      setProgress(8);

      const versions = await api.phpList();
      const chosen = versions.find((v) => v.minor === config.phpVersion);
      if (!chosen) throw new Error(`PHP ${config.phpVersion} is not a version QuickWP ships.`);
      if (!chosen.installed) {
        setCurrentStep(`Downloading PHP ${config.phpVersion}...`);
        say(`> PHP ${config.phpVersion} is not installed yet — downloading (~35MB)`);
        await api.phpInstall(config.phpVersion);
        say("  verified against its pinned checksum");
      }
      setProgress(25);

      if (wantsWordPress) {
        // WordPress needs a database and WP-CLI. Both are fetched on demand,
        // and the first one is a large download, so say so rather than
        // appearing to hang.
        const engines = await api.dbList();
        const engine = engines.find((e) => e.installed) ?? engines[0];
        if (!engine.installed) {
          setCurrentStep(`Downloading MySQL ${engine.series}...`);
          say(`> MySQL ${engine.series} is not installed yet — downloading (~250MB, once)`);
          await api.dbInstall(engine.series);
        }
        setCurrentStep("Starting MySQL...");
        say("> Starting MySQL");
        await api.dbStart(engine.series);
        setProgress(45);

        setCurrentStep("Fetching WP-CLI...");
        say("> " + (await api.wpEnsureCli()));
      }
      setProgress(55);

      setCurrentStep("Creating the site...");
      say(`> Creating ${config.siteUrl}`);
      const site = await api.siteCreate({
        name: config.siteTitle || config.folderName,
        domain: config.siteUrl,
        kind: wantsWordPress ? "wordpress" : "php",
        php_minor: config.phpVersion,
        link_path: null,
      });
      setProgress(65);

      setCurrentStep("Starting the PHP pool...");
      const port = await api.phpStart(site.php_minor);
      say(`  pool listening on 127.0.0.1:${port}`);
      await api.stackStart();
      setProgress(75);

      if (wantsWordPress) {
        setCurrentStep("Installing WordPress...");
        say("> Installing WordPress — core, database, wp-config.php, admin user");
        const res = await api.wpInstall(site.domain, {
          title: config.siteTitle || site.domain,
          admin_user: config.adminUser || "admin",
          admin_email: config.adminEmail || `admin@${site.domain}`,
          admin_password: config.adminPassword || null,
          version: config.wpVersion === "latest" ? null : config.wpVersion,
        });
        setProgress(100);
        say("");
        say("WordPress installed.");
        say(`  url        ${res.url}`);
        say(`  admin      ${res.admin_user}`);
        // Shown once, and only here: it is never stored in the clear.
        say(`  password   ${res.admin_password}      <- copy this now`);
        say(`  database   ${res.db.name}`);
      } else {
        setProgress(100);
        say("");
        say("Site created.");
        say(`  docroot   ${site.docroot}`);
        say(`  php       ${site.php_minor}`);
      }

      await reloadSites();
      // Open what was just made, rather than leaving the old site in view.
      select(String(site.id));
      setIsInstalling(false);
      setInstallDone(true);
      setCurrentStep("");
    } catch (e) {
      say("");
      say(`Failed: ${errorText(e)}`);
      setIsInstalling(false);
      setCurrentStep("");
      setProgress(0);
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

  if (sitesLoading) {
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
      {/* Header: the site in view, named the way the sidebar names it. */}
      <div className="flex flex-shrink-0 items-center gap-3 px-6 pt-5 pb-3">
        <div className="inline-flex min-w-0 max-w-full items-center gap-3 rounded-md bg-gray-900 py-1.5 pl-1.5 pr-4 text-white">
          <SiteAvatar
            name={selectedBackendSite?.name || selectedSite.name}
            className="h-9 w-9 text-sm"
          />
          <div className="min-w-0">
            <div className="truncate text-[13px] font-semibold leading-5">
              {selectedBackendSite?.name || selectedSite.name}
            </div>
            <div className="truncate text-[11px] leading-4 text-gray-300">
              {selectedSite.name}
            </div>
          </div>
        </div>
        <span
          className={clsx(
            "inline-flex flex-shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium",
            selectedSite.status === "running"
              ? "bg-green-50 text-green-700"
              : "bg-gray-100 text-gray-500",
          )}
        >
          <span
            className={clsx(
              "h-1.5 w-1.5 rounded-full",
              selectedSite.status === "running" ? "bg-green-500" : "bg-gray-400",
            )}
          />
          {selectedSite.status === "running" ? "Running" : "Stopped"}
        </span>
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
            onChange={setSiteTab}
          >
            <Tab.List className="flex flex-shrink-0 gap-1 border-b border-gray-200 bg-white px-4">
              {siteDetailTabs.map((tab) => (
                <Tab
                  key={tab.id}
                  className={({ selected }) =>
                    clsx(
                      "relative px-3 py-3 text-[13px] font-medium transition-colors focus:outline-none focus-visible:outline-none focus:ring-0 active:outline-none",
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

            <Tab.Panels className="flex-1 overflow-hidden min-h-0">
              {/* Overview */}
              <Tab.Panel className="h-full overflow-y-auto">
                {selectedBackendSite && (
                  <SiteOverview site={selectedBackendSite} />
                )}
              </Tab.Panel>

              {/* WordPress */}
              <Tab.Panel className="h-full overflow-y-auto">
                {selectedBackendSite && (
                  <SiteWordPress
                    domain={selectedSite.name}
                    docroot={selectedBackendSite.docroot}
                    site={selectedBackendSite}
                    onDeleted={() => void reloadSites()}
                  />
                )}
              </Tab.Panel>

              {/* Database */}
              {/* overflow-hidden, not auto: Adminer fills the pane and scrolls
                  inside its own frame. */}
              <Tab.Panel className="h-full overflow-hidden">
                {selectedBackendSite ? (
                  <SiteDatabase site={selectedBackendSite} />
                ) : null}
              </Tab.Panel>

              {/* Logs */}
              <Tab.Panel className="h-full overflow-hidden">
                <SiteLogs domain={selectedSite.name} />
              </Tab.Panel>

              {/* Terminal — the xterm component, pinned to this site instead
                  of offering a picker. */}
              <Tab.Panel className="h-full overflow-hidden">
                <TerminalTab fixedDomain={selectedSite.name} />
              </Tab.Panel>

              {/* Mail — one Mailpit catches what every site sends, so this is
                  the same inbox from whichever site you open it. */}
              <Tab.Panel className="h-full overflow-y-auto">
                <MailTab />
              </Tab.Panel>

              {/* Settings */}
              <Tab.Panel className="h-full overflow-y-auto">
                {selectedBackendSite ? (
                  <SiteSettings
                    site={selectedBackendSite}
                    onChanged={async () => {
                      await reloadSites();
                    }}
                    environment={{
                      httpsReady,
                      phpVersions,
                      nodeInstalls: nodeInstalls ?? [],
                      nodeSelected: nodeForSelected,
                      onNodeChange: handleNodeVersionChange,
                      onPhpChange: (v) => void handlePhpVersionChange(v),
                    }}
                  />
                ) : null}
              </Tab.Panel>
            </Tab.Panels>
          </Tab.Group>
        </div>
      </div>

        </>
      ) : (
        <div className="flex-1 overflow-y-auto bg-gradient-to-b from-gray-50 to-white">
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
                Create your first site and QuickWP provisions a docroot, wires it to a
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
          onClose={isInstalling ? () => {} : closeModal}
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
                <Dialog.Panel className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl bg-white text-left shadow-2xl">
                  {/* Header — shared by both steps */}
                  <div className="flex items-start justify-between gap-4 border-b border-gray-200 px-6 py-4">
                    <div className="min-w-0">
                      <Dialog.Title
                        as="h3"
                        className="text-base font-semibold text-gray-900"
                      >
                        {modalStep === "select"
                          ? "Add a new site"
                          : "New WordPress site"}
                      </Dialog.Title>
                      <p className="mt-0.5 text-xs text-gray-500">
                        {modalStep === "select"
                          ? "Pick what you want QuickWP to serve."
                          : "QuickWP downloads WordPress, PHP and a database as needed."}
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
                      {/* Everything fits without scrolling: four rows of
                          fields across three fieldsets. The body still scrolls
                          so the install log has somewhere to go once it
                          appears. */}
                      <div className="flex-1 space-y-3 overflow-y-auto bg-gray-50 p-5">
                        <fieldset className="rounded-lg border border-gray-200 bg-white px-4 pb-4 pt-4">
                          <legend className="ml-1 px-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                            Site
                          </legend>

                          {/* One row of four. Nine columns divide as 3/2/2/2,
                              giving the title — the only field you must fill
                              in — half again the width of the derived ones. */}
                          <div className="grid gap-3 sm:grid-cols-9">
                            <div className="sm:col-span-3">
                              <label htmlFor="wp-site-title" className={labelClass}>
                                Site title <span className="text-red-500">*</span>
                              </label>
                              <input
                                id="wp-site-title"
                                {...noAutoFill}
                                type="text"
                                value={config.siteTitle}
                                onChange={(e) =>
                                  handleInputChange("siteTitle", e.target.value)
                                }
                                placeholder="My WordPress Site"
                                disabled={isInstalling}
                                className={fieldClass}
                              />
                            </div>
                            <div className="sm:col-span-2">
                              <label htmlFor="wp-folder" className={labelClass}>
                                Folder name
                              </label>
                              <input
                                id="wp-folder"
                                {...noAutoFill}
                                type="text"
                                value={config.folderName ?? ""}
                                onChange={(e) =>
                                  handleInputChange("folderName", e.target.value)
                                }
                                disabled={isInstalling}
                                className={clsx(fieldClass, "font-mono text-xs")}
                              />
                            </div>
                            <div className="sm:col-span-2">
                              <label htmlFor="wp-url" className={labelClass}>
                                Site URL
                              </label>
                              <input
                                id="wp-url"
                                {...noAutoFill}
                                type="text"
                                value={config.siteUrl ?? ""}
                                onChange={(e) =>
                                  handleInputChange("siteUrl", e.target.value)
                                }
                                disabled={isInstalling}
                                className={clsx(fieldClass, "font-mono text-xs")}
                              />
                            </div>
                            <div className="sm:col-span-2">
                              <label htmlFor="wp-db" className={labelClass}>
                                Database name
                              </label>
                              <input
                                id="wp-db"
                                {...noAutoFill}
                                type="text"
                                value={config.databaseName ?? ""}
                                onChange={(e) =>
                                  handleInputChange("databaseName", e.target.value)
                                }
                                disabled={isInstalling}
                                className={clsx(fieldClass, "font-mono text-xs")}
                              />
                            </div>
                          </div>
                          <p className="mt-2 text-[11px] text-gray-500">
                            The other three are derived from the title — edit any
                            of them.
                          </p>
                        </fieldset>

                        <fieldset className="rounded-lg border border-gray-200 bg-white px-4 pb-4 pt-4">
                          <legend className="ml-1 px-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                            Environment
                          </legend>

                          <div className="grid gap-3 sm:grid-cols-3">
                            <div>
                              <label htmlFor="wp-version" className={labelClass}>
                                WordPress version
                              </label>
                              <select
                                id="wp-version"
                                value={config.wpVersion}
                                onChange={(e) =>
                                  handleInputChange("wpVersion", e.target.value)
                                }
                                disabled={isInstalling}
                                className={fieldClass}
                              >
                                <option value="latest">
                                  Latest{wpVersions[0] ? ` (${wpVersions[0]})` : ""}
                                </option>
                                {/* The newest release is skipped: "Latest"
                                    above already resolves to it, and listing
                                    it twice reads as two different choices. */}
                                {wpVersions.slice(1).map((v) => (
                                  <option key={v} value={v}>
                                    WordPress {v}
                                  </option>
                                ))}
                              </select>
                            </div>
                            <div>
                              <label htmlFor="wp-php" className={labelClass}>
                                PHP version
                              </label>
                              {/* Reuses the same list the site detail pane
                                  offers, so the two cannot drift apart. */}
                              <select
                                id="wp-php"
                                value={config.phpVersion || "8.3"}
                                onChange={(e) =>
                                  handleInputChange("phpVersion", e.target.value)
                                }
                                disabled={isInstalling}
                                className={fieldClass}
                              >
                                {phpVersions.map((v) => (
                                  <option key={v} value={v}>
                                    PHP {v}
                                  </option>
                                ))}
                              </select>
                            </div>
                            <div className="flex items-end">
                              <label
                                htmlFor="enableDebug"
                                className="flex items-center gap-2 pb-2.5 text-sm text-gray-700"
                              >
                                <input
                                  type="checkbox"
                                  id="enableDebug"
                                  checked={config.enableDebug}
                                  onChange={(e) =>
                                    handleInputChange("enableDebug", e.target.checked)
                                  }
                                  disabled={isInstalling}
                                  className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-2 focus:ring-blue-500/30"
                                />
                                Enable debug mode
                              </label>
                            </div>
                          </div>
                        </fieldset>

                        <fieldset className="rounded-lg border border-gray-200 bg-white px-4 pb-4 pt-4">
                          <legend className="ml-1 px-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                            Admin account
                          </legend>

                          <div className="grid gap-3 sm:grid-cols-3">
                            <div>
                              <label htmlFor="wp-admin-user" className={labelClass}>
                                Username
                              </label>
                              <input
                                id="wp-admin-user"
                                {...noAutoFill}
                                type="text"
                                value={config.adminUser}
                                onChange={(e) =>
                                  handleInputChange("adminUser", e.target.value)
                                }
                                placeholder="admin"
                                disabled={isInstalling}
                                className={fieldClass}
                              />
                            </div>
                            <div>
                              <label htmlFor="wp-admin-pass" className={labelClass}>
                                Password
                              </label>
                              <input
                                id="wp-admin-pass"
                                {...noAutoFill}
                                autoComplete="new-password"
                                type="password"
                                value={config.adminPassword}
                                onChange={(e) =>
                                  handleInputChange("adminPassword", e.target.value)
                                }
                                placeholder="Generated if blank"
                                disabled={isInstalling}
                                className={fieldClass}
                              />
                            </div>
                            <div>
                              <label htmlFor="wp-admin-email" className={labelClass}>
                                Email
                              </label>
                              <input
                                id="wp-admin-email"
                                {...noAutoFill}
                                type="email"
                                value={config.adminEmail}
                                onChange={(e) =>
                                  handleInputChange("adminEmail", e.target.value)
                                }
                                placeholder="admin@example.com"
                                disabled={isInstalling}
                                className={fieldClass}
                              />
                            </div>
                          </div>
                          <p className="mt-2 text-[11px] text-gray-500">
                            The password is shown once, when the install
                            finishes — it is never stored in the clear.
                          </p>
                        </fieldset>

                        {/* The log stays up after the run ends. It used to be
                            gated on isInstalling alone, so the moment the
                            install finished this panel unmounted and took the
                            one-time admin password -- and any failure
                            message -- with it. */}
                        {(isInstalling || installDone || terminalOutput.length > 0) && (
                          <section className="rounded-xl border border-gray-200 bg-white p-5">
                            <div className="mb-4 flex items-center gap-3">
                              <div
                                className={clsx(
                                  "flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg",
                                  installDone
                                    ? "bg-green-100"
                                    : isInstalling
                                      ? "bg-blue-100"
                                      : "bg-red-100"
                                )}
                              >
                                <PlayIcon
                                  className={clsx(
                                    "h-5 w-5",
                                    installDone
                                      ? "text-green-600"
                                      : isInstalling
                                        ? "text-blue-600"
                                        : "text-red-600"
                                  )}
                                />
                              </div>
                              <div className="min-w-0">
                                <h4 className="text-sm font-semibold text-gray-900">
                                  {installDone
                                    ? "Site created"
                                    : isInstalling
                                      ? "Installing"
                                      : "Installation failed"}
                                </h4>
                                <p className="mt-0.5 text-xs text-gray-500">
                                  {installDone
                                    ? "Copy the admin password below — it is not stored in the clear."
                                    : isInstalling
                                      ? currentStep || "Preparing…"
                                      : "The log below says why."}
                                </p>
                              </div>
                            </div>
                            {(isInstalling || installDone) && (
                              <ProgressBar progress={progress} className="mb-4" />
                            )}
                            <TerminalOutput
                              output={terminalOutput}
                              className="max-h-48"
                            />
                          </section>
                        )}
                      </div>

                      <div className="flex items-center justify-between gap-3 border-t border-gray-200 bg-gray-50 px-6 py-4">
                        <button
                          type="button"
                          onClick={() => setModalStep("select")}
                          disabled={isInstalling}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <ArrowLeftIcon className="h-4 w-4" />
                          Back
                        </button>
                        <button
                          onClick={installDone ? closeModal : simulateInstallation}
                          disabled={(!config.siteTitle && !installDone) || isInstalling}
                          className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-5 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {isInstalling ? (
                            <>
                              <StopIcon className="h-4 w-4" />
                              Installing…
                            </>
                          ) : installDone ? (
                            // Not auto-closed: the admin password is printed
                            // once and closing on a timer would take it away
                            // before it could be copied.
                            <>Done — close</>
                          ) : (
                            <>
                              <PlayIcon className="h-4 w-4" />
                              Create site
                            </>
                          )}
                        </button>
                      </div>
                    </>
                  )}
                </Dialog.Panel>
              </Transition.Child>
            </div>
          </div>
        </Dialog>
      </Transition>
    </div>
  );
}
