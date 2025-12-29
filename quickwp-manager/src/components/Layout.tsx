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
  KeyIcon,
} from "@heroicons/react/24/outline";
import clsx from "clsx";

// Import tab components
import GeneralTab from "./tabs/GeneralTab";
import SitesTab from "./tabs/SitesTab";
import PHPTab from "./tabs/PHPTab";
import NodeTab from "./tabs/NodeTab";
import AboutTab from "./tabs/AboutTab";
import PasswordGeneratorTab from "./tabs/PasswordGeneratorTab";

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
  {
    name: "Password Generator",
    icon: KeyIcon,
    component: PasswordGeneratorTab,
  },
  { name: "About", icon: HomeIcon, component: AboutTab },
];

export default function Layout() {
  return (
    // <div className="h-screen bg-gray-50 flex overflow-hidden">
    <div className="h-screen bg-gray-50 flex-1 overflow-hidden">
      {/* Fixed Sidebar */}
      <Tab.Group className="h-full w-full">
        <div className="flex h-full">
          {/* <div className="w-48 bg-white border-r border-gray-200 shadow-sm"> */}
          <div className="w-60 bg-white border-r border-gray-200 shadow-sm">
            <Tab.List className="flex flex-col h-full p-4 space-y-1 overflow-y-auto">
              {tabs.map((tab) => (
                <Tab
                  key={tab.name}
                  className={({ selected }) =>
                    clsx(
                      "flex items-center justify-between w-full rounded-lg p-2 text-xs font-medium leading-5 text-left transition-all duration-200",
                      "focus:outline-none focus-visible:outline-none focus:ring-0 focus:ring-offset-0 focus:shadow-none active:outline-none",
                      "[&:focus]:outline-none [&:focus-visible]:outline-none [&:focus]:ring-0 [&:active]:outline-none",
                      selected
                        ? "bg-gradient-to-r from-blue-100 to-indigo-100 text-black shadow-md"
                        : "text-gray-700 hover:bg-gray-100 hover:text-gray-900"
                    )
                  }
                >
                  <div className="flex items-center space-x-2">
                    <tab.icon className="h-4 w-4 flex-shrink-0" />
                    <span className="truncate">{tab.name}</span>
                  </div>
                  {tab.badge && (
                    <span className="bg-red-500 text-white text-[8px] px-1.5 py-0.25 font-medium flex-shrink-0 rounded-lg">
                      {tab.badge}
                    </span>
                  )}
                </Tab>
              ))}
            </Tab.List>
          </div>

          {/* Scrollable Main Content */}
          <Tab.Panels className="flex-1 overflow-hidden">
            {tabs.map((tab, idx) => (
              <Tab.Panel key={idx} className="h-full overflow-y-auto">
                <div className="">
                  <tab.component />
                </div>
              </Tab.Panel>
            ))}
          </Tab.Panels>
        </div>
      </Tab.Group>
    </div>
  );
}
