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
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Node.js</h1>
      </div>

      {/* Node.js Versions */}
      <div className="bg-white rounded-lg border border-gray-200">
        <div className="p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-2">
            Node.js Versions
          </h2>
          <p className="text-sm text-gray-600 mb-6">
            Install and Update Node.js
          </p>

          {/* Versions Table */}
          <div className="border border-gray-200 rounded-lg overflow-hidden">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Major Version
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Installed Versions
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {nodeVersions.map((node) => (
                  <tr key={node.majorVersion} className="hover:bg-gray-50">
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="flex items-center">
                        <span className="text-sm font-medium text-gray-900">
                          {node.majorVersion}
                        </span>
                        {node.fullVersion && (
                          <span className="ml-2 text-sm text-gray-500">
                            ({node.fullVersion})
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-right">
                      {node.status === "installed" ? (
                        <div className="flex items-center justify-end">
                          <CheckIcon className="h-5 w-5 text-green-500" />
                        </div>
                      ) : (
                        <button
                          onClick={() => handleInstall(node.majorVersion)}
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
    </div>
  );
}
