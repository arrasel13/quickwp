import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  FolderOpenIcon,
  PlayIcon,
  PlusIcon,
  StopIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import { PlayIcon as PlaySolidIcon, StopIcon as StopSolidIcon } from "@heroicons/react/24/solid";
import { DrawerLeftIcon } from "./ui/DrawerIcons";
import clsx from "clsx";
import { api, errorText, hasBackend, type Site } from "../lib/api";
import { setLanguage, useT } from "../lib/i18n";
import { SitesProvider, useSites } from "../lib/sites";
import AppSettings from "./AppSettings";
import QuitDialog from "./QuitDialog";
import UpdateOverlay from "./UpdateOverlay";
import ConfirmDialog from "./ui/ConfirmDialog";
import markUrl from "../assets/nexora-mark.svg";
import SitesTab from "./tabs/SitesTab";
import { startAppData } from "../lib/appData";

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
  const { requestNewSite, fullPreview, setFullPreview, selected } = useSites();
  // Full preview gives the site the whole window. With no site to show --
  // the last one deleted -- it ends, or the sidebar would be gone for nothing.
  const immersive = fullPreview && selected !== null;
  useEffect(() => {
    if (fullPreview && !selected) setFullPreview(false);
  }, [fullPreview, selected]);
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
    // Everything Nexora Settings and the Sites screen show, fetched ahead
    // of them, once the window has painted.
    const t = window.setTimeout(startAppData, 600);
    return () => window.clearTimeout(t);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
    } catch {
      // Not remembered across launches; nothing else depends on it.
    }
  }, [collapsed]);

  // Command-B (Control-B elsewhere) shows and hides the sidebar, the shortcut
  // the opener names. Command-comma opens the settings, as every Mac app does.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      if (e.key.toLowerCase() === "b") {
        e.preventDefault();
        setCollapsed((c) => !c);
      }
      if (e.key === ",") {
        e.preventDefault();
        setSettingsOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div data-tauri-drag-region className="h-screen bg-chrome overflow-hidden">
      {/* The frame around the content sheet moves the window too. */}
      <div data-tauri-drag-region className="flex h-full">
        {/* Sidebar: where sites are listed and picked. Hidden, it is gone
            rather than narrowed -- the window is the site's -- and the button
            at the foot of the details brings it back. */}
        <div
          className={clsx(
            "w-60 flex-shrink-0 flex flex-col text-gray-300",
            (collapsed || immersive) && "hidden",
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
            <NewSiteButton />
          </div>
          <SiteList />

          <div className="flex-shrink-0 px-3 pb-3 pt-2">
            <div className="flex items-center justify-between">
              <button
                onClick={() => setSettingsOpen(true)}
                title={`${t("appSettings")} (${isMac ? "⌘" : "Ctrl"},)`}
                // Closing the settings sheet hands focus back here; the
                // browser's blue outline glares on the dark frame.
                className="flex items-center gap-2.5 rounded-md px-3 py-2 text-[13px] font-medium text-gray-300 hover:bg-white/5 hover:text-white transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-white/30"
              >
                <img src={markUrl} alt="" aria-hidden className="h-4 w-4 flex-shrink-0" draggable={false} />
                <span>{t("appSettings")}</span>
              </button>
              <button
                onClick={() => setCollapsed(true)}
                aria-label={t("hideSidebar")}
                title={t("hideSidebar")}
                className="rounded-md p-1.5 text-gray-400 hover:bg-white/5 hover:text-white transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-white/30"
              >
                <DrawerLeftIcon className="h-5 w-5" />
              </button>
            </div>
          </div>
        </div>

        {/* Content: a white sheet inset from the window edge, the way the
            sidebar reads as the frame around it. */}
        <main
          className={clsx(
            "flex-1 min-w-0 bg-white overflow-hidden",
            // In full preview the sheet is the whole window, edge to edge.
            immersive ? "m-0" : "my-2 mr-2 rounded-lg ring-1 ring-black/5",
            !immersive && collapsed && "ml-2",
          )}
        >
          <SitesTab sidebarHidden={collapsed && !immersive} />
        </main>
      </div>

      {/* The way back to the sidebar, and to the other sites, without giving
          the window back to it. */}
      {collapsed && !immersive && <SidebarOpener onOpen={() => setCollapsed(false)} />}

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

function SiteList() {
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
        {error && (
          <p className="px-3 py-2 text-xs leading-relaxed text-red-300">{t("sitesError")}</p>
        )}
        {!error && !loading && sites.length === 0 && (
          <p className="px-3 py-2 text-xs text-gray-500">{t("noSitesYet")}</p>
        )}
        {sites.map((s) => {
          const active = selected?.id === s.id;
          const label = s.name || s.domain;
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
                title={s.domain}
                className={clsx(
                  "flex w-full min-w-0 items-center gap-2 rounded-md py-2 pl-3 pr-9 text-left text-[13px] font-medium transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-white/30",
                  active || menu?.site.id === s.id
                    ? "text-white"
                    : "text-gray-300 group-hover:text-white",
                )}
              >
                <span className="min-w-0 flex-1 truncate">{label}</span>
              </button>

              {/* The status dot is also the switch: pointing at the row turns
                  it into play or stop, and a click starts or stops the site
                  without opening it. The dot and both icons are always there,
                  stacked, and only fade -- nothing is swapped in or out, so a
                  click never makes the row blink. While the change is under
                  way the dot, already in its new colour, pulses. */}
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

/**
 * The button at the foot of the window with the sidebar hidden.
 *
 * Pointing at it brings the sites back without the sidebar: the list, with the
 * one in view marked, and the way to put the sidebar back for good. It sits
 * over the details pane, never over the preview, which is a native view that
 * anything drawn in the page would open behind.
 */
function SidebarOpener({ onOpen }: { onOpen: () => void }) {
  const t = useT();
  const { sites, selected, select, reload } = useSites();
  const [open, setOpen] = useState(false);
  /** The site being started or stopped from here. */
  const [busy, setBusy] = useState<number | null>(null);

  const toggle = async (site: Site) => {
    setBusy(site.id);
    try {
      await api.siteSetEnabled(site.domain, !site.enabled);
      // A started site should answer straight away, not wait for the stack.
      if (!site.enabled) await api.stackStart();
    } catch {
      // The list reloads either way; the sidebar reports what went wrong.
    } finally {
      await reload();
      setBusy(null);
    }
  };
  // A moment's grace, so the pointer can cross the gap to the list.
  const closing = useRef<number>();
  const show = () => {
    window.clearTimeout(closing.current);
    setOpen(true);
  };
  const hide = () => {
    window.clearTimeout(closing.current);
    closing.current = window.setTimeout(() => setOpen(false), 120);
  };
  useEffect(() => () => window.clearTimeout(closing.current), []);

  return (
    <div
      className="fixed bottom-3 left-3 z-40"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {open && (
        <div
          role="menu"
          aria-label={t("sites")}
          className="absolute bottom-full left-0 mb-1.5 w-64 rounded-lg border border-gray-200 bg-white p-1 shadow-xl shadow-black/10"
        >
          {sites.map((s) => {
            const active = selected?.id === s.id;
            const label = s.name || s.domain;
            // A row holds two buttons -- the site, and its switch -- because a
            // button cannot contain another.
            return (
              <div
                key={s.id}
                className={clsx(
                  "group flex items-center rounded-md transition-colors",
                  active ? "bg-gray-100" : "hover:bg-gray-100",
                )}
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    select(String(s.id));
                    setOpen(false);
                  }}
                  className={clsx(
                    "min-w-0 flex-1 truncate rounded-md px-2.5 py-1.5 text-left text-[13px] focus:outline-none",
                    active ? "font-semibold text-gray-900" : "text-gray-700 group-hover:text-gray-900",
                  )}
                >
                  {label}
                </button>
                {/* Stop shows a running site, play a stopped one: the switch
                    is the status as well. */}
                <button
                  type="button"
                  onClick={() => void toggle(s)}
                  disabled={busy === s.id}
                  aria-label={`${s.enabled ? t("site.stop") : t("site.start")}: ${label}`}
                  title={s.enabled ? t("site.stop") : t("site.start")}
                  className="mr-1 grid h-7 w-7 flex-shrink-0 place-items-center rounded-md text-gray-400 transition-colors hover:bg-gray-200/70 hover:text-gray-900 focus:outline-none focus-visible:bg-gray-200/70 disabled:opacity-50"
                >
                  {busy === s.id ? (
                    <span
                      aria-hidden
                      className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-gray-300 border-t-gray-600"
                    />
                  ) : s.enabled ? (
                    <StopSolidIcon aria-hidden className="h-3.5 w-3.5" />
                  ) : (
                    <PlaySolidIcon aria-hidden className="h-3.5 w-3.5" />
                  )}
                </button>
              </div>
            );
          })}
          {sites.length > 0 && <div role="separator" className="my-1 h-px bg-gray-200" />}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onOpen();
            }}
            className="flex w-full items-center justify-between gap-3 rounded-md px-2.5 py-1.5 text-left text-[13px] text-gray-800 transition-colors hover:bg-gray-100 hover:text-gray-900 focus:outline-none focus-visible:bg-gray-100"
          >
            {t("openSidebar")}
            <span aria-hidden className="flex items-center gap-1">
              <kbd className="rounded border border-gray-200 bg-gray-50 px-1.5 py-0.5 text-[11px] font-medium text-gray-500">
                {isMac ? "\u2318" : "Ctrl"}
              </kbd>
              <kbd className="rounded border border-gray-200 bg-gray-50 px-1.5 py-0.5 text-[11px] font-medium text-gray-500">
                B
              </kbd>
            </span>
          </button>
        </div>
      )}

      <button
        type="button"
        onClick={onOpen}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("openSidebar")}
        title={t("openSidebar")}
        className="grid h-8 w-8 place-items-center rounded-md text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-wp-blue/30"
      >
        <DrawerLeftIcon className="h-5 w-5" />
      </button>
    </div>
  );
}
