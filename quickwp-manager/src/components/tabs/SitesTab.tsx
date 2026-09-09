import { useState, useEffect, useMemo } from "react";
import { api, errorText } from "../../lib/api";
import { useAsync } from "../../lib/useAsync";
import { Tab, Dialog, Transition } from "@headlessui/react";
import {
  GlobeAltIcon,
  MagnifyingGlassIcon,
  CogIcon,
  LockClosedIcon,
  LinkIcon,
  PlusIcon,
  XMarkIcon,
  ArrowLeftIcon,
  PlayIcon,
  StopIcon,
  CodeBracketIcon,
  FolderIcon,
  CommandLineIcon,
  DocumentTextIcon,
} from "@heroicons/react/24/outline";
import clsx from "clsx";
import { Fragment } from "react";
import ProgressBar from "../ui/ProgressBar";
import TerminalOutput from "../ui/TerminalOutput";

interface WordPressSite {
  id: string;
  name: string;
  url: string;
  path: string;
  linkedPath: string;
  phpVersion: string;
  nodeVersion: string;
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

interface ProjectOption {
  id: ProjectType;
  name: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  color: string;
}

export default function SitesTab() {
  // Real sites, from the Rust backend. There is no mock data here any more:
  // an empty list means you have not created a site yet, and says so.
  const {
    data: backendSites,
    error: sitesError,
    loading: sitesLoading,
    reload: reloadSites,
  } = useAsync(() => api.siteList(), []);

  const sites: WordPressSite[] = useMemo(
    () =>
      (backendSites ?? []).map((s) => ({
        id: String(s.id),
        name: s.domain,
        url: `http://127.0.0.1:18089/`,
        path: s.docroot,
        // A linked site's folder is yours; QuickWP never copies or deletes it.
        linkedPath: s.is_linked ? s.docroot : "—",
        phpVersion: s.php_minor,
        nodeVersion: "—",
        status: s.enabled ? "running" : "stopped",
      })),
    [backendSites],
  );

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedSite: WordPressSite | null =
    sites.find((s) => s.id === selectedId) ?? sites[0] ?? null;
  const setSelectedSite = (s: WordPressSite) => setSelectedId(s.id);
  const [showPreview, setShowPreview] = useState(true);
  const [showPhpDropdown, setShowPhpDropdown] = useState(false);
  const [showNodeDropdown, setShowNodeDropdown] = useState(false);
  const [showActionsDropdown, setShowActionsDropdown] = useState(false);

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
  const [isInstalling, setIsInstalling] = useState(false);
  const [progress, setProgress] = useState(0);
  const [terminalOutput, setTerminalOutput] = useState<string[]>([]);
  const [currentStep, setCurrentStep] = useState("");
  const [installDone, setInstallDone] = useState(false);

  // Project type options
  const projectOptions: ProjectOption[] = [
    {
      id: "laravel",
      name: "New Laravel Project",
      description: "Create a new Laravel application with Herd",
      icon: CodeBracketIcon,
      color: "red",
    },
    {
      id: "existing",
      name: "Link Existing Project",
      description: "Link an existing project to Herd",
      icon: FolderIcon,
      color: "blue",
    },
    {
      id: "wordpress",
      name: "New WordPress Site",
      description: "Create a new WordPress development site",
      icon: GlobeAltIcon,
      color: "green",
    },
  ];

  // Available versions
  const phpVersions = ["8.3", "8.2", "8.1", "8.0", "7.4"];
  const nodeVersions = ["22", "20", "18", "16", "14"];

  // Actions dropdown options
  const actionOptions = [
    { id: "terminal", name: "Terminal", icon: CommandLineIcon },
    { id: "ide", name: "Open in browser", icon: CodeBracketIcon },
    { id: "logs", name: "Logs", icon: DocumentTextIcon },
    {
      id: "toggle",
      name: selectedSite?.status === "running" ? "Stop site" : "Start site",
      icon: selectedSite?.status === "running" ? StopIcon : PlayIcon,
    },
    { id: "delete", name: "Delete site", icon: XMarkIcon },
  ];

  const siteDetailTabs = [
    { name: "General", id: "general" },
    { name: "Information", id: "information" },
    { name: "Connect to Forge", id: "forge" },
  ];

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
        await api.siteCreate({
          name: suggested,
          domain,
          kind: "php",
          php_minor: "",
          link_path: path,
        });
        await reloadSites();
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
    setShowPhpDropdown(false);
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

  const handleNodeVersionChange = (_version: string) => {
    setShowNodeDropdown(false);
    // Node version management is not wired to a backend yet.
  };

  const handleToggleSite = async () => {
    if (!selectedSite) return;
    try {
      await api.siteSetEnabled(selectedSite.name, selectedSite.status !== "running");
      await reloadSites();
    } catch (e) {
      alert(errorText(e));
    }
  };

  const handleDeleteSite = async () => {
    if (!selectedSite) return;
    const linked = (backendSites ?? []).find((s) => s.domain === selectedSite.name)?.is_linked;
    const warning = linked
      ? "Remove " + selectedSite.name + " from QuickWP?\n\nYour folder stays exactly where it is — QuickWP only forgets it."
      : "Delete " + selectedSite.name + "?\n\nThis removes its docroot at " + selectedSite.path + ".";
    if (!confirm(warning)) return;
    try {
      await api.siteDelete(selectedSite.name);
      setSelectedId(null);
      await reloadSites();
    } catch (e) {
      alert(errorText(e));
    }
  };

  // Actions handler
  const handleActionClick = (actionId: string) => {
    setShowActionsDropdown(false);

    switch (actionId) {
      case "terminal":
        alert("A terminal in the docroot needs a PTY bridge — not built yet.\n\ncd " + selectedSite?.path);
        break;
      case "ide":
        void api.siteOpen(selectedSite!.name).catch((e) => alert(errorText(e)));
        break;
      case "logs":
        alert("Logs live in the QuickWP data directory — the log viewer is not built yet.");
        break;
      case "toggle":
        void handleToggleSite();
        break;
      case "delete":
        void handleDeleteSite();
        break;
      default:
        break;
    }
  };

  // Close dropdowns when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (
        !target.closest(".version-dropdown") &&
        !target.closest(".actions-dropdown")
      ) {
        setShowPhpDropdown(false);
        setShowNodeDropdown(false);
        setShowActionsDropdown(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, []);

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
    <div className="h-screen flex flex-col">
      {/* The dialog below must stay mounted even with no sites, or
          "New site" sets state with nothing there to show it. */}
      {selectedSite ? (
        <>
      {/* Header */}
      <div className="border-b border-gray-200 p-4 flex-shrink-0">
        <div className="flex items-center justify-between">
          <h3 className="text-2xl font-bold text-gray-900">
            Development Sites
          </h3>
          <div className="flex items-center space-x-2">
            <button className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors">
              <CogIcon className="h-6 w-6" />
            </button>
            <button className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors">
              <LockClosedIcon className="h-6 w-6" />
            </button>

            {/* Search */}
            <div className="relative">
              <MagnifyingGlassIcon className="h-4 w-4 absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400" />
              <input
                type="text"
                placeholder="Search sites..."
                className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left Sidebar - Sites List */}
        <div className="w-72 border-r border-gray-200 shadow-sm flex flex-col">
          {/* Sites List - Scrollable */}
          <div className="flex-1 overflow-y-auto p-4">
            <div className="space-y-1">
              {sites.map((site) => (
                <button
                  key={site.id}
                  onClick={() => setSelectedSite(site)}
                  className={clsx(
                    "w-full flex items-center justify-between p-2 rounded-lg text-left transition-all duration-200",
                    selectedSite.id === site.id
                      ? "bg-blue-50 border border-blue-200 shadow-sm"
                      : "border border-transparent hover:bg-gray-100 hover:border-gray-200"
                  )}
                >
                  <div className="flex items-center space-x-3">
                    <div
                      className={clsx(
                        "w-3 h-3 rounded-full",
                        site.status === "running"
                          ? "bg-green-500"
                          : "bg-gray-400"
                      )}
                    />
                    <span className="text-sm font-medium text-gray-900">
                      {site.name}
                    </span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <LinkIcon className="h-4 w-4 text-gray-400" />
                    <LockClosedIcon className="h-4 w-4 text-gray-400" />
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Add Site Button - Fixed at bottom */}
          <div className="p-4 border-t border-gray-200">
            <div className="flex justify-center">
              <button
                onClick={openModal}
                className="flex items-center justify-center px-3 py-1.5 text-sm bg-gray-400 text-white rounded-lg hover:bg-gray-500 transition-colors shadow-sm font-medium"
              >
                <PlusIcon className="h-4 w-4" />
                Add New Site
              </button>
            </div>
          </div>
        </div>

        {/* Right Content - Site Details */}
        <div className="flex-1 flex flex-col bg-gray-50 overflow-hidden min-h-0">
          {/* Site Detail Tabs */}
          <Tab.Group as="div" className="flex flex-col flex-1 min-h-0">
            <Tab.List className="flex border-b border-gray-200 px-6 flex-shrink-0 shadow-sm">
              {siteDetailTabs.map((tab) => (
                <Tab
                  key={tab.id}
                  className={({ selected }) =>
                    clsx(
                      "py-2 px-4 text-sm border-b-2 focus:outline-none focus-visible:outline-none focus:ring-0 active:outline-none transition-colors font-medium",
                      selected
                        ? "border-blue-500 text-blue-600"
                        : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
                    )
                  }
                >
                  {tab.name}
                </Tab>
              ))}
            </Tab.List>

            <Tab.Panels className="flex-1 overflow-hidden min-h-0">
              {/* General Tab */}
              <Tab.Panel className="h-full overflow-y-auto">
                <div className="p-4">
                  <div className="space-y-4">
                    {/* Site preview and controls */}
                    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                      {/* Site preview */}
                      <div className="lg:col-span-2">
                        <div className="bg-white border border-gray-200 rounded-xl min-h-96 flex items-center justify-center shadow-sm">
                          <div className="text-center p-8">
                            <div className="w-20 h-20 bg-gray-100 rounded-xl shadow-sm flex items-center justify-center mb-6 mx-auto">
                              <GlobeAltIcon className="h-10 w-10 text-gray-400" />
                            </div>
                            <h3 className="text-lg font-semibold text-gray-900 mb-2">
                              Site Preview
                            </h3>
                            <p className="text-sm text-gray-500">
                              Live preview of your WordPress site will appear
                              here
                            </p>
                          </div>
                        </div>
                      </div>

                      {/* Site controls */}
                      <div className="space-y-4">
                        <div className="bg-white border border-gray-200 rounded-lg p-4 shadow-sm space-y-6">
                          <div className="flex items-center justify-between">
                            <h3 className="text-sm font-semibold text-gray-900">
                              {selectedSite.name.replace(".test", "")}
                            </h3>
                            <div className="relative actions-dropdown">
                              <button
                                onClick={() => {
                                  setShowActionsDropdown(!showActionsDropdown);
                                  setShowPhpDropdown(false);
                                  setShowNodeDropdown(false);
                                }}
                                className="px-3 py-1 bg-blue-500 text-xs text-white rounded-md hover:bg-blue-600 transition-colors font-medium focus:outline-none focus-visible:outline-none"
                              >
                                Actions
                              </button>
                              {showActionsDropdown && (
                                <div className="absolute right-0 top-8 mt-1 w-32 bg-white border border-gray-200 rounded-md shadow-lg z-20">
                                  {actionOptions.map((action) => (
                                    <button
                                      key={action.id}
                                      onClick={() =>
                                        handleActionClick(action.id)
                                      }
                                      className="flex items-center w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 focus:outline-none focus-visible:outline-none first:rounded-t-md last:rounded-b-md"
                                    >
                                      <action.icon className="h-4 w-4 mr-2 text-gray-500" />
                                      {action.name}
                                    </button>
                                  ))}
                                </div>
                              )}
                            </div>
                          </div>

                          {/* Show Preview Toggle */}
                          <div className="flex items-center justify-between">
                            <span className="text-sm font-medium text-gray-700">
                              Show Preview
                            </span>
                            <button
                              onClick={() => setShowPreview(!showPreview)}
                              className={clsx(
                                "relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2",
                                showPreview ? "bg-blue-600" : "bg-gray-200"
                              )}
                            >
                              <span
                                className={clsx(
                                  "inline-block h-4 w-4 transform rounded-full bg-white transition-transform",
                                  showPreview
                                    ? "translate-x-6"
                                    : "translate-x-1"
                                )}
                              />
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Site details */}
                    <div className="bg-gray-100 border border-gray-300 rounded-xl p-4 shadow-sm">
                      <div className="">
                        <div className="flex items-center justify-between py-2 border-b border-gray-200">
                          <span className="text-sm font-medium text-gray-600">
                            PHP Version:
                          </span>
                          <div className="relative version-dropdown">
                            <div className="flex items-center">
                              <input
                                type="text"
                                value={selectedSite.phpVersion}
                                readOnly
                                className="w-16 px-2 py-1 text-xs text-center border border-gray-300 rounded-l-md bg-white focus:outline-none focus:ring-0 focus:ring-gray-300"
                              />
                              <button
                                onClick={() => {
                                  setShowPhpDropdown(!showPhpDropdown);
                                  setShowNodeDropdown(false);
                                }}
                                className="px-2 py-1 bg-blue-500 border border-blue-500 hover:border hover:border-blue-500 text-white rounded-r-md hover:bg-blue-600 transition-colors focus:outline-none focus:ring-0 focus:ring-blue-500"
                              >
                                <svg
                                  className="w-4 h-4"
                                  fill="none"
                                  stroke="currentColor"
                                  viewBox="0 0 24 24"
                                >
                                  <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M19 9l-7 7-7-7"
                                  />
                                </svg>
                              </button>
                            </div>
                            {showPhpDropdown && (
                              <div className="absolute right-0 top-6 mt-1 w-20 bg-white border border-gray-200 rounded-md shadow-lg z-10">
                                {phpVersions.map((version) => (
                                  <button
                                    key={version}
                                    onClick={() =>
                                      handlePhpVersionChange(version)
                                    }
                                    className="block w-full text-center px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 focus:outline-none focus-visible:outline-none first:rounded-t-md last:rounded-b-md"
                                  >
                                    {version}
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>

                        <div className="flex items-center justify-between py-2 border-b border-gray-200">
                          <span className="text-sm font-medium text-gray-600">
                            Node Version:
                          </span>
                          <div className="relative version-dropdown">
                            <div className="flex items-center">
                              <input
                                type="text"
                                value={selectedSite.nodeVersion}
                                readOnly
                                className="w-16 px-2 py-1 text-xs text-center border border-gray-300 rounded-l-md bg-white focus:outline-none focus:ring-0 focus:ring-gray-300"
                              />
                              <button
                                onClick={() => {
                                  setShowNodeDropdown(!showNodeDropdown);
                                  setShowPhpDropdown(false);
                                }}
                                className="px-2 py-1 bg-blue-500 border border-blue-500 text-white rounded-r-md hover:bg-blue-600 transition-colors focus:outline-none focus:ring-0 focus:ring-blue-500"
                              >
                                <svg
                                  className="w-4 h-4"
                                  fill="none"
                                  stroke="currentColor"
                                  viewBox="0 0 24 24"
                                >
                                  <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M19 9l-7 7-7-7"
                                  />
                                </svg>
                              </button>
                            </div>
                            {showNodeDropdown && (
                              <div className="absolute right-0 top-6 mt-1 w-20 bg-white border border-gray-200 rounded-md shadow-lg z-10">
                                {nodeVersions.map((version) => (
                                  <button
                                    key={version}
                                    onClick={() =>
                                      handleNodeVersionChange(version)
                                    }
                                    className="block w-full text-center px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 focus:outline-none focus-visible:outline-none first:rounded-t-md last:rounded-b-md"
                                  >
                                    {version}
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>

                        <div className="flex items-center justify-start gap-3 py-2 border-b border-gray-200">
                          <span className="text-sm font-medium text-gray-600 block">
                            Path
                          </span>
                          <div className="break-all">
                            <span className="text-xs text-blue-600 hover:text-blue-800 cursor-pointer bg-blue-50 px-2 py-1 rounded-md font-mono">
                              {selectedSite.path}
                            </span>
                          </div>
                        </div>

                        <div className="flex items-center justify-start gap-3 py-2 border-b border-gray-200">
                          <div className="flex items-center space-x-2">
                            <span className="text-sm font-medium text-gray-600">
                              Linked Path
                            </span>
                            <LinkIcon className="h-4 w-4 text-gray-400" />
                          </div>
                          <div className="break-all">
                            <span className="text-xs text-blue-600 hover:text-blue-800 cursor-pointer bg-blue-50 px-2 py-1 rounded-md font-mono">
                              {selectedSite.linkedPath}
                            </span>
                          </div>
                        </div>

                        <div className="flex items-center justify-start gap-3 py-2">
                          <span className="text-sm font-medium text-gray-600 block">
                            URL
                          </span>
                          <div>
                            <a
                              href={selectedSite.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-xs text-blue-600 hover:text-blue-800 bg-blue-50 px-2 py-1 rounded-md font-mono inline-block"
                            >
                              {selectedSite.url}
                            </a>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </Tab.Panel>

              {/* Information Tab */}
              <Tab.Panel className="h-full overflow-y-auto">
                <div className="p-6">
                  <div className="bg-white border border-gray-200 rounded-xl p-8 shadow-sm">
                    <div className="text-center">
                      <div className="w-16 h-16 bg-blue-100 rounded-xl flex items-center justify-center mx-auto mb-4">
                        <svg
                          className="w-8 h-8 text-blue-500"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                          />
                        </svg>
                      </div>
                      <h3 className="text-lg font-semibold text-gray-900 mb-2">
                        Site Information
                      </h3>
                      <p className="text-gray-500">
                        Detailed information about this WordPress site will be
                        displayed here
                      </p>
                    </div>
                  </div>
                </div>
              </Tab.Panel>

              {/* Connect to Forge Tab */}
              <Tab.Panel className="h-full overflow-y-auto">
                <div className="p-6">
                  <div className="bg-white border border-gray-200 rounded-xl p-8 shadow-sm">
                    <div className="text-center">
                      <div className="w-16 h-16 bg-purple-100 rounded-xl flex items-center justify-center mx-auto mb-4">
                        <svg
                          className="w-8 h-8 text-purple-500"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"
                          />
                        </svg>
                      </div>
                      <h3 className="text-lg font-semibold text-gray-900 mb-2">
                        Connect to Laravel Forge
                      </h3>
                      <p className="text-gray-500">
                        Connect this site to Laravel Forge for deployment and
                        server management
                      </p>
                    </div>
                  </div>
                </div>
              </Tab.Panel>
            </Tab.Panels>
          </Tab.Group>
        </div>
      </div>

        </>
      ) : (
        <div className="flex-1 p-8">
          <div className="max-w-xl">
            <h2 className="text-lg font-semibold text-gray-900 mb-1">No sites yet</h2>
            <p className="text-sm text-gray-600 mb-5">
              Create your first site and QuickWP provisions a docroot, wires it to a PHP
              pool, and serves it.
            </p>
            <button
              onClick={openModal}
              className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              <PlusIcon className="h-4 w-4" />
              New site
            </button>
          </div>
        </div>
      )}

      {/* Add New Site Modal */}
      <Transition appear show={isModalOpen} as={Fragment}>
        <Dialog as="div" className="relative z-50" onClose={closeModal}>
          <Transition.Child
            as={Fragment}
            enter="ease-out duration-300"
            enterFrom="opacity-0"
            enterTo="opacity-100"
            leave="ease-in duration-200"
            leaveFrom="opacity-100"
            leaveTo="opacity-0"
          >
            <div className="fixed inset-0 bg-black bg-opacity-25" />
          </Transition.Child>

          <div className="fixed inset-0 overflow-y-auto">
            <div className="flex min-h-full items-center justify-center p-4 text-center">
              <Transition.Child
                as={Fragment}
                enter="ease-out duration-300"
                enterFrom="opacity-0 scale-95"
                enterTo="opacity-100 scale-100"
                leave="ease-in duration-200"
                leaveFrom="opacity-100 scale-100"
                leaveTo="opacity-0 scale-95"
              >
                <Dialog.Panel className="w-full max-w-5xl max-h-[90vh] transform overflow-hidden rounded-2xl bg-white text-left align-middle shadow-xl transition-all flex flex-col">
                  {modalStep === "select" && (
                    <>
                      {/* Modal Header */}
                      <div className="border-b border-gray-200 p-6 flex-shrink-0">
                        <div className="flex items-center justify-between">
                          <div>
                            <Dialog.Title
                              as="h3"
                              className="text-2xl font-bold text-gray-900"
                            >
                              Add New Site
                            </Dialog.Title>
                            <p className="text-gray-600 mt-2">
                              Choose the type of project you want to create
                            </p>
                          </div>
                          <button
                            onClick={closeModal}
                            className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
                          >
                            <XMarkIcon className="h-6 w-6" />
                          </button>
                        </div>
                      </div>

                      {/* Modal Content */}
                      <div className="flex-1 overflow-y-auto p-8">
                        {/* Project Options */}
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                          {projectOptions.map((option) => (
                            <button
                              key={option.id}
                              onClick={() => handleProjectSelect(option.id)}
                              className={clsx(
                                "p-6 border-2 rounded-xl text-left transition-all duration-200 hover:shadow-lg",
                                option.color === "red" &&
                                  "border-red-200 hover:border-red-300 hover:bg-red-50",
                                option.color === "blue" &&
                                  "border-blue-200 hover:border-blue-300 hover:bg-blue-50",
                                option.color === "green" &&
                                  "border-green-200 hover:border-green-300 hover:bg-green-50"
                              )}
                            >
                              <div className="flex items-center mb-4">
                                <div
                                  className={clsx(
                                    "w-12 h-12 rounded-lg flex items-center justify-center mr-4",
                                    option.color === "red" && "bg-red-100",
                                    option.color === "blue" && "bg-blue-100",
                                    option.color === "green" && "bg-green-100"
                                  )}
                                >
                                  <option.icon
                                    className={clsx(
                                      "h-6 w-6",
                                      option.color === "red" && "text-red-600",
                                      option.color === "blue" &&
                                        "text-blue-600",
                                      option.color === "green" &&
                                        "text-green-600"
                                    )}
                                  />
                                </div>
                              </div>
                              <h3 className="text-lg font-semibold text-gray-900 mb-2">
                                {option.name}
                              </h3>
                              <p className="text-gray-600 text-sm">
                                {option.description}
                              </p>
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* Modal Footer */}
                      <div className="border-t border-gray-200 p-6 flex-shrink-0">
                        <div className="flex justify-end">
                          <button
                            onClick={closeModal}
                            className="btn-secondary"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    </>
                  )}

                  {modalStep === "wordpress" && (
                    <>
                      {/* WordPress Creation Header */}
                      <div className="border-b border-gray-200 p-6 flex-shrink-0">
                        <div className="flex items-center justify-between">
                          <div>
                            <Dialog.Title
                              as="h3"
                              className="text-2xl font-bold text-gray-900"
                            >
                              Create New WordPress Site
                            </Dialog.Title>
                            <p className="text-gray-600 mt-1">
                              Set up a new WordPress development environment
                              with Laravel Herd
                            </p>
                          </div>
                          <button
                            onClick={closeModal}
                            className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
                          >
                            <XMarkIcon className="h-6 w-6" />
                          </button>
                        </div>
                      </div>

                      {/* Modal Content */}
                      <div className="flex-1 overflow-y-auto">
                        <div className="p-6 space-y-4">
                          {/* Smart Auto-Generation Section */}
                          <fieldset className="bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 rounded-xl p-4 shadow-sm">
                            <legend className="flex items-center text-md text-blue-900 bg-blue-200 px-2 py-1 rounded-md">
                              <div className="w-6 h-6 bg-blue-500 rounded-lg flex items-center justify-center mr-2">
                                <svg
                                  className="w-4 h-4 text-white"
                                  fill="none"
                                  stroke="currentColor"
                                  viewBox="0 0 24 24"
                                >
                                  <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M13 10V3L4 14h7v7l9-11h-7z"
                                  />
                                </svg>
                              </div>
                              Smart Auto-Generation
                            </legend>
                            <p className="text-blue-700 text-sm mb-4 border-b border-blue-200 pb-4">
                              Enter your site title and we'll automatically
                              generate the folder name, URL, and database name
                            </p>

                            <div className="flex items-center justify-between gap-4">
                              <div className="flex-1">
                                <label className="block text-sm font-medium text-blue-900 mb-2">
                                  Site Title *
                                </label>
                                <input
                                  type="text"
                                  value={config.siteTitle}
                                  onChange={(e) =>
                                    handleInputChange(
                                      "siteTitle",
                                      e.target.value
                                    )
                                  }
                                  placeholder="WordPress Site Title"
                                  className="w-full px-3 py-2 text-sm border border-blue-300 rounded-lg focus:outline-none focus:ring-0 focus:ring-blue-300 text-gray-900 placeholder-gray-500"
                                />
                              </div>

                              {/* {config.siteTitle && ( */}
                              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                <div>
                                  <label className="block text-sm font-medium text-blue-900 mb-2">
                                    Generated Folder Name
                                  </label>
                                  <input
                                    type="text"
                                    className="px-3 py-2 bg-blue-100 border border-blue-200 rounded-md text-sm text-blue-900 font-mono focus:outline-none focus:ring-0 focus:ring-blue-300"
                                    value={config.folderName ?? ""}
                                    onChange={(e) =>
                                      setConfig({
                                        ...config,
                                        folderName: e.target.value,
                                      })
                                    }
                                  />
                                </div>
                                <div>
                                  <label className="block text-sm font-medium text-blue-900 mb-2">
                                    Generated Site URL
                                  </label>
                                  <input
                                    type="text"
                                    className="px-3 py-2 bg-blue-100 border border-blue-200 rounded-md text-sm text-blue-900 font-mono focus:outline-none focus:ring-0 focus:ring-blue-300"
                                    value={config.siteUrl ?? ""}
                                    onChange={(e) =>
                                      setConfig({
                                        ...config,
                                        siteUrl: e.target.value,
                                      })
                                    }
                                  />
                                </div>
                                <div>
                                  <label className="block text-sm font-medium text-blue-900 mb-2">
                                    Generated Database Name
                                  </label>
                                  <input
                                    type="text"
                                    className="px-3 py-2 bg-blue-100 border border-blue-200 rounded-md text-sm text-blue-900 font-mono focus:outline-none focus:ring-0 focus:ring-blue-300"
                                    value={config.databaseName ?? ""}
                                    onChange={(e) =>
                                      setConfig({
                                        ...config,
                                        databaseName: e.target.value,
                                      })
                                    }
                                  />
                                </div>
                              </div>

                              {/* )} */}
                            </div>
                          </fieldset>

                          {/* WordPress Configuration */}
                          <fieldset className="bg-white border border-gray-200 rounded-xl p-4 shadow-sm">
                            <legend className="flex items-center text-md text-black bg-gray-200 px-2 py-1 rounded-md">
                              WordPress Configuration
                            </legend>

                            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                              <div>
                                <label className="block text-sm font-medium text-gray-700 mb-2">
                                  WordPress Version
                                </label>
                                <select
                                  value={config.wpVersion}
                                  onChange={(e) =>
                                    handleInputChange(
                                      "wpVersion",
                                      e.target.value
                                    )
                                  }
                                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-0 focus:ring-blue-300"
                                >
                                  <option value="latest">Latest Version</option>
                                  <option value="6.4">WordPress 6.4</option>
                                  <option value="6.3">WordPress 6.3</option>
                                  <option value="6.2">WordPress 6.2</option>
                                </select>
                              </div>
                              <div>
                                <label className="block text-sm font-medium text-gray-700 mb-2">
                                  PHP Version
                                </label>
                                <select
                                  value={config.phpVersion || "8.3"}
                                  onChange={(e) =>
                                    handleInputChange(
                                      "phpVersion",
                                      e.target.value
                                    )
                                  }
                                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-0 focus:ring-blue-300"
                                >
                                  <option value="8.3">PHP 8.3</option>
                                  <option value="8.2">PHP 8.2</option>
                                  <option value="8.1">PHP 8.1</option>
                                  <option value="8.0">PHP 8.0</option>
                                  <option value="7.4">PHP 7.4</option>
                                </select>
                              </div>
                              <div className="flex items-center">
                                <input
                                  type="checkbox"
                                  id="enableDebug"
                                  checked={config.enableDebug}
                                  onChange={(e) =>
                                    handleInputChange(
                                      "enableDebug",
                                      e.target.checked
                                    )
                                  }
                                  className="h-4 w-4 text-blue-600 focus:outline-none focus:ring-0 focus:ring-blue-300 border-gray-300 rounded"
                                />
                                <label
                                  htmlFor="enableDebug"
                                  className="ml-2 block text-sm text-gray-700"
                                >
                                  Enable Debug Mode
                                </label>
                              </div>
                            </div>
                          </fieldset>

                          {/* Admin User Configuration */}
                          <fieldset className="bg-white border border-gray-200 rounded-xl p-4 shadow-sm">
                            <legend className="flex items-center text-md text-black bg-gray-200 px-2 py-1 rounded-md">
                              Admin User Configuration
                            </legend>

                            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                              <div>
                                <label className="block text-sm font-medium text-gray-700 mb-2">
                                  Admin Username
                                </label>
                                <input
                                  type="text"
                                  value={config.adminUser}
                                  onChange={(e) =>
                                    handleInputChange(
                                      "adminUser",
                                      e.target.value
                                    )
                                  }
                                  placeholder="admin"
                                  className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-0 focus:ring-blue-300"
                                />
                              </div>

                              <div>
                                <label className="block text-sm font-medium text-gray-700 mb-2">
                                  Admin Password
                                </label>
                                <input
                                  type="password"
                                  value={config.adminPassword}
                                  onChange={(e) =>
                                    handleInputChange(
                                      "adminPassword",
                                      e.target.value
                                    )
                                  }
                                  placeholder="Enter admin password"
                                  className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-0 focus:ring-blue-300"
                                />
                              </div>

                              <div>
                                <label className="block text-sm font-medium text-gray-700 mb-2">
                                  Admin Email
                                </label>
                                <input
                                  type="email"
                                  value={config.adminEmail}
                                  onChange={(e) =>
                                    handleInputChange(
                                      "adminEmail",
                                      e.target.value
                                    )
                                  }
                                  placeholder="admin@example.com"
                                  className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-0 focus:ring-blue-300"
                                />
                              </div>
                            </div>
                          </fieldset>

                          {/* Progress and Terminal Output */}
                          {isInstalling && (
                            <div className="bg-white border border-gray-200 rounded-xl p-6 shadow-sm">
                              <div className="flex items-center mb-4">
                                <div className="w-10 h-10 bg-green-500 rounded-lg flex items-center justify-center mr-4">
                                  <PlayIcon className="w-6 h-6 text-white" />
                                </div>
                                <div>
                                  <h2 className="text-lg font-semibold text-gray-900">
                                    Installing WordPress Site
                                  </h2>
                                  <p className="text-gray-600 text-sm">
                                    {currentStep || "Preparing installation..."}
                                  </p>
                                </div>
                              </div>
                              <ProgressBar
                                progress={progress}
                                className="mb-4"
                              />
                              <TerminalOutput
                                output={terminalOutput}
                                className="max-h-40"
                              />
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Modal Footer */}
                      <div className="border-t border-gray-200 p-6 flex-shrink-0">
                        <div className="flex flex-col sm:flex-row gap-4 justify-between">
                          <button
                            type="button"
                            onClick={() => setModalStep("select")}
                            disabled={isInstalling}
                            className="btn-secondary disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            <ArrowLeftIcon className="h-5 w-5 mr-2" />
                            Back
                          </button>
                          <button
                            onClick={installDone ? closeModal : simulateInstallation}
                            disabled={(!config.siteTitle && !installDone) || isInstalling}
                            className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            {isInstalling ? (
                              <>
                                <StopIcon className="h-5 w-5 mr-2" />
                                Installing...
                              </>
                            ) : installDone ? (
                              // Not auto-closed: the admin password is printed
                              // once and closing on a timer would take it away
                              // before it could be copied.
                              <>Done — close</>
                            ) : (
                              <>
                                <PlayIcon className="h-5 w-5 mr-2" />
                                Create WordPress Site
                              </>
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
        </Dialog>
      </Transition>
    </div>
  );
}
