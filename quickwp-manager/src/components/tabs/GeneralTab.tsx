import { useState, useEffect } from "react";
import { PlayIcon, StopIcon } from "@heroicons/react/24/outline";
import ProgressBar from "../ui/ProgressBar";
import TerminalOutput from "../ui/TerminalOutput";

interface SiteConfig {
  siteTitle: string;
  folderName: string;
  siteUrl: string;
  databaseName: string;
  wpVersion: string;
  enableDebug: boolean;
  adminUser: string;
  adminPassword: string;
  adminEmail: string;
}

export default function GeneralTab() {
  const [config, setConfig] = useState<SiteConfig>({
    siteTitle: "",
    folderName: "",
    siteUrl: "",
    databaseName: "",
    wpVersion: "latest",
    enableDebug: false,
    adminUser: "admin",
    adminPassword: "",
    adminEmail: "",
  });

  const [isInstalling, setIsInstalling] = useState(false);
  const [progress, setProgress] = useState(0);
  const [terminalOutput, setTerminalOutput] = useState<string[]>([]);
  const [currentStep, setCurrentStep] = useState("");

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

  const handleInputChange = (
    field: keyof SiteConfig,
    value: string | boolean
  ) => {
    setConfig((prev) => ({
      ...prev,
      [field]: value,
    }));
  };

  const addTerminalOutput = (message: string) => {
    setTerminalOutput((prev) => [
      ...prev,
      `[${new Date().toLocaleTimeString()}] ${message}`,
    ]);
  };

  const simulateInstallation = async () => {
    setIsInstalling(true);
    setProgress(0);
    setTerminalOutput([]);

    const steps = [
      { message: "Checking Laravel Herd status...", duration: 1000 },
      { message: "Creating project directory...", duration: 800 },
      { message: "Downloading WordPress...", duration: 2000 },
      { message: "Setting up database...", duration: 1500 },
      { message: "Configuring wp-config.php...", duration: 1000 },
      { message: "Running WordPress installation...", duration: 2000 },
      { message: "Installing themes and plugins...", duration: 1500 },
      { message: "Finalizing setup...", duration: 800 },
    ];

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      setCurrentStep(step.message);
      addTerminalOutput(step.message);

      await new Promise((resolve) => setTimeout(resolve, step.duration));
      setProgress(((i + 1) / steps.length) * 100);
    }

    addTerminalOutput("✅ WordPress installation completed successfully!");
    addTerminalOutput(`🌐 Site available at: http://${config.siteUrl}`);
    setCurrentStep("Installation completed");
    setIsInstalling(false);
  };

  const generatePassword = () => {
    const chars =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*";
    let password = "";
    for (let i = 0; i < 12; i++) {
      password += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    handleInputChange("adminPassword", password);
  };

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-2xl font-bold text-gray-900 mb-6">
          Create New WordPress Site
        </h2>

        {/* Smart Auto-Generation Section */}
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-6 mb-8">
          <h3 className="text-lg font-semibold text-blue-900 mb-4">
            Smart Auto-Generation
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Site Title
              </label>
              <input
                type="text"
                value={config.siteTitle}
                onChange={(e) => handleInputChange("siteTitle", e.target.value)}
                className="form-input"
                placeholder="Enter your site title..."
              />
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-500 mb-1">
                  Generated Folder Name
                </label>
                <div className="px-3 py-2 bg-gray-100 border border-gray-300 rounded-md text-sm text-gray-700">
                  {config.folderName || "auto-generated"}
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-500 mb-1">
                  Generated Site URL
                </label>
                <div className="px-3 py-2 bg-gray-100 border border-gray-300 rounded-md text-sm text-gray-700">
                  {config.siteUrl || "auto-generated.test"}
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-500 mb-1">
                  Generated Database Name
                </label>
                <div className="px-3 py-2 bg-gray-100 border border-gray-300 rounded-md text-sm text-gray-700">
                  {config.databaseName || "auto_generated"}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Configuration Section */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              WordPress Version
            </label>
            <select
              value={config.wpVersion}
              onChange={(e) => handleInputChange("wpVersion", e.target.value)}
              className="form-input"
            >
              <option value="latest">Latest</option>
              <option value="6.4">WordPress 6.4</option>
              <option value="6.3">WordPress 6.3</option>
              <option value="6.2">WordPress 6.2</option>
            </select>
          </div>
          <div className="flex items-center">
            <input
              type="checkbox"
              id="debug"
              checked={config.enableDebug}
              onChange={(e) =>
                handleInputChange("enableDebug", e.target.checked)
              }
              className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 rounded"
            />
            <label htmlFor="debug" className="ml-2 block text-sm text-gray-700">
              Enable WP_DEBUG
            </label>
          </div>
        </div>

        {/* Admin User Section */}
        <div className="bg-gray-50 border border-gray-200 rounded-lg p-6 mb-8">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">
            Admin User
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Username
              </label>
              <input
                type="text"
                value={config.adminUser}
                onChange={(e) => handleInputChange("adminUser", e.target.value)}
                className="form-input"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Password
              </label>
              <div className="flex">
                <input
                  type="password"
                  value={config.adminPassword}
                  onChange={(e) =>
                    handleInputChange("adminPassword", e.target.value)
                  }
                  className="form-input rounded-r-none"
                />
                <button
                  type="button"
                  onClick={generatePassword}
                  className="px-3 py-2 bg-gray-200 border border-l-0 border-gray-300 rounded-r-md text-sm hover:bg-gray-300"
                >
                  Generate
                </button>
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Email
              </label>
              <input
                type="email"
                value={config.adminEmail}
                onChange={(e) =>
                  handleInputChange("adminEmail", e.target.value)
                }
                className="form-input"
                placeholder="admin@example.com"
              />
            </div>
          </div>
        </div>

        {/* Installation Progress */}
        {(isInstalling || progress > 0) && (
          <div className="bg-white border border-gray-200 rounded-lg p-6 mb-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">
              Installation Progress
            </h3>
            <ProgressBar progress={progress} />
            <p className="text-sm text-gray-600 mt-2">{currentStep}</p>
          </div>
        )}

        {/* Terminal Output */}
        {terminalOutput.length > 0 && (
          <div className="mb-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">
              Terminal Output
            </h3>
            <TerminalOutput output={terminalOutput} />
          </div>
        )}

        {/* Action Buttons */}
        <div className="flex space-x-4">
          <button
            onClick={simulateInstallation}
            disabled={!config.siteTitle || isInstalling}
            className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isInstalling ? (
              <>
                <StopIcon className="h-4 w-4 mr-2" />
                Installing...
              </>
            ) : (
              <>
                <PlayIcon className="h-4 w-4 mr-2" />
                Create WordPress Site
              </>
            )}
          </button>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => {
              setConfig({
                siteTitle: "",
                folderName: "",
                siteUrl: "",
                databaseName: "",
                wpVersion: "latest",
                enableDebug: false,
                adminUser: "admin",
                adminPassword: "",
                adminEmail: "",
              });
              setTerminalOutput([]);
              setProgress(0);
            }}
          >
            Reset Form
          </button>
        </div>
      </div>
    </div>
  );
}
