import { useState } from "react";
import { CheckIcon, ChevronRightIcon } from "@heroicons/react/24/outline";
import clsx from "clsx";

interface PHPVersion {
  version: string;
  fullVersion?: string;
  status: "installed" | "available";
}

export default function PHPTab() {
  const [phpVersions] = useState<PHPVersion[]>([
    {
      version: "8.5",
      status: "available",
    },
    {
      version: "8.4",
      fullVersion: "8.4.12",
      status: "installed",
    },
    {
      version: "8.3",
      fullVersion: "8.3.25",
      status: "installed",
    },
    {
      version: "8.2",
      fullVersion: "8.2.29",
      status: "installed",
    },
    {
      version: "8.1",
      status: "available",
    },
    {
      version: "8.0",
      status: "available",
    },
    {
      version: "7.4",
      status: "available",
    },
  ]);

  const [notifyUpdates, setNotifyUpdates] = useState(true);
  const [maxFileUploadExpanded, setMaxFileUploadExpanded] = useState(false);
  const [memoryLimitExpanded, setMemoryLimitExpanded] = useState(false);
  const [maxFileUploadSize, setMaxFileUploadSize] = useState("1024");
  const [memoryLimit, setMemoryLimit] = useState("2048");

  const handleInstall = (version: string) => {
    console.log(`Installing PHP ${version}`);
    // Here you would implement the actual PHP installation logic
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">PHP</h1>
      </div>

      {/* Available Versions */}
      <div className="bg-white rounded-lg border border-gray-200">
        <div className="p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-2">
            Available Versions
          </h2>
          <p className="text-sm text-gray-600 mb-6">
            Install, update and manage PHP.
          </p>

          {/* Versions Table */}
          <div className="border border-gray-200 rounded-lg overflow-hidden">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Version
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Action
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {phpVersions.map((php) => (
                  <tr key={php.version} className="hover:bg-gray-50">
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="flex items-center">
                        <span className="text-sm font-medium text-gray-900">
                          {php.version}
                        </span>
                        {php.fullVersion && (
                          <span className="ml-2 text-sm text-gray-500">
                            ({php.fullVersion})
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-right">
                      {php.status === "installed" ? (
                        <div className="flex items-center justify-end">
                          <CheckIcon className="h-5 w-5 text-green-500" />
                        </div>
                      ) : (
                        <button
                          onClick={() => handleInstall(php.version)}
                          className="inline-flex items-center px-3 py-1.5 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                        >
                          Install
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Notify About PHP Updates */}
      <div className="bg-white rounded-lg border border-gray-200 p-6">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-base font-medium text-gray-900">
              Notify About PHP Updates:
            </h3>
          </div>
          <div className="flex items-center">
            <button
              type="button"
              className={clsx(
                "relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-blue-600 focus:ring-offset-2",
                notifyUpdates ? "bg-blue-600" : "bg-gray-200"
              )}
              role="switch"
              aria-checked={notifyUpdates}
              onClick={() => setNotifyUpdates(!notifyUpdates)}
            >
              <span
                aria-hidden="true"
                className={clsx(
                  "pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out",
                  notifyUpdates ? "translate-x-5" : "translate-x-0"
                )}
              />
            </button>
          </div>
        </div>
      </div>

      {/* Laravel Installer */}
      <div className="bg-white rounded-lg border border-gray-200 p-6">
        <div>
          <h3 className="text-base font-medium text-gray-900 mb-1">
            Laravel Installer
          </h3>
          <p className="text-sm text-gray-600">
            You are running the latest version of the Laravel Installer
            (5.17.0).
          </p>
        </div>
      </div>

      {/* Max File Upload Size */}
      <div className="bg-white rounded-lg border border-gray-200">
        <button
          onClick={() => setMaxFileUploadExpanded(!maxFileUploadExpanded)}
          className="w-full px-6 py-4 flex items-center justify-between text-left hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-blue-500"
        >
          <div>
            <h3 className="text-base font-medium text-gray-900">
              Max File Upload Size:
            </h3>
            <p className="text-sm text-gray-600 mt-1">
              Configure the maximum file size that PHP will accept as file
              uploads (in MB).
            </p>
          </div>
          <ChevronRightIcon
            className={clsx(
              "h-5 w-5 text-gray-400 transition-transform duration-200",
              maxFileUploadExpanded ? "rotate-90" : ""
            )}
          />
        </button>
        {maxFileUploadExpanded && (
          <div className="px-6 pb-4 border-t border-gray-200">
            <div className="pt-4">
              <input
                type="text"
                value={maxFileUploadSize}
                onChange={(e) => setMaxFileUploadSize(e.target.value)}
                className="block w-32 px-3 py-2 border border-gray-300 rounded-md shadow-sm placeholder-gray-400 focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                placeholder="1024"
              />
            </div>
          </div>
        )}
      </div>

      {/* Memory Limit */}
      <div className="bg-white rounded-lg border border-gray-200">
        <button
          onClick={() => setMemoryLimitExpanded(!memoryLimitExpanded)}
          className="w-full px-6 py-4 flex items-center justify-between text-left hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-blue-500"
        >
          <div>
            <h3 className="text-base font-medium text-gray-900">
              Memory Limit:
            </h3>
            <p className="text-sm text-gray-600 mt-1">
              Configure the maximum amount of memory your PHP scripts may
              consume (in MB). -1 for unlimited.
            </p>
          </div>
          <ChevronRightIcon
            className={clsx(
              "h-5 w-5 text-gray-400 transition-transform duration-200",
              memoryLimitExpanded ? "rotate-90" : ""
            )}
          />
        </button>
        {memoryLimitExpanded && (
          <div className="px-6 pb-4 border-t border-gray-200">
            <div className="pt-4">
              <input
                type="text"
                value={memoryLimit}
                onChange={(e) => setMemoryLimit(e.target.value)}
                className="block w-32 px-3 py-2 border border-gray-300 rounded-md shadow-sm placeholder-gray-400 focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                placeholder="2048"
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
