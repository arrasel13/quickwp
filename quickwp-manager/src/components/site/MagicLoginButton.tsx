import { useEffect, useRef, useState } from "react";
import { ChevronDownIcon } from "@heroicons/react/24/solid";
import { GlobeAltIcon } from "@heroicons/react/24/outline";
import clsx from "clsx";
import { api, errorText, type BrowserChoice, type Site } from "../../lib/api";
import { useAppData } from "../../lib/appData";
import { WordPressLogo } from "../ui/WpIcons";

/**
 * Log in to wp-admin as the administrator, in a browser of this Mac, without
 * typing a password.
 *
 * It sits beside the site's name when the preview pane is off: with no pane,
 * wp-admin opens in a real browser instead.
 *
 * The button logs in, in the browser this Mac opens links with. The arrow
 * beside it is for the other ways: another browser, or a private window --
 * each browser one row, with its private window beside it, rather than a list
 * twice as long.
 */
export default function MagicLoginButton({ site }: { site: Site }) {
  const { data: browsers } = useAppData("browser-choices");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setOpen(false);
    setError(null);
  }, [site.domain]);

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
    return () => {
      window.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", escape);
    };
  }, [open]);

  // `null` is the preferred browser, as App settings has it.
  const login = async (browser: string | null, privately: boolean) => {
    setBusy(`${browser ?? "default"}${privately ? ":private" : ""}`);
    setError(null);
    try {
      await api.wpMagicLoginIn(site.domain, browser, privately);
      setOpen(false);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const stopped = !site.enabled;

  return (
    <div ref={ref} className="relative flex-shrink-0">
      {/* Two buttons, one shape: the login itself, and the ways into it. */}
      <div
        className={clsx(
          "flex h-[46px] overflow-hidden rounded-lg shadow-sm transition-colors",
          stopped ? "bg-wp-blue/40" : "bg-wp-blue",
        )}
      >
        <button
          type="button"
          onClick={() => void login(null, false)}
          disabled={stopped || busy !== null}
          title={
            stopped
              ? `Start ${site.name || site.domain} to log in`
              : "Log in to wp-admin in the browser this Mac uses"
          }
          className={clsx(
            "flex items-center gap-2 px-3.5 text-[13px] font-semibold text-white transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/60",
            stopped ? "cursor-not-allowed" : "hover:bg-wp-blue-dark",
          )}
        >
          {busy === "default" ? (
            <span
              aria-hidden
              className="h-[18px] w-[18px] animate-spin rounded-full border-2 border-white/40 border-t-white"
            />
          ) : (
            <WordPressLogo className="h-[18px] w-[18px]" />
          )}
          <span className="whitespace-nowrap">Magic Login</span>
        </button>

        <span aria-hidden className="my-2 w-px flex-shrink-0 bg-white/25" />

        <button
          type="button"
          onClick={() => {
            setError(null);
            setOpen((o) => !o);
          }}
          disabled={stopped}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="Log in in another browser"
          title="Another browser, or a private window"
          className={clsx(
            "grid w-8 place-items-center text-white transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/60",
            stopped ? "cursor-not-allowed" : open ? "bg-wp-blue-dark" : "hover:bg-wp-blue-dark",
          )}
        >
          <ChevronDownIcon
            aria-hidden
            className={clsx("h-4 w-4 text-white/90 transition-transform duration-200", open && "rotate-180")}
          />
        </button>
      </div>

      {open && (
        <div
          role="menu"
          aria-label="Log in to wp-admin in"
          className="absolute right-0 top-full z-30 mt-1.5 w-[280px] rounded-xl border border-gray-200 bg-white p-1 shadow-xl shadow-black/5"
        >
          <p className="px-3 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wider text-gray-400">
            Log in as admin in
          </p>
          {(browsers ?? []).map((b) => (
            <Row
              key={b.path}
              browser={b}
              busy={busy}
              onOpen={(privately) => void login(b.path, privately)}
            />
          ))}
          {browsers?.length === 0 && (
            <p className="px-3 py-2 text-[12px] text-gray-500">No browser was found on this Mac.</p>
          )}
          {!browsers && <p className="px-3 py-2 text-[12px] text-gray-500">Looking for browsers…</p>}

          {error && (
            <p
              role="alert"
              className="mx-2 mb-1 mt-1 break-words rounded-md bg-red-50 px-2.5 py-2 text-[12px] leading-relaxed text-red-700"
            >
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** One browser: its own window, and its private one beside it. */
function Row({
  browser,
  busy,
  onOpen,
}: {
  browser: BrowserChoice;
  busy: string | null;
  onOpen: (privately: boolean) => void;
}) {
  const working = busy === browser.path;
  const workingPrivately = busy === `${browser.path}:private`;
  return (
    <div className="group flex items-center rounded-lg pr-1 hover:bg-gray-50">
      <button
        type="button"
        role="menuitem"
        onClick={() => onOpen(false)}
        disabled={busy !== null}
        className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2 py-2 text-left disabled:opacity-60"
      >
        {working ? (
          <span
            aria-hidden
            className="h-5 w-5 flex-shrink-0 animate-spin rounded-full border-2 border-gray-200 border-t-gray-500"
          />
        ) : browser.icon ? (
          <img src={browser.icon} alt="" className="h-5 w-5 flex-shrink-0 rounded" />
        ) : (
          <GlobeAltIcon className="h-5 w-5 flex-shrink-0 text-gray-400" />
        )}
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-gray-900">
          {browser.name}
        </span>
        {browser.default && (
          <span className="flex-shrink-0 text-[11px] text-gray-400">default</span>
        )}
      </button>

      {/* The same browser, in the window that keeps no login: the way to be
          signed in as two users at once. */}
      <span aria-hidden className="mx-1 h-5 w-px flex-shrink-0 bg-gray-200" />
      <button
        type="button"
        role="menuitem"
        onClick={() => onOpen(true)}
        disabled={busy !== null || !browser.private_window}
        title={
          browser.private_window
            ? `${browser.name}: ${browser.private_window}`
            : `${browser.name} cannot be opened in a private window from here`
        }
        aria-label={
          browser.private_window
            ? `${browser.name}, ${browser.private_window}`
            : `${browser.name} has no private window here`
        }
        className="grid h-8 w-8 flex-shrink-0 place-items-center rounded-md text-gray-400 transition-colors hover:bg-gray-200/70 hover:text-gray-900 disabled:pointer-events-none disabled:opacity-30"
      >
        {workingPrivately ? (
          <span
            aria-hidden
            className="h-4 w-4 animate-spin rounded-full border-2 border-gray-200 border-t-gray-500"
          />
        ) : (
          <IncognitoIcon className="h-[18px] w-[18px]" />
        )}
      </button>
    </div>
  );
}

/** A private window: the hat and glasses every browser draws for one. */
function IncognitoIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className} fill="currentColor">
      <path d="M8.21 5h7.58c.64 0 1.2.4 1.41 1l1.36 3.88c.09.25-.1.52-.37.52H5.81c-.27 0-.46-.27-.37-.52L6.8 6c.21-.6.77-1 1.41-1Zm-5.2 6.9h17.98c.55 0 1 .45 1 1s-.45 1-1 1H3.01c-.55 0-1-.45-1-1s.45-1 1-1Z" />
      <path d="M7.3 14.6a2.9 2.9 0 0 0 0 5.8 2.9 2.9 0 0 0 2.86-2.45c.3-.13.86-.25 1.84-.25.98 0 1.54.12 1.84.25A2.9 2.9 0 0 0 16.7 20.4a2.9 2.9 0 0 0 0-5.8c-1.36 0-2.5.94-2.81 2.2-.45-.14-1.06-.22-1.89-.22-.83 0-1.44.08-1.89.22a2.9 2.9 0 0 0-2.81-2.2Z" />
    </svg>
  );
}
