import { useState, useEffect } from "react";
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
  ChartBarIcon,
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
  const [sites] = useState<WordPressSite[]>([
    {
      id: "1",
      name: "devplugin.test",
      url: "https://devplugin.test",
      path: "~/Library/Application Support/Herd/config/valet/Sites/devp...",
      linkedPath: "~/Mine/wordpress_sites/devplugin",
      phpVersion: "8.3",
      nodeVersion: "22",
      status: "running",
    },
    {
      id: "2",
      name: "gitdev.test",
      url: "https://gitdev.test",
      path: "~/Library/Application Support/Herd/config/valet/Sites/gitdev",
      linkedPath: "~/Mine/wordpress_sites/gitdev",
      phpVersion: "8.3",
      nodeVersion: "22",
      status: "running",
    },
    {
      id: "3",
      name: "newtest.test",
      url: "https://newtest.test",
      path: "~/Library/Application Support/Herd/config/valet/Sites/newtest",
      linkedPath: "~/Mine/wordpress_sites/newtest",
      phpVersion: "8.3",
      nodeVersion: "22",
      status: "running",
    },
    {
      id: "4",
      name: "templatelytest.test",
      url: "https://templatelytest.test",
      path: "~/Library/Application Support/Herd/config/valet/Sites/templatelytest",
      linkedPath: "~/Mine/wordpress_sites/templatelytest",
      phpVersion: "8.3",
      nodeVersion: "22",
      status: "running",
    },
    {
      id: "5",
      name: "wordpress_test.test",
      url: "https://wordpress_test.test",
      path: "~/Library/Application Support/Herd/config/valet/Sites/wordpress_test",
      linkedPath: "~/Mine/wordpress_sites/wordpress_test",
      phpVersion: "8.3",
      nodeVersion: "22",
      status: "running",
    },
    {
      id: "6",
      name: "wpdev.test",
      url: "https://wpdev.test",
      path: "~/Library/Application Support/Herd/config/valet/Sites/wpdev",
      linkedPath: "~/Mine/wordpress_sites/wpdev",
      phpVersion: "8.3",
      nodeVersion: "22",
      status: "running",
    },
  ]);

  const [selectedSite, setSelectedSite] = useState<WordPressSite>(sites[0]);
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
    { id: "ide", name: "IDE", icon: CodeBracketIcon },
    { id: "logs", name: "Logs", icon: DocumentTextIcon },
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
  };

  const handleProjectSelect = (projectType: ProjectType) => {
    setSelectedProjectType(projectType);
    if (projectType === "wordpress") {
      setModalStep("wordpress");
    } else {
      // For Laravel and existing projects, we'll handle them later
      alert(`${projectType} project creation will be implemented soon!`);
      closeModal();
    }
  };

  const simulateInstallation = async () => {
    setIsInstalling(true);
    setProgress(0);
    setTerminalOutput([]);

    const steps = [
      "Checking Laravel Herd status...",
      "Creating project directory...",
      "Downloading WordPress...",
      "Setting up database...",
      "Configuring wp-config.php...",
      "Running WordPress installation...",
      "Installing themes and plugins...",
      "Finalizing setup...",
    ];

    for (let i = 0; i < steps.length; i++) {
      setCurrentStep(steps[i]);
      setTerminalOutput((prev) => [...prev, `> ${steps[i]}`]);
      setProgress(((i + 1) / steps.length) * 100);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    setTerminalOutput((prev) => [
      ...prev,
      "",
      "✅ WordPress site created successfully!",
      `🌐 Site URL: ${config.siteUrl}`,
      `📁 Project Path: ~/Mine/wordpress_sites/${config.folderName}`,
      "",
      "You can now access your site and start developing!",
    ]);

    setIsInstalling(false);
    setCurrentStep("");

    // Close modal after successful installation
    setTimeout(() => {
      closeModal();
    }, 2000);
  };

  // Version switching functions
  const handlePhpVersionChange = (version: string) => {
    setSelectedSite((prev) => ({ ...prev, phpVersion: version }));
    setShowPhpDropdown(false);
  };

  const handleNodeVersionChange = (version: string) => {
    setSelectedSite((prev) => ({ ...prev, nodeVersion: version }));
    setShowNodeDropdown(false);
  };

  // Actions handler
  const handleActionClick = (actionId: string) => {
    setShowActionsDropdown(false);

    switch (actionId) {
      case "terminal":
        alert("Opening Terminal for " + selectedSite.name);
        break;
      case "ide":
        alert("Opening IDE for " + selectedSite.name);
        break;
      case "logs":
        alert("Opening Logs for " + selectedSite.name);
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

  return (
    <div className="h-screen flex flex-col">
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
                            onClick={simulateInstallation}
                            disabled={!config.siteTitle || isInstalling}
                            className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            {isInstalling ? (
                              <>
                                <StopIcon className="h-5 w-5 mr-2" />
                                Installing...
                              </>
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
