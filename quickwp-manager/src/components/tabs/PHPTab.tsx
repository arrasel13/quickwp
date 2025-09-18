import { useState } from "react";
import { CheckIcon } from "@heroicons/react/24/outline";
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
  const [maxFileUploadSize, setMaxFileUploadSize] = useState("1024");
  const [memoryLimit, setMemoryLimit] = useState("2048");

  const handleInstall = (version: string) => {
    console.log(`Installing PHP ${version}`);
    // Here you would implement the actual PHP installation logic
  };

  return (
    <div className="max-w-6xl mx-auto p-4">
      <div className="space-y-4">
        {/* Header */}
        <div className="">
          <h1 className="text-2xl font-bold text-gray-900">PHP</h1>
        </div>

        {/* Available Versions */}
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
          <div className="p-4">
            <div className="mb-3">
              <h2 className="text-lg font-semibold text-gray-900">
                Available Versions
              </h2>
              <p className="text-gray-600 text-xs">
                Install, update and manage PHP versions for your projects
              </p>
            </div>

            {/* Versions Table */}
            <div className="border border-gray-200 rounded-lg overflow-hidden">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-2 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">
                      Version
                    </th>
                    <th className="px-4 py-2 text-right text-xs font-semibold text-gray-600 uppercase tracking-wider">
                      Status
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-100">
                  {phpVersions.map((php) => (
                    <tr
                      key={php.version}
                      className="hover:bg-gray-50 transition-colors"
                    >
                      <td className="px-4 py-1 whitespace-nowrap">
                        <div className="flex items-center">
                          <span className="text-sm font-semibold text-gray-900">
                            PHP {php.version}
                          </span>
                          {php.fullVersion && (
                            <span className="ml-2 text-xs text-gray-500 bg-gray-100 px-2 py-1 rounded">
                              {php.fullVersion}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-right">
                        {php.status === "installed" ? (
                          <div className="flex items-center justify-end">
                            <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800">
                              <CheckIcon className="h-3 w-3 mr-1" />
                              Installed
                            </span>
                          </div>
                        ) : (
                          <button
                            onClick={() => handleInstall(php.version)}
                            className="inline-flex items-center px-3 py-1 border border-gray-300 text-xs font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-colors"
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

        {/* PHP Update Notifications and Laravel Installer */}
        <div className="bg-white rounded-lg border border-gray-200 p-4 shadow-sm">
          <div className="space-y-2">
            {/* PHP Update Notifications */}

            <div className="flex items-center justify-between mb-4 pb-4 border-b border-gray-200">
              <h3 className="text-sm font-semibold text-gray-900">
                PHP Update Notifications
              </h3>
              <button
                type="button"
                className={clsx(
                  "relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-blue-600 focus:ring-offset-2",
                  notifyUpdates ? "bg-blue-600" : "bg-gray-200"
                )}
                role="switch"
                aria-checked={notifyUpdates}
                onClick={() => setNotifyUpdates(!notifyUpdates)}
              >
                <span
                  aria-hidden="true"
                  className={clsx(
                    "pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out",
                    notifyUpdates ? "translate-x-4" : "translate-x-0"
                  )}
                />
              </button>
            </div>

            {/* Laravel Installer */}
            <div className="">
              <h3 className="text-sm font-semibold text-gray-900">
                Laravel Installer
              </h3>
              <p className="text-xs text-gray-600">
                Latest version (5.17.0) installed
              </p>
            </div>
          </div>
        </div>

        {/* PHP Configuration Settings */}
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
          <div className="px-4 py-4">
            <h3 className="text-lg font-semibold text-gray-900 mb-3">
              PHP Configuration
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Max File Upload Size */}
              <div className="border border-gray-200 rounded-lg p-3">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center">
                    <div className="w-6 h-6 bg-blue-500 rounded flex items-center justify-center mr-2">
                      <svg
                        className="w-3 h-3 text-white"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
                        />
                      </svg>
                    </div>
                    <div>
                      <h4 className="text-sm font-semibold text-gray-900">
                        Max File Upload Size
                      </h4>
                      <p className="text-xs text-gray-600">
                        Configure max file upload size (MB)
                      </p>
                    </div>
                  </div>
                </div>
                <div className="mt-2">
                  <label className="block text-xs font-medium text-gray-700 mb-1">
                    Upload Size (MB)
                  </label>
                  <input
                    type="text"
                    value={maxFileUploadSize}
                    onChange={(e) => setMaxFileUploadSize(e.target.value)}
                    className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm placeholder-gray-400 focus:outline-none focus:ring-blue-500 focus:border-blue-500 text-sm"
                    placeholder="1024"
                  />
                </div>
              </div>

              {/* Memory Limit */}
              <div className="border border-gray-200 rounded-lg p-3">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center">
                    <div className="w-6 h-6 bg-green-500 rounded flex items-center justify-center mr-2">
                      <svg
                        className="w-3 h-3 text-white"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z"
                        />
                      </svg>
                    </div>
                    <div>
                      <h4 className="text-sm font-semibold text-gray-900">
                        Memory Limit
                      </h4>
                      <p className="text-xs text-gray-600">
                        Configure max memory usage (MB, -1 for unlimited)
                      </p>
                    </div>
                  </div>
                </div>
                <div className="mt-2">
                  <label className="block text-xs font-medium text-gray-700 mb-1">
                    Memory Limit (MB)
                  </label>
                  <input
                    type="text"
                    value={memoryLimit}
                    onChange={(e) => setMemoryLimit(e.target.value)}
                    className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm placeholder-gray-400 focus:outline-none focus:ring-blue-500 focus:border-blue-500 text-sm"
                    placeholder="2048"
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
