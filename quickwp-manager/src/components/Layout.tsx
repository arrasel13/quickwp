import { Tab } from "@headlessui/react";
import {
  HomeIcon,
  GlobeAltIcon,
  CodeBracketIcon,
  CubeIcon,
  RocketLaunchIcon,
  EnvelopeIcon,
  CircleStackIcon,
  BugAntIcon,
  StarIcon,
  CommandLineIcon,
  Square3Stack3DIcon,
} from "@heroicons/react/24/outline";
import clsx from "clsx";

// Import tab components
import GeneralTab from "./tabs/GeneralTab";
import SitesTab from "./tabs/SitesTab";
import PHPTab from "./tabs/PHPTab";
import NodeTab from "./tabs/NodeTab";

const tabs = [
  { name: "General", icon: HomeIcon, component: GeneralTab },
  { name: "Sites", icon: GlobeAltIcon, component: SitesTab },
  { name: "PHP", icon: CodeBracketIcon, component: PHPTab },
  { name: "Node", icon: CubeIcon, component: NodeTab },
  {
    name: "Expose",
    icon: RocketLaunchIcon,
    component: GeneralTab,
    badge: "Pro",
  },
  {
    name: "Services",
    icon: CircleStackIcon,
    component: GeneralTab,
    badge: "Pro",
  },
  { name: "Mail", icon: EnvelopeIcon, component: GeneralTab, badge: "Pro" },
  { name: "Dumps", icon: CircleStackIcon, component: GeneralTab, badge: "Pro" },
  { name: "Debugger", icon: BugAntIcon, component: GeneralTab, badge: "Pro" },
  { name: "Herd Pro", icon: StarIcon, component: GeneralTab },
  { name: "Shortcuts", icon: CommandLineIcon, component: GeneralTab },
  { name: "Integrations", icon: Square3Stack3DIcon, component: GeneralTab },
  { name: "About", icon: HomeIcon, component: GeneralTab },
];

export default function Layout() {
  return (
    <div className="min-h-screen bg-gray-100 flex">
      {/* Sidebar */}
      <Tab.Group>
        <div className="flex">
          <Tab.List className="flex flex-col w-48 bg-gray-200 min-h-screen p-2 space-y-1">
            {tabs.map((tab) => (
              <Tab
                key={tab.name}
                className={({ selected }) =>
                  clsx(
                    "flex items-center justify-between w-full rounded-lg py-2 px-3 text-sm font-medium leading-5 text-left",
                    "focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-opacity-50",
                    selected
                      ? "bg-blue-500 text-white shadow"
                      : "text-gray-700 hover:bg-gray-300"
                  )
                }
              >
                <div className="flex items-center space-x-2">
                  <tab.icon className="h-4 w-4" />
                  <span>{tab.name}</span>
                </div>
                {tab.badge && (
                  <span className="bg-red-500 text-white text-xs px-1.5 py-0.5 rounded">
                    {tab.badge}
                  </span>
                )}
              </Tab>
            ))}
          </Tab.List>

          {/* Main Content */}
          <Tab.Panels className="flex-1">
            {tabs.map((tab, idx) => (
              <Tab.Panel key={idx} className="h-full">
                <tab.component />
              </Tab.Panel>
            ))}
          </Tab.Panels>
        </div>
      </Tab.Group>
    </div>
  );
}
