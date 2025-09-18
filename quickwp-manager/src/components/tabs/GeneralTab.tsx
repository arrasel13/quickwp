import { HomeIcon } from "@heroicons/react/24/outline";

export default function GeneralTab() {
  return (
    <div className="max-w-6xl mx-auto p-4">
      <div className="space-y-8">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900 mb-2">
            General Settings
          </h1>
          <p className="text-gray-600">
            General application settings and preferences
          </p>
        </div>

        {/* Placeholder Content */}
        <div className="bg-white border border-gray-200 rounded-xl p-8 shadow-sm">
          <div className="flex items-center mb-6">
            <div className="w-10 h-10 bg-gray-500 rounded-lg flex items-center justify-center mr-4">
              <HomeIcon className="w-6 h-6 text-white" />
            </div>
            <div>
              <h2 className="text-xl font-semibold text-gray-900">
                General Settings
              </h2>
              <p className="text-gray-600 text-sm">
                Content will be added later
              </p>
            </div>
          </div>

          <div className="text-center py-12">
            <div className="text-gray-400 mb-4">
              <svg
                className="w-16 h-16 mx-auto"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1}
                  d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
                />
              </svg>
            </div>
            <h3 className="text-lg font-medium text-gray-900 mb-2">
              Coming Soon
            </h3>
            <p className="text-gray-500">
              General settings and configuration options will be available here.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
