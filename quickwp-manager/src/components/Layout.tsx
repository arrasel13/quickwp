import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { FolderOpenIcon, PlayIcon, PlusIcon, StopIcon, TrashIcon } from "@heroicons/react/24/outline";
import { PlayIcon as PlaySolidIcon, StopIcon as StopSolidIcon } from "@heroicons/react/24/solid";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import clsx from "clsx";
import { api, errorText, hasBackend, type Site } from "../lib/api";
import { setLanguage, useT } from "../lib/i18n";
import { SitesProvider, useSites } from "../lib/sites";
import AppSettings from "./AppSettings";
import QuitDialog from "./QuitDialog";
import UpdateOverlay from "./UpdateOverlay";
import SiteAvatar from "./SiteAvatar";
import ConfirmDialog from "./ui/ConfirmDialog";
import markUrl from "../assets/nexora-mark.svg";
import SitesTab from "./tabs/SitesTab";

// The window has no title bar on macOS (tauri.conf.json: titleBarStyle
// "Overlay"), so the traffic lights sit on top of the sidebar and the strip
// they sit in has to be tall enough to clear them. Elsewhere the native frame
// is still there and the strip only needs to hold the "+".
const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.userAgent);

const COLLAPSED_KEY = "nexora.sidebar-collapsed";

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

// The sidebar lists your sites -- the thing you open Nexora for. Everything
// else lives in App settings: General (the stack and HTTPS), PHP, Node,
// Services, Expose, Import from Herd and About. Mail, Logs and a terminal are
// tabs of each site.
export default function Layout({ openNewSite = false }: { openNewSite?: boolean }) {
  return (
    <SitesProvider>
      <Shell openNewSite={openNewSite} />
    </SitesProvider>
  );
}

function Shell({ openNewSite }: { openNewSite: boolean }) {
  const t = useT();
  const { requestNewSite } = useSites();
  // Arriving from setup's "Start Build": open the New site dialog at once.
  // Once only -- the ref survives StrictMode's second effect run.
  const openedNewSite = useRef(false);
  useEffect(() => {
    if (openNewSite && !openedNewSite.current) {
      openedNewSite.current = true;
      requestNewSite();
    }
  }, [openNewSite]);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    if (!hasBackend) return;
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
    <div data-tauri-drag-region className="h-screen bg-chrome overflow-hidden">
      {/* The frame around the content sheet moves the window too. */}
      <div data-tauri-drag-region className="flex h-full">
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
                <img src={markUrl} alt="" aria-hidden className="h-4 w-4 flex-shrink-0" draggable={false} />
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
      <UpdateOverlay />
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
  const { sites, selected, select, loading, error, reload, setSites } = useSites();
  // The site a right-click opened the menu for, and where it was clicked.
  const [menu, setMenu] = useState<{ site: Site; x: number; y: number } | null>(null);
  const [toDelete, setToDelete] = useState<Site | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // The site being started or stopped.
  const [toggling, setToggling] = useState<number | null>(null);

  useEffect(() => {
    if (!actionError) return;
    const timer = setTimeout(() => setActionError(null), 6000);
    return () => clearTimeout(timer);
  }, [actionError]);

  const toggle = async (site: Site) => {
    if (toggling !== null) return;
    setActionError(null);
    setToggling(site.id);
    // Shown as done at once -- the dot changes colour in place -- and put
    // right by the reload below if the backend could not do it.
    setSites((list) =>
      list ? list.map((s) => (s.id === site.id ? { ...s, enabled: !site.enabled } : s)) : list,
    );
    try {
      await api.siteSetEnabled(site.domain, !site.enabled);
      // A started site should load straight away, not wait for the stack.
      if (!site.enabled) await api.stackStart();
    } catch (e) {
      setActionError(errorText(e));
    } finally {
      await reload();
      setToggling(null);
    }
  };

  const openFolder = (site: Site) => {
    setActionError(null);
    void api.pathOpen(site.docroot).catch((e) => setActionError(errorText(e)));
  };

  const confirmDelete = async () => {
    if (!toDelete) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.siteDelete(toDelete.domain);
      setToDelete(null);
      await reload();
    } catch (e) {
      setDeleteError(errorText(e));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
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
          const pending = toggling === s.id;
          return (
            // A row holds two buttons side by side -- the site, and its status
            // control -- because a button cannot contain another.
            <div
              key={s.id}
              onContextMenu={(e) => {
                e.preventDefault();
                // The context-menu key and Shift+F10 report no pointer
                // position; open beside the row instead.
                const row = e.currentTarget.getBoundingClientRect();
                const fromKeyboard = e.clientX === 0 && e.clientY === 0;
                setMenu({
                  site: s,
                  x: fromKeyboard ? row.left + 12 : e.clientX,
                  y: fromKeyboard ? row.bottom : e.clientY,
                });
              }}
              className={clsx(
                "group relative flex w-full items-center rounded-md transition-colors",
                active || menu?.site.id === s.id ? "bg-white/10" : "hover:bg-white/5",
              )}
            >
              <button
                onClick={() => select(String(s.id))}
                aria-haspopup="menu"
                aria-current={active ? "page" : undefined}
                title={collapsed ? `${label} — ${s.domain}` : s.domain}
                className={clsx(
                  "flex w-full min-w-0 items-center rounded-md text-left text-[13px] font-medium transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-white/30",
                  collapsed ? "justify-center p-1.5" : "gap-2 py-2 pl-3 pr-9",
                  active || menu?.site.id === s.id
                    ? "text-white"
                    : "text-gray-300 group-hover:text-white",
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
                  <span className="min-w-0 flex-1 truncate">{label}</span>
                )}
              </button>

              {/* The status dot is also the switch: pointing at the row turns
                  it into play or stop, and a click starts or stops the site
                  without opening it. The dot and both icons are always there,
                  stacked, and only fade -- nothing is swapped in or out, so a
                  click never makes the row blink. While the change is under
                  way the dot, already in its new colour, pulses. */}
              {!collapsed && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    // A mouse click lets go of focus, or the icon would stay
                    // up after the pointer leaves; the keyboard keeps it.
                    if (e.detail > 0) e.currentTarget.blur();
                    void toggle(s);
                  }}
                  aria-busy={pending || undefined}
                  aria-label={`${s.enabled ? t("site.stop") : t("site.start")}: ${label}`}
                  title={`Site status: ${s.enabled ? "Running" : "Stopped"}`}
                  className="absolute right-1.5 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded text-gray-300 transition-colors duration-200 hover:bg-white/10 hover:text-white focus:outline-none focus-visible:ring-1 focus-visible:ring-white/30"
                >
                  <span
                    aria-hidden
                    data-status-dot
                    className={clsx(
                      "col-start-1 row-start-1 h-2 w-2 rounded-full transition-[background-color,opacity,transform] duration-200",
                      s.enabled ? "bg-green-500" : "bg-gray-600",
                      pending
                        ? "animate-pulse"
                        : "group-hover:scale-50 group-hover:opacity-0 group-focus-within:scale-50 group-focus-within:opacity-0",
                    )}
                  />
                  <StopSolidIcon
                    aria-hidden
                    data-status-icon="stop"
                    className={clsx(
                      "col-start-1 row-start-1 h-3.5 w-3.5 opacity-0 transition-opacity duration-200",
                      s.enabled && !pending && "group-hover:opacity-100 group-focus-within:opacity-100",
                    )}
                  />
                  <PlaySolidIcon
                    aria-hidden
                    data-status-icon="play"
                    className={clsx(
                      "col-start-1 row-start-1 h-3.5 w-3.5 opacity-0 transition-opacity duration-200",
                      !s.enabled && !pending && "group-hover:opacity-100 group-focus-within:opacity-100",
                    )}
                  />
                </button>
              )}
            </div>
          );
        })}
        {actionError && (
          <p role="alert" className="mt-2 break-words rounded-md bg-red-500/10 px-3 py-2 text-xs leading-relaxed text-red-300">
            {actionError}
          </p>
        )}
      </nav>

      {menu && (
        <SiteMenu
          site={menu.site}
          x={menu.x}
          y={menu.y}
          labels={{
            start: t("site.start"),
            stop: t("site.stop"),
            open: t("site.openFolder"),
            remove: t("site.delete"),
          }}
          onClose={() => setMenu(null)}
          onToggle={() => void toggle(menu.site)}
          onOpenFolder={() => openFolder(menu.site)}
          onDelete={() => {
            setDeleteError(null);
            setToDelete(menu.site);
          }}
        />
      )}

      <ConfirmDialog
        open={toDelete !== null}
        title={toDelete ? `Delete ${toDelete.domain}?` : ""}
        busy={deleting}
        confirmLabel="Delete site"
        body={
          toDelete && (
            <span>
              {toDelete.is_linked ? (
                <>
                  This removes the site from Nexora. Its folder at{" "}
                  <code className="font-mono text-[11px]">{toDelete.docroot}</code> is linked, so
                  it stays where it is
                </>
              ) : (
                <>
                  This removes the site, its folder at{" "}
                  <code className="font-mono text-[11px]">{toDelete.docroot}</code>
                </>
              )}
              {toDelete.db_name ? (
                <>
                  , its database <code className="font-mono text-[11px]">{toDelete.db_name}</code>
                </>
              ) : null}{" "}
              and its certificate. It cannot be undone — export it first from WordPress › Tools if
              you might want it back.
              {deleteError && <span className="mt-2 block text-red-700">{deleteError}</span>}
            </span>
          )
        }
        onCancel={() => setToDelete(null)}
        onConfirm={() => void confirmDelete()}
      />
    </>
  );
}

/** The right-click menu for one site in the sidebar. */
function SiteMenu({
  site,
  x,
  y,
  labels,
  onClose,
  onToggle,
  onOpenFolder,
  onDelete,
}: {
  site: Site;
  x: number;
  y: number;
  labels: { start: string; stop: string; open: string; remove: string };
  onClose: () => void;
  onToggle: () => void;
  onOpenFolder: () => void;
  onDelete: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // Kept inside the window: opened near an edge, it moves back in. Measured
  // before paint, so it never flashes at the wrong place.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({
      left: Math.max(8, Math.min(x, window.innerWidth - width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - height - 8)),
    });
    el.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
  }, [x, y]);

  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", away);
    window.addEventListener("keydown", escape);
    window.addEventListener("resize", onClose);
    window.addEventListener("blur", onClose);
    document.addEventListener("scroll", onClose, true);
    return () => {
      window.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", escape);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("blur", onClose);
      document.removeEventListener("scroll", onClose, true);
    };
  }, [onClose]);

  const moveFocus = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === "ArrowDown" ? at + 1 : at - 1 + items.length;
    items[next % items.length]?.focus();
  };

  const item = (
    label: string,
    Icon: React.ComponentType<{ className?: string }>,
    action: () => void,
    danger = false,
  ) => (
    <button
      type="button"
      role="menuitem"
      onClick={() => {
        onClose();
        action();
      }}
      className={clsx(
        "flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[13px] focus:outline-none",
        danger
          ? "text-red-600 hover:bg-red-50 focus:bg-red-50"
          : "text-gray-800 hover:bg-gray-100 focus:bg-gray-100",
      )}
    >
      <Icon className={clsx("h-4 w-4 flex-shrink-0", danger ? "text-red-500" : "text-gray-500")} />
      {label}
    </button>
  );

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={site.name || site.domain}
      onKeyDown={moveFocus}
      onContextMenu={(e) => e.preventDefault()}
      style={{ left: pos.left, top: pos.top }}
      className="fixed z-50 min-w-[190px] rounded-lg bg-white p-1 shadow-xl ring-1 ring-black/10"
    >
      {site.enabled
        ? item(labels.stop, StopIcon, onToggle)
        : item(labels.start, PlayIcon, onToggle)}
      {item(labels.open, FolderOpenIcon, onOpenFolder)}
      <div role="separator" className="my-1 h-px bg-gray-100" />
      {item(labels.remove, TrashIcon, onDelete, true)}
    </div>
  );
}
