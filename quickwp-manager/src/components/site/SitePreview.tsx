import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  ArrowLeftIcon,
  ArrowPathIcon,
  ArrowRightIcon,
  ArrowTopRightOnSquareIcon,
  ChevronDownIcon,
  CircleStackIcon,
  EllipsisVerticalIcon,
  PlayIcon,
} from "@heroicons/react/24/outline";
import clsx from "clsx";
import { menuAnchor, openOverlayMenu, prepareOverlay } from "../../lib/overlay";
import { usePreferredApps } from "../../lib/usePreferredApps";
import {
  api,
  errorText,
  hasBackend,
  type PreviewAction,
  type PreviewFrame,
  type PreviewView,
  type Site,
  type SiteDatabaseInfo,
} from "../../lib/api";
import { useSites } from "../../lib/sites";
import { peekCache, putCache } from "../../lib/useAsync";
import SiteAvatar from "../SiteAvatar";

// In full preview the toolbar runs under the window's traffic lights, which
// sit over the page on macOS (tauri.conf.json: titleBarStyle "Overlay").
const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.userAgent);

export type PreviewMode = "fit" | "mobile" | "tablet" | "desktop" | "both";

export const PREVIEW_MODES: { id: PreviewMode; label: string }[] = [
  { id: "fit", label: "Fit pane" },
  { id: "mobile", label: "Mobile · 390×844" },
  { id: "tablet", label: "Tablet · 768×1024" },
  { id: "desktop", label: "Desktop · 1440×900" },
  { id: "both", label: "Desktop + Mobile" },
];

const DEVICES = {
  mobile: { width: 390, height: 844, name: "Mobile" },
  tablet: { width: 768, height: 1024, name: "Tablet" },
  desktop: { width: 1440, height: 900, name: "Desktop" },
} as const;

/** Space around a device, and above it for its caption. */
const PAD = 20;
const CAPTION = 26;
const GAP = 24;

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A frame relative to the pane, with the caption drawn above it. */
type Placed = PreviewFrame & { caption: string | null };

/**
 * Where each webview goes inside a pane of `box`'s size. A device is shown at
 * its real CSS size, shrunk to fit and never enlarged: the webview is the
 * shrunk size and zoomed out to match, so the page lays out at 390 or 1440
 * wide exactly as that screen would.
 */
function place(mode: PreviewMode, box: Box): Placed[] {
  const { width: W, height: H } = box;
  if (mode === "fit") {
    return [{ slot: "main", x: 0, y: 0, width: W, height: H, zoom: 1, caption: null }];
  }
  const availH = H - CAPTION - PAD;
  const round = (f: Placed): Placed => ({
    ...f,
    x: Math.round(f.x),
    y: Math.round(f.y),
    width: Math.max(1, Math.round(f.width)),
    height: Math.max(1, Math.round(f.height)),
  });

  if (mode === "both") {
    const d = DEVICES.desktop;
    const m = DEVICES.mobile;
    const s = Math.min((W - 2 * PAD - GAP) / (d.width + m.width), availH / d.height, 1);
    const total = (d.width + m.width) * s + GAP;
    const x = (W - total) / 2;
    const y = CAPTION + (availH - d.height * s) / 2;
    const pct = `${Math.round(s * 100)}%`;
    return [
      { slot: "main", x, y, width: d.width * s, height: d.height * s, zoom: s, caption: `${d.name} · ${pct}` },
      {
        slot: "mobile",
        x: x + d.width * s + GAP,
        y,
        width: m.width * s,
        height: m.height * s,
        zoom: s,
        caption: `${m.name} · ${pct}`,
      },
    ].map(round);
  }

  const dev = DEVICES[mode];
  const s = Math.min((W - 2 * PAD) / dev.width, availH / dev.height, 1);
  const w = dev.width * s;
  const h = dev.height * s;
  return [
    round({
      slot: "main",
      x: (W - w) / 2,
      y: CAPTION + (availH - h) / 2,
      width: w,
      height: h,
      zoom: s,
      caption: `${dev.width}×${dev.height} · ${Math.round(s * 100)}%`,
    }),
  ];
}

interface Layout {
  domain: string | null;
  view: PreviewView | null;
  frames: PreviewFrame[];
  url: string | null;
}

// Layouts go to the backend one at a time, and only the newest waiting one is
// sent: calls running side by side could land out of order and leave the page
// where the pane used to be. Module-wide, because there is one preview.
let inFlight = false;
let waiting: Layout | null = null;
let lastSent = "";
let onLayoutError: ((e: string | null) => void) | null = null;

const HIDDEN: Layout = { domain: null, view: null, frames: [], url: null };

function sendLayout(next: Layout) {
  if (!hasBackend) return;
  waiting = next.frames.length ? next : HIDDEN;
  flush();
}

function flush() {
  if (inFlight || !waiting) return;
  const next = waiting;
  waiting = null;
  const key = JSON.stringify(next);
  if (key === lastSent) return;
  inFlight = true;
  api
    .previewLayout(next.domain, next.view, next.frames, next.url)
    .then(() => {
      lastSent = key;
      onLayoutError?.(null);
    })
    .catch((e) => {
      lastSent = "";
      onLayoutError?.(errorText(e));
    })
    .finally(() => {
      inFlight = false;
      flush();
    });
}

/** Views that have finished loading a page, this session, as "domain view". */
const loaded = new Set<string>();
const loadedKey = (domain: string, view: PreviewView) => `${domain} ${view}`;

/** The view each site was left on, so going back to a site goes back to it. */
const viewOf = new Map<string, PreviewView>();

/** Sites whose WordPress view has been sent a login link since it last got in. */
const loggingIn = new Set<string>();

/** A page that has not arrived after this long is not coming. */
const SLOW_MS = 20000;

const isLoginForm = (url: string) => {
  try {
    return new URL(url).pathname.startsWith("/wp-login.php");
  } catch {
    return false;
  }
};

// Adminer's address, already logged in. Shared with the Database tab, which
// fills the same cache as it loads: the preview can open Adminer without
// asking again, while a fresh answer -- which also starts MySQL if it is not
// running -- comes in behind it.
const databaseCacheKey = (domain: string) => `site-db:${domain}`;
const cachedDatabaseUrl = (domain: string) =>
  peekCache<SiteDatabaseInfo>(databaseCacheKey(domain))?.url ?? null;
async function freshDatabaseUrl(domain: string) {
  const info = await api.siteDatabase(domain);
  putCache(databaseCacheKey(domain), info);
  if (!info.url) throw new Error(info.error ?? "The database did not open.");
  return info.url;
}

/**
 * Is anything from this window drawn over `ref`? The preview is a native view
 * above the whole page, so a dialog or a menu under it would be hidden. Any
 * dialog counts -- its backdrop dims the preview's pane too -- and a menu or
 * list counts only where it overlaps.
 */
function useCovered(ref: RefObject<HTMLElement>) {
  const [covered, setCovered] = useState(false);
  useEffect(() => {
    let raf = 0;
    const check = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const box = ref.current?.getBoundingClientRect();
        if (!box) return;
        const dialog = document.querySelector('[role="dialog"], [aria-modal="true"]') !== null;
        const overlapping =
          dialog ||
          Array.from(document.querySelectorAll<HTMLElement>('[role="menu"], [role="listbox"]')).some(
            (el) => {
              const r = el.getBoundingClientRect();
              return (
                r.width > 0 &&
                r.left < box.right &&
                r.right > box.left &&
                r.top < box.bottom &&
                r.bottom > box.top
              );
            },
          );
        setCovered(overlapping);
      });
    };
    check();
    const observer = new MutationObserver(check);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [ref]);
  return covered;
}

/**
 * The site itself, live, beside its details.
 *
 * The page is a webview of its own laid over the pane below the toolbar -- a
 * real browser page with its own cookies, so WordPress shows its admin bar and
 * wp-admin works in it. The site, WordPress admin and the database are each a
 * webview kept loaded, so the switcher shows a page that is already there.
 * This component measures the pane, draws what sits around the page (the
 * toolbar, device outlines, captions), and tells the backend where it goes.
 */
export default function SitePreview({
  site,
  visible,
  mode,
  onModeChange,
  fullPreview,
  onFullPreviewChange,
}: {
  site: Site;
  /** False while the pane is closed or being resized. */
  visible: boolean;
  mode: PreviewMode;
  onModeChange: (m: PreviewMode) => void;
  fullPreview: boolean;
  /** Full preview: the whole window, without the sidebar or the details. */
  onFullPreviewChange: (full: boolean) => void;
}) {
  const { reload: reloadSites } = useSites();
  const paneRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<Box | null>(null);
  const [view, setView] = useState<PreviewView>(() => viewOf.get(site.domain) ?? "site");
  const [dbUrl, setDbUrl] = useState<string | null>(() => cachedDatabaseUrl(site.domain));
  const [pages, setPages] = useState<Partial<Record<PreviewView, { url: string; loading: boolean }>>>({});
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [slow, setSlow] = useState(false);
  /** Asking for Adminer's address the first time, with nothing cached. */
  const [dbBusy, setDbBusy] = useState(false);
  /** The menu open from the toolbar, drawn in the overlay. */
  const [menuOpen, setMenuOpen] = useState<"open" | "options" | null>(null);
  const preferred = usePreferredApps();
  const covered = useCovered(paneRef);
  const label = site.name || site.domain;

  // Loaded now, so the first menu opens without waiting for it.
  useEffect(() => prepareOverlay(), []);
  const isWordPress = site.kind === "wordpress";

  // A view the site does not have falls back to the site itself.
  const current: PreviewView =
    (view === "admin" && !isWordPress) || (view === "database" && !(site.db_name && dbUrl))
      ? "site"
      : view;

  useEffect(() => {
    onLayoutError = setError;
    return () => {
      onLayoutError = null;
    };
  }, []);

  // Measured every frame the pane changes size -- the sidebar and the details
  // pane both animate or drag it -- and when the window does.
  useLayoutEffect(() => {
    const el = paneRef.current;
    if (!el) return;
    let raf = 0;
    const measure = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const r = el.getBoundingClientRect();
        const next = { left: r.left, top: r.top, width: r.width, height: r.height };
        setBox((prev) =>
          prev &&
          prev.left === next.left &&
          prev.top === next.top &&
          prev.width === next.width &&
          prev.height === next.height
            ? prev
            : next,
        );
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
      cancelAnimationFrame(raf);
    };
  }, []);

  const placed = useMemo(
    () => (box && box.width > 0 && box.height > 0 ? place(mode, box) : []),
    [mode, box],
  );
  const showing = hasBackend && visible && site.enabled && !covered && placed.length > 0;
  const toWindow = (f: Placed): PreviewFrame => ({
    slot: f.slot,
    x: f.x + (box?.left ?? 0),
    y: f.y + (box?.top ?? 0),
    width: f.width,
    height: f.height,
    zoom: f.zoom,
  });

  useEffect(() => {
    if (!box) return;
    sendLayout(
      showing
        ? {
            domain: site.domain,
            view: current,
            frames: placed.map(toWindow),
            url: current === "database" ? dbUrl : null,
          }
        : HIDDEN,
    );
  }, [site.domain, current, dbUrl, showing, placed, box]);

  // Gone from the screen -- no site, the app settings sheet -- hides it.
  useEffect(() => () => sendLayout(HIDDEN), []);

  // Another site: back to the view it was left on, with nothing reported yet.
  useEffect(() => {
    setView(viewOf.get(site.domain) ?? "site");
    setDbUrl(cachedDatabaseUrl(site.domain));
    setPages({});
    setError(null);
    setSlow(false);
  }, [site.domain]);

  useEffect(() => {
    const off = api.onPreviewPage((p) => {
      if (p.slot !== "main") return;
      if (!p.loading) loaded.add(loadedKey(p.domain, p.view));
      if (p.domain === site.domain) {
        setPages((prev) => ({ ...prev, [p.view]: { url: p.url, loading: p.loading } }));
      }
      // The WordPress view opens on wp-admin with the login the site view
      // made. With none -- expired, or the site view could not make one -- it
      // lands on the login form: log it in, once, until it is in again.
      if (p.view !== "admin" || p.loading) return;
      if (!isLoginForm(p.url)) {
        loggingIn.delete(p.domain);
      } else if (!loggingIn.has(p.domain)) {
        loggingIn.add(p.domain);
        void api.previewGo(p.domain, "admin", "login").catch((e) => setError(errorText(e)));
      }
    });
    return () => void off.then((f) => f());
  }, [site.domain]);

  // Until a view's first page paints, the preview is see-through and what is
  // drawn under it shows: "Loading", and if nothing comes, why.
  const settled = (v: PreviewView) =>
    loaded.has(loadedKey(site.domain, v)) || (pages[v] != null && !pages[v]!.loading);
  const hasLoaded = settled(current);
  const siteLoaded = settled("site");

  useEffect(() => {
    if (!showing || hasLoaded) {
      setSlow(false);
      return;
    }
    const timer = setTimeout(() => setSlow(true), SLOW_MS);
    return () => clearTimeout(timer);
  }, [showing, hasLoaded, site.domain, current]);

  // Once the site's first page is in -- and its login with it -- load
  // WordPress admin and the database behind it, so switching to either is
  // showing a page rather than loading one. After the site, not beside it:
  // wp-admin needs that login, and the first page should not wait on three.
  useEffect(() => {
    if (!showing || !siteLoaded || !box) return;
    const main = placed.find((f) => f.slot === "main");
    if (!main) return;
    const frame = toWindow(main);
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        if (isWordPress && current !== "admin") {
          await api.previewPreload(site.domain, "admin", frame);
        }
        if (site.db_name && !cancelled) {
          const url = cachedDatabaseUrl(site.domain) ?? (await freshDatabaseUrl(site.domain));
          if (cancelled) return;
          setDbUrl(url);
          if (current !== "database") await api.previewPreload(site.domain, "database", frame, url);
        }
      } catch {
        // A preload that fails leaves the work to the click, which says why.
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [site.domain, showing, siteLoaded]);

  // Started again after being stopped: what the page showed is stale.
  const wasEnabled = useRef(site.enabled);
  useEffect(() => {
    if (site.enabled && !wasEnabled.current) go("reload");
    wasEnabled.current = site.enabled;
  }, [site.enabled, site.domain]);

  const go = (action: PreviewAction) => {
    setError(null);
    void api
      .previewGo(site.domain, current, action, current === "database" ? dbUrl : null)
      .catch((e) => setError(errorText(e)));
  };

  // A view already on screen goes back to where it starts; another one is
  // shown as it was left.
  const choose = (next: PreviewView) => {
    setError(null);
    if (next === current) {
      go("home");
      return;
    }
    viewOf.set(site.domain, next);
    setView(next);
  };

  const chooseDatabase = async () => {
    if (current === "database" || dbUrl) {
      choose("database");
      // Starts MySQL if it has stopped since the address was cached.
      void freshDatabaseUrl(site.domain).then(setDbUrl).catch(() => {});
      return;
    }
    setDbBusy(true);
    setError(null);
    try {
      setDbUrl(await freshDatabaseUrl(site.domain));
      viewOf.set(site.domain, "database");
      setView("database");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setDbBusy(false);
    }
  };

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      await api.siteSetEnabled(site.domain, true);
      await api.stackStart();
    } catch (e) {
      setError(errorText(e));
    } finally {
      await reloadSites();
      setStarting(false);
    }
  };

  // The toolbar's menus open in the overlay: drawn in this page they would
  // open under the preview, and a native menu hangs outside the app.
  const openOptions = async (button: Element) => {
    setMenuOpen("options");
    const choice = await openOverlayMenu({
      anchor: menuAnchor(button),
      align: "end",
      items: [
        { kind: "heading", label: "Responsive mode" },
        ...PREVIEW_MODES.map((m) => ({
          kind: "item" as const,
          id: `mode:${m.id}`,
          label: m.label,
          checked: mode === m.id,
        })),
        { kind: "separator" },
        { kind: "item", id: "full", label: fullPreview ? "Exit full preview" : "Full preview" },
      ],
    });
    setMenuOpen(null);
    if (choice?.startsWith("mode:")) onModeChange(choice.slice(5) as PreviewMode);
    else if (choice === "full") onFullPreviewChange(!fullPreview);
  };

  type OpenTarget = "browser" | "finder" | "editor" | "terminal";
  const openIn = (target: OpenTarget) => {
    setError(null);
    const job =
      target === "browser"
        ? api.siteOpenInBrowser(site.domain, null, false)
        : target === "finder"
          ? api.pathOpen(site.docroot)
          : target === "editor"
            ? api.pathOpenInEditor(site.docroot)
            : api.siteTerminal(site.domain);
    void job.catch((e) => setError(errorText(e)));
  };

  const openWith = async (button: Element) => {
    setMenuOpen("open");
    const choice = await openOverlayMenu({
      anchor: menuAnchor(button),
      align: "end",
      items: [
        { kind: "item", id: "browser", label: "Browser", icon: "browser" },
        { kind: "item", id: "finder", label: "Finder", icon: "finder" },
        // Named for the apps chosen in App settings, as Overview names them.
        { kind: "item", id: "editor", label: preferred.editor ?? "Code editor", icon: "editor" },
        { kind: "item", id: "terminal", label: preferred.terminal ?? "Terminal", icon: "terminal" },
      ],
    });
    setMenuOpen(null);
    if (choice) openIn(choice as OpenTarget);
  };

  // The site view's path, beside its name. A login link's one-time token is
  // never shown.
  const path = (() => {
    const url = pages.site?.url;
    if (!url) return "";
    try {
      const u = new URL(url);
      const p = u.searchParams.has("nexora_auth") ? u.pathname : `${u.pathname}${u.search}`;
      return p === "/" || isLoginForm(url) || u.pathname.startsWith("/wp-admin") ? "" : p;
    } catch {
      return "";
    }
  })();

  const toolButton =
    "grid h-7 w-7 flex-shrink-0 place-items-center rounded-md text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-wp-blue/30 disabled:pointer-events-none disabled:opacity-40";
  const live = hasBackend && site.enabled;
  const loadingText = {
    site: isWordPress ? `Logging in to ${label}…` : `Loading ${label}…`,
    admin: "Opening WordPress admin…",
    database: "Opening the database…",
  }[current];

  return (
    <div className="flex h-full min-w-0 flex-col bg-white">
      {/* The toolbar. Its empty space moves the window, like the header. */}
      <div
        data-tauri-drag-region
        className={clsx(
          "flex h-12 flex-shrink-0 items-center gap-1 border-b border-gray-200 pr-2",
          fullPreview && isMac ? "pl-[88px]" : "pl-2",
        )}
      >
        <button
          type="button"
          onClick={() => go("reload")}
          disabled={!live}
          aria-label="Reload"
          title="Reload"
          className={toolButton}
        >
          <ArrowPathIcon className={clsx("h-4 w-4", pages[current]?.loading && "animate-spin")} />
        </button>
        <button
          type="button"
          onClick={() => go("back")}
          disabled={!live}
          aria-label="Back"
          title="Back"
          className={toolButton}
        >
          <ArrowLeftIcon className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => go("forward")}
          disabled={!live}
          aria-label="Forward"
          title="Forward"
          className={toolButton}
        >
          <ArrowRightIcon className="h-4 w-4" />
        </button>

        <div className="mx-1 flex min-w-0 flex-1 justify-center">
          {/* What the preview shows: the site, WordPress admin, or the
              database. The one it is on carries its name. */}
          <div
            role="group"
            aria-label="Show in the preview"
            className="flex min-w-0 max-w-full items-center gap-0.5 rounded-full border border-gray-200 bg-gray-50 p-0.5"
          >
            <Segment
              selected={current === "site"}
              onClick={() => choose("site")}
              disabled={!live}
              label={`${label}: home page`}
              icon={<SiteAvatar name={label} className="h-5 w-5 rounded-full text-[9px]" />}
            >
              <span className="truncate">{label}</span>
              {path && <span className="min-w-0 truncate font-normal text-gray-400">{path}</span>}
            </Segment>
            {isWordPress && (
              <Segment
                selected={current === "admin"}
                onClick={() => choose("admin")}
                disabled={!live}
                label="WordPress admin, logged in"
                icon={<WordPressLogo className="h-4 w-4" />}
              >
                WordPress
              </Segment>
            )}
            {site.db_name && (
              <Segment
                selected={current === "database"}
                onClick={() => void chooseDatabase()}
                disabled={!live || dbBusy}
                label="Database, in Adminer"
                icon={
                  dbBusy ? (
                    <span
                      aria-hidden
                      className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-gray-200 border-t-gray-500"
                    />
                  ) : (
                    <CircleStackIcon className="h-4 w-4" />
                  )
                }
              >
                Database
              </Segment>
            )}
          </div>
        </div>

        {/* Open the site elsewhere. One button, the whole of it opening the
            list: the browser, Finder, the editor and the terminal. */}
        <button
          type="button"
          onClick={(e) => void openWith(e.currentTarget)}
          disabled={!hasBackend}
          aria-haspopup="menu"
          aria-expanded={menuOpen === "open"}
          aria-label="Open in…"
          title="Open in…"
          className={clsx(
            "flex h-7 flex-shrink-0 items-center gap-0.5 rounded-md border bg-white pl-1.5 pr-1 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-wp-blue/30 disabled:opacity-40",
            menuOpen === "open"
              ? "border-gray-300 bg-gray-50 text-gray-900"
              : "border-gray-200 text-gray-600 hover:border-gray-300 hover:bg-gray-50 hover:text-gray-900",
          )}
        >
          <ArrowTopRightOnSquareIcon className="h-4 w-4" />
          <ChevronDownIcon className="h-3 w-3 text-gray-400" strokeWidth={2.5} />
        </button>
        <button
          type="button"
          onClick={(e) => void openOptions(e.currentTarget)}
          disabled={!hasBackend}
          aria-haspopup="menu"
          aria-expanded={menuOpen === "options"}
          aria-label="Preview options"
          title="Preview options"
          className={clsx(toolButton, menuOpen === "options" && "bg-gray-100 text-gray-900")}
        >
          <EllipsisVerticalIcon className="h-4 w-4" />
        </button>
      </div>

      {/* A page load in progress, under the toolbar. */}
      <div className="relative h-0.5 flex-shrink-0 overflow-hidden">
        {live && pages[current]?.loading && (
          <div className="absolute inset-y-0 left-0 w-1/3 animate-preview-load bg-wp-blue" />
        )}
      </div>

      {/* The pane the page is laid over. What is drawn here shows around the
          page, or in its place while it cannot be shown. */}
      <div
        ref={paneRef}
        className={clsx("relative min-h-0 flex-1 overflow-hidden", mode === "fit" ? "bg-white" : "bg-gray-100")}
      >
        {placed.map((f) => (
          <div key={f.slot}>
            {f.caption && (
              <p
                className="absolute truncate text-center text-[11px] font-medium text-gray-500"
                style={{ left: f.x, top: f.y - CAPTION + 4, width: f.width }}
              >
                {f.caption}
              </p>
            )}
            {mode !== "fit" && live && (
              <div
                className="absolute rounded-[3px] bg-white shadow-lg ring-1 ring-black/10"
                style={{ left: f.x, top: f.y, width: f.width, height: f.height }}
              />
            )}
          </div>
        ))}

        {showing && !hasLoaded && (
          <div className="absolute inset-0 flex items-center justify-center p-6">
            {slow ? (
              <Note title={`${label} isn't loading`}>
                The preview has had no page from {site.domain} for a while. Reload it, or open
                the site in your browser to see what it answers.
                <span className="mt-3 flex justify-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setSlow(false);
                      go("reload");
                    }}
                    className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-[13px] font-medium text-gray-700 hover:bg-gray-50"
                  >
                    <ArrowPathIcon className="h-4 w-4" />
                    Reload
                  </button>
                </span>
              </Note>
            ) : (
              <p className="flex items-center gap-2 text-xs text-gray-500">
                <span
                  aria-hidden
                  className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-gray-200 border-t-gray-500"
                />
                {loadingText}
              </p>
            )}
          </div>
        )}

        {!showing && (
          <div className="absolute inset-0 flex items-center justify-center p-6">
            {!hasBackend ? (
              <Note title="Live preview">The site shows here in the desktop app.</Note>
            ) : !site.enabled ? (
              <Note title={`${label} is stopped`}>
                <button
                  type="button"
                  onClick={() => void start()}
                  disabled={starting}
                  className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-gray-900 px-3 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-gray-800 disabled:opacity-60"
                >
                  <PlayIcon className="h-4 w-4" />
                  {starting ? "Starting…" : "Start site"}
                </button>
              </Note>
            ) : null}
          </div>
        )}

        {error && (
          <div
            role="alert"
            className="absolute inset-x-4 bottom-4 z-10 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs leading-relaxed text-red-700 shadow-sm"
          >
            {error}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * One segment of the preview's switcher: an icon alone, or -- when the
 * preview is on it -- the icon with its name on a raised white pill.
 */
function Segment({
  selected,
  onClick,
  disabled,
  label,
  icon,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  disabled?: boolean;
  /** Its accessible name and tooltip. */
  label: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={selected}
      aria-label={label}
      title={label}
      className={clsx(
        "flex h-7 min-w-0 items-center gap-1.5 rounded-full text-[12px] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-wp-blue/30 disabled:cursor-default",
        selected
          ? "bg-white pl-1 pr-3 text-gray-900 shadow-sm ring-1 ring-black/5"
          : "w-8 flex-shrink-0 justify-center text-gray-500 hover:bg-white/70 hover:text-gray-900 disabled:opacity-50 disabled:hover:bg-transparent",
      )}
    >
      <span className="grid h-5 w-5 flex-shrink-0 place-items-center">{icon}</span>
      {selected && <span className="flex min-w-0 items-center gap-1">{children}</span>}
    </button>
  );
}

function Note({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="max-w-xs text-center">
      <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
      <div className="mt-1 text-xs leading-relaxed text-gray-500">{children}</div>
    </div>
  );
}

/** The official WordPress mark (from simple-icons 16.31.0), in the text colour. */
function WordPressLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className} fill="currentColor">
      <path d="M21.469 6.825c.84 1.537 1.318 3.3 1.318 5.175 0 3.979-2.156 7.456-5.363 9.325l3.295-9.527c.615-1.54.82-2.771.82-3.864 0-.405-.026-.78-.07-1.11m-7.981.105c.647-.03 1.232-.105 1.232-.105.582-.075.514-.93-.067-.899 0 0-1.755.135-2.88.135-1.064 0-2.85-.15-2.85-.15-.585-.03-.661.855-.075.885 0 0 .54.061 1.125.09l1.68 4.605-2.37 7.08L5.354 6.9c.649-.03 1.234-.1 1.234-.1.585-.075.516-.93-.065-.896 0 0-1.746.138-2.874.138-.2 0-.438-.008-.69-.015C4.911 3.15 8.235 1.215 12 1.215c2.809 0 5.365 1.072 7.286 2.833-.046-.003-.091-.009-.141-.009-1.06 0-1.812.923-1.812 1.914 0 .89.513 1.643 1.06 2.531.411.72.89 1.643.89 2.977 0 .915-.354 1.994-.821 3.479l-1.075 3.585-3.9-11.61.001.014zM12 22.784c-1.059 0-2.081-.153-3.048-.437l3.237-9.406 3.315 9.087c.024.053.05.101.078.149-1.12.393-2.325.609-3.582.609M1.211 12c0-1.564.336-3.05.935-4.39L7.29 21.709C3.694 19.96 1.212 16.271 1.211 12M12 0C5.385 0 0 5.385 0 12s5.385 12 12 12 12-5.385 12-12S18.615 0 12 0" />
    </svg>
  );
}
