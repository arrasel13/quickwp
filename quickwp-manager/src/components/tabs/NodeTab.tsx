import { useState } from "react";
import { CheckIcon } from "@heroicons/react/24/outline";

interface NodeVersion {
  majorVersion: string;
  fullVersion?: string;
  status: "installed" | "available";
}

export default function NodeTab() {
  const [nodeVersions] = useState<NodeVersion[]>([
    {
      majorVersion: "22",
      fullVersion: "22.19.0",
      status: "installed",
    },
    {
      majorVersion: "20",
      status: "available",
    },
    {
      majorVersion: "18",
      fullVersion: "18.20.8",
      status: "installed",
    },
    {
      majorVersion: "16",
      status: "available",
    },
  ]);

  const handleInstall = (version: string) => {
    console.log(`Installing Node.js ${version}`);
    // Here you would implement the actual Node.js installation logic
  };

  return (
    <div className="max-w-6xl mx-auto p-4">
      <div className="space-y-4">
        {/* Header */}
        <div className="mb-4">
          <h1 className="text-2xl font-bold text-gray-900">Node.js</h1>
        </div>

        {/* Node.js Versions */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm">
          <div className="p-4">
            <div className="mb-3">
              <h2 className="text-lg font-semibold text-gray-900">
                Node.js Versions
              </h2>
              <p className="text-gray-600 text-xs">
                Install and manage Node.js versions for your development
                environment
              </p>
            </div>

            {/* Versions Table */}
            <div className="border border-gray-200 rounded-xl overflow-hidden">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-2 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">
                      Major Version
                    </th>
                    <th className="px-4 py-2 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">
                      Status
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-100">
                  {nodeVersions.map((node) => (
                    <tr
                      key={node.majorVersion}
                      className="hover:bg-gray-50 transition-colors"
                    >
                      <td className="px-4 py-1 whitespace-nowrap">
                        <div className="flex items-center">
                          <span className="text-sm font-semibold text-gray-900">
                            Node.js {node.majorVersion}
                          </span>
                          {node.fullVersion && (
                            <span className="ml-3 text-sm text-gray-500 bg-gray-100 px-2 py-1 rounded">
                              {node.fullVersion}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-right">
                        {node.status === "installed" ? (
                          <div className="flex items-center justify-end">
                            <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800">
                              <CheckIcon className="h-3 w-3 mr-1" />
                              Installed
                            </span>
                          </div>
                        ) : (
                          <button
                            onClick={() => handleInstall(node.majorVersion)}
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
      </div>
    </div>
  );
}
