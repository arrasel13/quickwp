import { useEffect, useRef, useState } from "react";
import { ChevronDownIcon, EyeSlashIcon, GlobeAltIcon } from "@heroicons/react/24/outline";
import clsx from "clsx";
import { api, BrowserChoice, errorText, hasBackend, Site } from "../../lib/api";
import { peekCache, putCache } from "../../lib/useAsync";

type Mode = "open" | "login";

/**
 * The way into a site, beside its name: a browser to open the site in, or --
 * for WordPress -- to land in wp-admin already logged in with Magic Login.
 *
 * One row per browser, with the browser's own icon. The eye at the end of a
 * row opens a private window instead, in browsers Nexora can open one in.
 */
export default function OpenSiteMenu({ site }: { site: Site }) {
  const canLogIn = site.kind === "wordpress";
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("open");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The browsers to offer, from the last visit at once, then fresh.
  const [browsers, setBrowsers] = useState<BrowserChoice[]>(
    () => peekCache<BrowserChoice[]>("browser-choices") ?? [],
  );
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!hasBackend) return;
    void api
      .browserChoices()
      .then((list) => {
        putCache("browser-choices", list);
        setBrowsers(list);
      })
      .catch(() => {});
  }, []);

  // Magic Login is WordPress's; any other site only opens.
  useEffect(() => {
    if (!canLogIn) setMode("open");
  }, [canLogIn]);

  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), 6000);
    return () => clearTimeout(timer);
  }, [error]);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", away);
    window.addEventListener("keydown", escape);
    ref.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    return () => {
      window.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", escape);
    };
  }, [open]);

  const moveFocus = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = Array.from(
      ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [],
    );
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const step = e.key === "ArrowDown" ? 1 : -1;
    items[(at + step + items.length) % items.length]?.focus();
  };

  const verb = mode === "login" ? "Magic Login" : "Open site";

  // One launch at a time: each Magic Login mints a login token, and a double
  // click would otherwise open two tabs.
  const go = async (b: BrowserChoice, privateWindow: boolean) => {
    if (busy) return;
    setOpen(false);
    setBusy(true);
    setError(null);
    try {
      if (mode === "login" && canLogIn) {
        await api.wpMagicLoginIn(site.domain, b.path, privateWindow);
      } else {
        await api.siteOpenInBrowser(site.domain, b.path, privateWindow);
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-busy={busy || undefined}
        onClick={() => setOpen((o) => !o)}
        className={clsx(
          "inline-flex h-8 items-center gap-1.5 rounded-md border bg-white pl-2.5 pr-2 text-[13px] font-medium text-gray-800 shadow-sm transition-colors hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-wp-blue/30",
          open ? "border-gray-300 bg-gray-50" : "border-gray-200",
        )}
      >
        <span className="grid h-4 w-4 place-items-center">
          {busy ? (
            <span
              aria-hidden
              className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-gray-200 border-t-gray-600"
            />
          ) : (
            <GlobeAltIcon aria-hidden className="h-4 w-4 text-gray-500" />
          )}
        </span>
        Open site
        <ChevronDownIcon
          aria-hidden
          className={clsx(
            "h-3.5 w-3.5 text-gray-400 transition-transform duration-200",
            open && "rotate-180",
          )}
        />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Open site"
          data-tauri-drag-region="false"
          onKeyDown={moveFocus}
          className="absolute right-0 top-full z-30 mt-1.5 w-64 rounded-xl border border-gray-200 bg-white p-1.5 shadow-lg shadow-black/5"
        >
          {canLogIn && (
            <div
              role="radiogroup"
              aria-label="Action"
              className="mb-1.5 grid grid-cols-2 gap-0.5 rounded-lg bg-gray-100 p-0.5"
            >
              {(["open", "login"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={mode === m}
                  onClick={() => setMode(m)}
                  className={clsx(
                    "rounded-md py-1 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-wp-blue/40",
                    mode === m ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-800",
                  )}
                >
                  {m === "open" ? "Open site" : "Magic Login"}
                </button>
              ))}
            </div>
          )}

          {browsers.length === 0 && (
            <p className="px-2 py-1.5 text-xs text-gray-500">No browsers found on this Mac.</p>
          )}

          {browsers.map((b) => (
            <div
              key={b.path}
              className="flex items-center rounded-md transition-colors hover:bg-gray-100 focus-within:bg-gray-100"
            >
              <button
                type="button"
                role="menuitem"
                aria-label={`${verb} in ${b.name}`}
                onClick={() => void go(b, false)}
                className="flex min-w-0 flex-1 items-center gap-2.5 px-2 py-1.5 text-left focus:outline-none"
              >
                {b.icon ? (
                  <img src={b.icon} alt="" draggable={false} className="h-5 w-5 flex-shrink-0" />
                ) : (
                  <GlobeAltIcon aria-hidden className="h-5 w-5 flex-shrink-0 text-gray-400" />
                )}
                <span className="truncate text-[13px] text-gray-800">{b.name}</span>
                {b.default && (
                  <span className="flex-shrink-0 text-[11px] text-gray-400">Default</span>
                )}
              </button>
              {b.private_window && (
                <button
                  type="button"
                  role="menuitem"
                  aria-label={`${verb} in ${b.name} (${b.private_window})`}
                  title={b.private_window}
                  onClick={() => void go(b, true)}
                  className="mr-1 grid h-6 w-6 flex-shrink-0 place-items-center rounded text-gray-400 transition-colors hover:bg-gray-200 hover:text-gray-800 focus:outline-none focus-visible:bg-gray-200 focus-visible:text-gray-800"
                >
                  <EyeSlashIcon aria-hidden className="h-4 w-4" />
                </button>
              )}
            </div>
          ))}

          {browsers.some((b) => b.private_window) && (
            <p className="mt-1 flex items-center gap-1.5 border-t border-gray-100 px-2 pb-0.5 pt-2 text-[11px] text-gray-400">
              <EyeSlashIcon aria-hidden className="h-3.5 w-3.5" />
              Opens a private window
            </p>
          )}
        </div>
      )}

      {error && !open && (
        <p
          role="alert"
          className="absolute right-0 top-full z-30 mt-1.5 w-72 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs leading-relaxed text-red-700 shadow-sm"
        >
          {error}
        </p>
      )}
    </div>
  );
}
