import { useState } from "react";
import { Tab } from "@headlessui/react";
import {
  GlobeAltIcon,
  MagnifyingGlassIcon,
  CogIcon,
  LockClosedIcon,
  LinkIcon,
  PlusIcon,
} from "@heroicons/react/24/outline";
import clsx from "clsx";

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

  const siteDetailTabs = [
    { name: "General", id: "general" },
    { name: "Information", id: "information" },
    { name: "Connect to Forge", id: "forge" },
  ];

  return (
    <div className="h-screen bg-gray-100 flex flex-col">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <GlobeAltIcon className="h-6 w-6 text-gray-600" />
            <h1 className="text-lg font-semibold text-gray-900">
              {selectedSite.name}
            </h1>
          </div>
          <div className="flex items-center space-x-4">
            <button className="p-2 text-gray-400 hover:text-gray-600">
              <CogIcon className="h-5 w-5" />
            </button>
            <button className="p-2 text-gray-400 hover:text-gray-600">
              <LockClosedIcon className="h-5 w-5" />
            </button>
            <div className="relative">
              <MagnifyingGlassIcon className="h-5 w-5 absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400" />
              <input
                type="text"
                placeholder="Search"
                className="pl-10 pr-4 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex">
        {/* Left Sidebar - Sites List */}
        <div className="w-80 bg-gray-50 border-r border-gray-200">
          <div className="p-4">
            <div className="mb-4">
              <h3 className="text-sm font-medium text-gray-500 mb-2">
                Ungrouped
              </h3>
            </div>
            <div className="space-y-1">
              {sites.map((site) => (
                <button
                  key={site.id}
                  onClick={() => setSelectedSite(site)}
                  className={clsx(
                    "w-full flex items-center justify-between p-3 rounded-lg text-left hover:bg-gray-100",
                    selectedSite.id === site.id
                      ? "bg-blue-50 border border-blue-200"
                      : "bg-white border border-gray-200"
                  )}
                >
                  <span className="text-sm font-medium text-gray-900">
                    {site.name}
                  </span>
                  <div className="flex items-center space-x-2">
                    <LinkIcon className="h-4 w-4 text-gray-400" />
                    <LockClosedIcon className="h-4 w-4 text-gray-400" />
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Add Site Button */}
          <div className="absolute bottom-4 left-4 right-4">
            <button className="w-full flex items-center justify-center px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors">
              <PlusIcon className="h-4 w-4 mr-2" />
              Add Site
            </button>
          </div>
        </div>

        {/* Right Content - Site Details */}
        <div className="flex-1 flex flex-col">
          {/* Site Detail Tabs */}
          <Tab.Group>
            <Tab.List className="flex border-b border-gray-200 bg-white px-6">
              {siteDetailTabs.map((tab) => (
                <Tab
                  key={tab.id}
                  className={({ selected }) =>
                    clsx(
                      "py-3 px-4 text-sm font-medium border-b-2 focus:outline-none",
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

            <Tab.Panels className="flex-1 bg-white">
              {/* General Tab */}
              <Tab.Panel className="p-6 h-full">
                <div className="flex h-full">
                  {/* Left side - Site preview */}
                  <div className="flex-1 pr-6">
                    <div className="bg-gray-100 rounded-lg h-full flex items-center justify-center">
                      <div className="text-center">
                        <div className="w-16 h-16 bg-white rounded-lg shadow-sm flex items-center justify-center mb-4 mx-auto">
                          <GlobeAltIcon className="h-8 w-8 text-gray-400" />
                        </div>
                        <p className="text-sm text-gray-500">
                          Site preview will appear here
                        </p>
                      </div>
                    </div>
                  </div>

                  {/* Right side - Site details */}
                  <div className="w-80">
                    <div className="flex items-center justify-between mb-6">
                      <h3 className="text-lg font-semibold text-gray-900">
                        {selectedSite.name.replace(".test", "")}
                      </h3>
                      <button className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors">
                        Actions
                      </button>
                    </div>

                    <div className="space-y-4">
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
                              showPreview ? "translate-x-6" : "translate-x-1"
                            )}
                          />
                        </button>
                      </div>

                      {/* Site Information */}
                      <div className="space-y-3">
                        <div className="flex items-center justify-between">
                          <span className="text-sm text-gray-500">
                            PHP Version:
                          </span>
                          <div className="flex items-center space-x-2">
                            <span className="text-sm font-medium text-gray-900">
                              {selectedSite.phpVersion}
                            </span>
                            <button className="p-1 text-gray-400 hover:text-gray-600">
                              <CogIcon className="h-4 w-4" />
                            </button>
                          </div>
                        </div>

                        <div className="flex items-center justify-between">
                          <span className="text-sm text-gray-500">
                            Node Version:
                          </span>
                          <div className="flex items-center space-x-2">
                            <span className="text-sm font-medium text-gray-900">
                              {selectedSite.nodeVersion}
                            </span>
                            <button className="p-1 text-gray-400 hover:text-gray-600">
                              <CogIcon className="h-4 w-4" />
                            </button>
                          </div>
                        </div>

                        <div className="space-y-1">
                          <span className="text-sm text-gray-500">Path:</span>
                          <div className="flex items-center space-x-2">
                            <span className="text-sm text-blue-600 hover:text-blue-800 cursor-pointer">
                              {selectedSite.path}
                            </span>
                          </div>
                        </div>

                        <div className="space-y-1">
                          <div className="flex items-center space-x-2">
                            <span className="text-sm text-gray-500">
                              Linked Path:
                            </span>
                            <LinkIcon className="h-4 w-4 text-gray-400" />
                          </div>
                          <div className="flex items-center space-x-2">
                            <span className="text-sm text-blue-600 hover:text-blue-800 cursor-pointer">
                              {selectedSite.linkedPath}
                            </span>
                          </div>
                        </div>

                        <div className="space-y-1">
                          <span className="text-sm text-gray-500">URL:</span>
                          <div className="flex items-center space-x-2">
                            <a
                              href={selectedSite.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-sm text-blue-600 hover:text-blue-800"
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
              <Tab.Panel className="p-6">
                <div className="text-center text-gray-500">
                  Information tab content goes here
                </div>
              </Tab.Panel>

              {/* Connect to Forge Tab */}
              <Tab.Panel className="p-6">
                <div className="text-center text-gray-500">
                  Connect to Forge tab content goes here
                </div>
              </Tab.Panel>
            </Tab.Panels>
          </Tab.Group>
        </div>
      </div>
    </div>
  );
}
