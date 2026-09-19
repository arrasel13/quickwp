import { useEffect, useRef, useState } from "react";
import { ChevronDownIcon, PlayIcon, StopIcon } from "@heroicons/react/24/solid";
import clsx from "clsx";
import { api, errorText, hasBackend, type Site } from "../../lib/api";
import { useSites } from "../../lib/sites";
import SiteAvatar from "../SiteAvatar";

/**
 * The site in view, and what can be done with the site as a whole: run it, and
 * put it on a public address.
 *
 * Everything else about a site is a tab below; these two are the site itself,
 * so they sit on its name.
 */
export default function SiteHeaderMenu({ site }: { site: Site }) {
  const { reload } = useSites();
  const [open, setOpen] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [sharing, setSharing] = useState(false);
  /** The share as the backend knows it: one started from the Expose tab or
      the CLI counts too. */
  const [share, setShare] = useState<{ installed: boolean; url: string | null }>({
    installed: true,
    url: null,
  });
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const label = site.name || site.domain;

  useEffect(() => {
    setOpen(false);
    setError(null);
  }, [site.domain]);

  // Asked for as the menu opens, so it is never a stale answer.
  useEffect(() => {
    if (!open || !hasBackend) return;
    void api
      .tunnelStatus()
      .then((s) =>
        setShare({
          installed: s.installed,
          url: s.tunnels.find((t) => t.domain === site.domain)?.public_url ?? null,
        }),
      )
      .catch((e) => setError(errorText(e)));
  }, [open, site.domain]);

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

  const toggle = async () => {
    setToggling(true);
    setError(null);
    try {
      await api.siteSetEnabled(site.domain, !site.enabled);
      // A started site should answer straight away, not wait for the stack.
      if (!site.enabled) await api.stackStart();
    } catch (e) {
      setError(errorText(e));
    } finally {
      await reload();
      setToggling(false);
    }
  };

  const toggleShare = async () => {
    setSharing(true);
    setError(null);
    try {
      if (share.url) {
        await api.tunnelStop(site.domain);
        setShare((s) => ({ ...s, url: null }));
      } else {
        const url = await api.tunnelStart(site.domain);
        setShare((s) => ({ ...s, url }));
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSharing(false);
    }
  };

  const copy = () => {
    if (!share.url) return;
    void navigator.clipboard
      .writeText(share.url)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {
        /* a webview can refuse the clipboard; the link is on screen regardless */
      });
  };

  return (
    // Fills a narrow pane, but stops short of stretching across a wide one:
    // the site's name reads as a control, not a banner.
    <div ref={ref} className="relative w-full min-w-[200px] max-w-[300px]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={clsx(
          "flex w-full min-w-0 items-center gap-3 rounded-lg border bg-white py-2 pl-2 pr-3 text-left shadow-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-wp-blue/30",
          open ? "border-gray-300 bg-gray-50" : "border-gray-200 hover:bg-gray-50",
        )}
      >
        <span className="relative flex-shrink-0">
          <SiteAvatar name={label} className="h-9 w-9 text-sm" />
          <span
            aria-hidden
            className={clsx(
              "absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full ring-2 ring-white",
              site.enabled ? "bg-green-500" : "bg-gray-300",
            )}
          />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-semibold leading-5 text-gray-900">
            {label}
          </span>
          <span className="block truncate text-[11px] leading-4 text-gray-500">{site.domain}</span>
        </span>
        <ChevronDownIcon
          aria-hidden
          className={clsx(
            "h-4 w-4 flex-shrink-0 text-gray-400 transition-transform duration-200",
            open && "rotate-180",
          )}
        />
      </button>

      {open && (
        <div
          role="menu"
          aria-label={label}
          className="absolute inset-x-0 top-full z-30 mt-1.5 rounded-xl border border-gray-200 bg-white p-1 shadow-xl shadow-black/5"
        >
          <div className="flex items-center justify-between gap-3 px-3 py-2.5">
            <div className="min-w-0">
              <p className="text-[13px] font-semibold text-gray-900">Local</p>
              <p className="truncate text-[12px] text-gray-500">{site.domain}</p>
            </div>
            <Switch
              on={site.enabled}
              busy={toggling}
              label={site.enabled ? `Stop ${label}` : `Start ${label}`}
              onClick={() => void toggle()}
            />
          </div>

          <div className="mx-3 h-px bg-gray-100" />

          <div className="flex items-center justify-between gap-3 px-3 py-2.5">
            <div className="min-w-0">
              <p className="text-[13px] font-semibold text-gray-900">Share</p>
              {share.url ? (
                <button
                  type="button"
                  onClick={copy}
                  title="Copy the link"
                  className="block max-w-full truncate text-left text-[12px] text-wp-blue hover:underline"
                >
                  {copied ? "Link copied" : share.url}
                </button>
              ) : (
                <p className="truncate text-[12px] text-gray-500">
                  {!share.installed
                    ? "Install sharing in Nexora Settings › Expose."
                    : site.enabled
                      ? "Put the site on a public address."
                      : "Start the site to share it."}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={() => void toggleShare()}
              disabled={sharing || !share.installed || (!site.enabled && !share.url)}
              className={clsx(
                "flex-shrink-0 rounded-md px-3 py-1.5 text-[12px] font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-wp-blue/30 disabled:cursor-not-allowed disabled:opacity-40",
                share.url
                  ? "border border-gray-300 bg-white text-gray-700 hover:bg-gray-50"
                  : "bg-wp-blue text-white hover:bg-wp-blue-dark",
              )}
            >
              {sharing ? "Working…" : share.url ? "Stop" : "Share"}
            </button>
          </div>

          {error && (
            <p
              role="alert"
              className="mx-2 mb-1 break-words rounded-md bg-red-50 px-2.5 py-2 text-[12px] leading-relaxed text-red-700"
            >
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** The site's own switch: on is running. */
function Switch({
  on,
  busy,
  label,
  onClick,
}: {
  on: boolean;
  busy: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={busy}
      className={clsx(
        "relative h-7 w-12 flex-shrink-0 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-wp-blue/30",
        on ? "bg-green-500" : "bg-gray-300",
        busy && "animate-pulse",
      )}
    >
      <span
        aria-hidden
        className={clsx(
          "absolute top-1 grid h-5 w-5 place-items-center rounded-full bg-white shadow transition-[left] duration-200",
          on ? "left-6" : "left-1",
        )}
      >
        {on ? (
          <StopIcon className="h-2.5 w-2.5 text-gray-600" />
        ) : (
          <PlayIcon className="h-2.5 w-2.5 text-gray-600" />
        )}
      </span>
    </button>
  );
}
