import { useEffect, useState } from "react";
import { AdjustmentsHorizontalIcon, PlusIcon } from "@heroicons/react/24/outline";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { getVersion } from "@tauri-apps/api/app";
import clsx from "clsx";
import { api, hasBackend } from "../lib/api";
import { setLanguage, useT } from "../lib/i18n";
import { SitesProvider, useSites } from "../lib/sites";
import AppSettings from "./AppSettings";
import QuitDialog from "./QuitDialog";
import SiteAvatar from "./SiteAvatar";
import SitesTab from "./tabs/SitesTab";

// The window has no title bar on macOS (tauri.conf.json: titleBarStyle
// "Overlay"), so the traffic lights sit on top of the sidebar and the strip
// they sit in has to be tall enough to clear them. Elsewhere the native frame
// is still there and the strip only needs to hold the "+".
const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.userAgent);

const COLLAPSED_KEY = "quickwp.sidebar-collapsed";

// A preference of this window only, so it lives in the webview rather than the
// backend's settings table. Storage can be unavailable; that just means the
// sidebar opens expanded.
const readCollapsed = () => {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
};

// The sidebar lists your sites -- the thing you open QuickWP for. Everything
// else lives in App settings: General (the stack and HTTPS), PHP, Node,
// Services, Expose, Import from Herd and About. Mail, Logs and a terminal are
// tabs of each site.
export default function Layout() {
  return (
    <SitesProvider>
      <Shell />
    </SitesProvider>
  );
}

function Shell() {
  const t = useT();
  const [version, setVersion] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    if (!hasBackend) return;
    void getVersion().then(setVersion).catch(() => {});
    // The saved language wins over the cached one the first paint used.
    void api.settingsGet().then((s) => setLanguage(s.language)).catch(() => {});
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
    } catch {
      // Not remembered across launches; nothing else depends on it.
    }
  }, [collapsed]);

  return (
    <div className="h-screen bg-chrome overflow-hidden">
      <div className="flex h-full">
        {/* Sidebar. Collapsed, each site becomes its initial rather than
            disappearing, so every site stays one click away. w-20 still
            clears the three traffic lights. */}
        <div
          className={clsx(
            "flex-shrink-0 flex flex-col text-gray-300 transition-[width] duration-150 ease-out",
            collapsed ? "w-20" : "w-60",
          )}
        >
          {/* Dragging the window by this strip stands in for the title bar
              that is no longer there. The "+" sits at its right end, clear
              of the traffic lights; a click on it is not a drag. */}
          <div
            data-tauri-drag-region
            className={clsx(
              "flex flex-shrink-0 items-center justify-end px-3",
              isMac ? "h-12" : "h-11",
            )}
          >
            {!collapsed && <NewSiteButton />}
          </div>
          {collapsed && (
            <div className="flex flex-shrink-0 justify-center px-3 pb-1">
              <NewSiteButton />
            </div>
          )}

          <SiteList collapsed={collapsed} />

          <div className="flex-shrink-0 px-3 pb-3 pt-2">
            {version && !collapsed && (
              <span className="mb-3 ml-2 inline-block rounded-full bg-wp-blue px-3 py-1 text-[11px] font-medium text-white tabular-nums">
                v{version}
              </span>
            )}
            <div
              className={clsx(
                "flex items-center",
                collapsed ? "flex-col gap-1" : "justify-between",
              )}
            >
              <button
                onClick={() => setSettingsOpen(true)}
                title={collapsed ? t("appSettings") : undefined}
                className={clsx(
                  // Closing the settings sheet hands focus back here; the
                  // browser's blue outline glares on the dark frame.
                  "flex items-center gap-2.5 rounded-md py-2 text-[13px] font-medium text-gray-300 hover:bg-white/5 hover:text-white transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-white/30",
                  collapsed ? "justify-center w-full px-0" : "px-3",
                )}
              >
                <AdjustmentsHorizontalIcon className="h-4 w-4 flex-shrink-0 text-gray-400" />
                <span className={collapsed ? "sr-only" : undefined}>{t("appSettings")}</span>
              </button>
              <button
                onClick={() => setCollapsed((c) => !c)}
                aria-label={collapsed ? t("expandSidebar") : t("collapseSidebar")}
                title={collapsed ? t("expandSidebar") : t("collapseSidebar")}
                className="rounded-md p-2 text-gray-400 hover:bg-white/5 hover:text-white transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-white/30"
              >
                {collapsed ? (
                  <PanelLeftOpen className="h-4 w-4" />
                ) : (
                  <PanelLeftClose className="h-4 w-4" />
                )}
              </button>
            </div>
          </div>
        </div>

        {/* Content: a white sheet inset from the window edge, the way the
            sidebar reads as the frame around it. */}
        <main className="flex-1 min-w-0 my-2 mr-2 rounded-lg bg-white overflow-hidden ring-1 ring-black/5">
          <SitesTab />
        </main>
      </div>

      <AppSettings
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        sidebarCollapsed={collapsed}
        onSidebarCollapsedChange={setCollapsed}
      />
      <QuitDialog />
    </div>
  );
}

function NewSiteButton() {
  const t = useT();
  const { requestNewSite } = useSites();
  return (
    <button
      onClick={requestNewSite}
      aria-label={t("addSite")}
      title={t("addSite")}
      className="rounded-md p-1.5 text-gray-400 transition-colors hover:bg-white/10 hover:text-white focus:outline-none focus-visible:ring-1 focus-visible:ring-white/30"
    >
      <PlusIcon className="h-4 w-4" />
    </button>
  );
}

function SiteList({ collapsed }: { collapsed: boolean }) {
  const t = useT();
  const { sites, selected, select, loading, error } = useSites();

  return (
    <nav
      aria-label={t("sites")}
      className="sidebar-scroll flex-1 space-y-0.5 overflow-y-auto overflow-x-hidden px-3 pb-3"
    >
      {!collapsed && error && (
        <p className="px-3 py-2 text-xs leading-relaxed text-red-300">{t("sitesError")}</p>
      )}
      {!collapsed && !error && !loading && sites.length === 0 && (
        <p className="px-3 py-2 text-xs text-gray-500">{t("noSitesYet")}</p>
      )}
      {sites.map((s) => {
        const active = selected?.id === s.id;
        const label = s.name || s.domain;
        const dot = (
          <span
            className={clsx(
              "h-2 w-2 flex-shrink-0 rounded-full",
              s.enabled ? "bg-green-500" : "bg-gray-600",
            )}
          />
        );
        return (
          <button
            key={s.id}
            onClick={() => select(String(s.id))}
            aria-current={active ? "page" : undefined}
            title={collapsed ? `${label} — ${s.domain}` : s.domain}
            className={clsx(
              "flex w-full items-center rounded-md text-left text-[13px] font-medium transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-white/30",
              collapsed ? "justify-center p-1.5" : "gap-2 px-3 py-2",
              active ? "bg-white/10 text-white" : "text-gray-300 hover:bg-white/5 hover:text-white",
            )}
          >
            {collapsed ? (
              <span className="relative">
                <SiteAvatar name={label} className="h-8 w-8 text-xs" />
                <span className="absolute -bottom-0.5 -right-0.5 rounded-full ring-2 ring-chrome">
                  {dot}
                </span>
                <span className="sr-only">{label}</span>
              </span>
            ) : (
              <>
                <span className="min-w-0 flex-1 truncate">{label}</span>
                {dot}
              </>
            )}
          </button>
        );
      })}
    </nav>
  );
}
