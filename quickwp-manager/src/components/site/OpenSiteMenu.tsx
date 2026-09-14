import { useEffect, useRef, useState } from "react";
import {
  ChevronDownIcon,
  EyeSlashIcon,
  GlobeAltIcon,
  KeyIcon,
} from "@heroicons/react/24/outline";
import clsx from "clsx";
import { api, BrowserChoice, errorText, hasBackend, Site } from "../../lib/api";
import { peekCache, putCache } from "../../lib/useAsync";

type Action = "open" | "private" | "login";

/**
 * The way into a site, beside its name.
 *
 * One row per browser, with the browser's own icon. Clicking the row opens the
 * site; the icons at its end open it in a private window instead, or -- for
 * WordPress -- log straight in to wp-admin with Magic Login. Every icon names
 * itself the moment it is pointed at, and the key at the bottom says what the
 * two mean, so nothing has to be guessed.
 */
export default function OpenSiteMenu({ site }: { site: Site }) {
  const canLogIn = site.kind === "wordpress";
  const [open, setOpen] = useState(false);
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
    const keys = ["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"];
    if (!keys.includes(e.key)) return;
    e.preventDefault();
    const items = Array.from(
      ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [],
    );
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const step = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : -1;
    items[(at + step + items.length) % items.length]?.focus();
  };

  // The menu closes on the click itself, so the choice feels instant; the
  // button shows the launch until the browser has it. One at a time: each
  // Magic Login mints a login token, and a double click would open two tabs.
  const go = async (b: BrowserChoice, action: Action) => {
    if (busy) return;
    setOpen(false);
    setBusy(true);
    setError(null);
    try {
      if (action === "login") {
        await api.wpMagicLoginIn(site.domain, b.path, false);
      } else {
        await api.siteOpenInBrowser(site.domain, b.path, action === "private");
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const anyPrivate = browsers.some((b) => b.private_window);

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
        {busy ? "Opening…" : "Open site"}
        <ChevronDownIcon
          aria-hidden
          className={clsx("h-3.5 w-3.5 text-gray-400 transition-transform duration-200", open && "rotate-180")}
        />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Open site"
          data-tauri-drag-region="false"
          onKeyDown={moveFocus}
          className="absolute right-0 top-full z-30 mt-1.5 w-72 rounded-xl border border-gray-200 bg-white p-1.5 shadow-lg shadow-black/5"
        >
          <p className="truncate px-2 pb-1.5 pt-1 text-[11px] font-medium text-gray-400">
            Open {site.domain} in
          </p>

          {browsers.length === 0 && (
            <p className="px-2 py-1.5 text-xs text-gray-500">No browsers found on this Mac.</p>
          )}

          {browsers.map((b) => (
            <div
              key={b.path}
              className="flex items-center gap-0.5 rounded-lg pr-1 transition-colors hover:bg-gray-50 focus-within:bg-gray-50"
            >
              <button
                type="button"
                role="menuitem"
                aria-label={`Open site in ${b.name}`}
                onClick={() => void go(b, "open")}
                className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left focus:outline-none"
              >
                {b.icon ? (
                  <img src={b.icon} alt="" draggable={false} className="h-5 w-5 flex-shrink-0" />
                ) : (
                  <GlobeAltIcon aria-hidden className="h-5 w-5 flex-shrink-0 text-gray-400" />
                )}
                <span className="truncate text-[13px] text-gray-800">{b.name}</span>
                {b.default && (
                  <span className="flex-shrink-0 rounded bg-gray-100 px-1 py-px text-[10px] font-medium text-gray-500">
                    Default
                  </span>
                )}
              </button>

              {b.private_window && (
                <IconAction
                  label={`Open site in ${b.name} (${b.private_window})`}
                  tip={b.private_window}
                  onClick={() => void go(b, "private")}
                >
                  <EyeSlashIcon aria-hidden className="h-4 w-4" />
                </IconAction>
              )}
              {canLogIn && (
                <IconAction
                  label={`Magic Login in ${b.name}`}
                  tip="Magic Login"
                  accent
                  onClick={() => void go(b, "login")}
                >
                  <KeyIcon aria-hidden className="h-4 w-4" />
                </IconAction>
              )}
            </div>
          ))}

          {/* The key to the icons, for anyone who has not pointed at one. */}
          {(anyPrivate || canLogIn) && browsers.length > 0 && (
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-gray-100 px-2 pb-0.5 pt-2 text-[11px] text-gray-500">
              {anyPrivate && (
                <span className="inline-flex items-center gap-1">
                  <EyeSlashIcon aria-hidden className="h-3.5 w-3.5 text-gray-400" />
                  Private window
                </span>
              )}
              {canLogIn && (
                <span className="inline-flex items-center gap-1">
                  <KeyIcon aria-hidden className="h-3.5 w-3.5 text-wp-blue" />
                  Magic Login to wp-admin
                </span>
              )}
            </div>
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

/** A small icon button at the end of a browser row, with a tooltip that shows at once. */
function IconAction({
  label,
  tip,
  accent,
  onClick,
  children,
}: {
  label: string;
  tip: string;
  accent?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      aria-label={label}
      onClick={onClick}
      className={clsx(
        "group/tip relative grid h-7 w-7 flex-shrink-0 place-items-center rounded-md transition-colors focus:outline-none",
        accent
          ? "text-wp-blue hover:bg-wp-blue/10 focus-visible:bg-wp-blue/10"
          : "text-gray-400 hover:bg-gray-200/70 hover:text-gray-800 focus-visible:bg-gray-200/70 focus-visible:text-gray-800",
      )}
    >
      {children}
      <span
        aria-hidden
        className="pointer-events-none absolute bottom-full right-0 z-10 mb-1 whitespace-nowrap rounded-md bg-gray-900 px-2 py-1 text-[11px] font-medium text-white opacity-0 shadow-sm transition-opacity duration-100 group-hover/tip:opacity-100 group-focus-visible/tip:opacity-100"
      >
        {tip}
      </span>
    </button>
  );
}
