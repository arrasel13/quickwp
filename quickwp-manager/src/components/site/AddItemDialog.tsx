import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { Dialog, Transition } from "@headlessui/react";
import {
  ArrowDownTrayIcon,
  ArrowTopRightOnSquareIcon,
  ArrowUpTrayIcon,
  MagnifyingGlassIcon,
  StarIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import { open as pickFile } from "@tauri-apps/plugin-dialog";
import clsx from "clsx";
import { api, errorText, type DirectoryItem } from "../../lib/api";
import { unlessWindowDrag } from "../../lib/windowDrag";
import ConfirmDialog from "../ui/ConfirmDialog";

type Kind = "plugin" | "theme";
type Source = "wporg" | "upload" | "git";

/**
 * Adding a plugin or a theme to one site: from the WordPress.org directory,
 * from a zip, or from a Git repository -- what wp-admin's "Add plugin" screen
 * offers, in one dialog.
 */
export default function AddItemDialog({
  open,
  kind,
  domain,
  onClose,
  onInstalled,
}: {
  open: boolean;
  kind: Kind;
  domain: string;
  onClose: () => void;
  /** The list behind the dialog re-reads the site. */
  onInstalled: () => Promise<void> | void;
}) {
  const [source, setSource] = useState<Source>("wporg");
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** Something of that name is already installed: replace it, or not. */
  const [clash, setClash] = useState<{ value: string; message: string } | null>(null);
  const [activate, setActivate] = useState(kind === "plugin");

  useEffect(() => {
    if (!open) return;
    setNote(null);
    setBusy(null);
    setClash(null);
  }, [open, kind]);

  const install = async (value: string, label: string, force = false) => {
    setBusy(value);
    setNote(null);
    try {
      const msg = await api.wpInstallItem(domain, kind, value, activate, force);
      await onInstalled();
      setNote({ ok: true, text: msg || `${label} installed.` });
    } catch (e) {
      const text = errorText(e);
      // The backend names what is in the way, so replacing it is a choice
      // rather than a guess.
      if (!force && /already|exists/i.test(text)) setClash({ value, message: text });
      else setNote({ ok: false, text });
    } finally {
      setBusy(null);
    }
  };

  const title = kind === "plugin" ? "Add plugin" : "Add theme";
  const sources: [Source, string][] = [
    ["wporg", "WordPress.org"],
    ["upload", "Upload"],
    ["git", "GitHub"],
  ];

  return (
    <>
      <Transition appear show={open} as={Fragment}>
        <Dialog as="div" className="relative z-[60]" onClose={unlessWindowDrag(onClose)}>
          <Transition.Child
            as={Fragment}
            enter="ease-out duration-150"
            enterFrom="opacity-0"
            enterTo="opacity-100"
            leave="ease-in duration-100"
            leaveFrom="opacity-100"
            leaveTo="opacity-0"
          >
            <div className="fixed inset-0 bg-gray-900/40" />
          </Transition.Child>

          <div className="fixed inset-0 overflow-y-auto">
            <div className="flex min-h-full items-center justify-center p-4">
              <Transition.Child
                as={Fragment}
                enter="ease-out duration-150"
                enterFrom="opacity-0 scale-95"
                enterTo="opacity-100 scale-100"
                leave="ease-in duration-100"
                leaveFrom="opacity-100 scale-100"
                leaveTo="opacity-0 scale-95"
              >
                <Dialog.Panel className="flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-xl">
                  <div className="flex items-center gap-3 border-b border-gray-200 px-4 py-3">
                    <Dialog.Title className="text-sm font-semibold text-gray-900">
                      {title}
                    </Dialog.Title>
                    <span className="truncate text-xs text-gray-500">{domain}</span>
                    <button
                      type="button"
                      onClick={onClose}
                      aria-label="Close"
                      className="ml-auto rounded-md p-1 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700"
                    >
                      <XMarkIcon className="h-4 w-4" />
                    </button>
                  </div>

                  <div className="flex items-center gap-4 border-b border-gray-200 px-4">
                    {sources.map(([id, label]) => (
                      <button
                        key={id}
                        type="button"
                        onClick={() => setSource(id)}
                        className={clsx(
                          "relative whitespace-nowrap py-2.5 text-[13px] font-medium transition-colors",
                          source === id
                            ? "text-gray-900"
                            : "text-gray-500 hover:text-gray-900",
                        )}
                      >
                        {label}
                        {source === id && (
                          <span className="absolute inset-x-0 bottom-0 h-0.5 bg-gray-900" />
                        )}
                      </button>
                    ))}

                    {kind === "plugin" && (
                      <label className="ml-auto flex items-center gap-1.5 text-xs text-gray-700">
                        <input
                          type="checkbox"
                          checked={activate}
                          onChange={(e) => setActivate(e.target.checked)}
                          className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-2 focus:ring-blue-500/30"
                        />
                        Activate after install
                      </label>
                    )}
                  </div>

                  <div className="min-h-0 flex-1 overflow-y-auto p-4">
                    {source === "wporg" && (
                      <Directory
                        kind={kind}
                        busy={busy}
                        onInstall={(item) => void install(item.slug, item.name)}
                      />
                    )}
                    {source === "upload" && (
                      <FromZip kind={kind} busy={busy} onInstall={install} />
                    )}
                    {source === "git" && (
                      <FromGit
                        kind={kind}
                        domain={domain}
                        busy={busy}
                        setBusy={setBusy}
                        setNote={setNote}
                        onInstalled={onInstalled}
                      />
                    )}
                  </div>

                  {note && (
                    <p
                      role={note.ok ? "status" : "alert"}
                      className={clsx(
                        "border-t px-4 py-2.5 text-xs",
                        note.ok
                          ? "border-green-100 bg-green-50 text-green-900"
                          : "border-red-100 bg-red-50 text-red-900",
                      )}
                    >
                      {note.text}
                    </p>
                  )}
                </Dialog.Panel>
              </Transition.Child>
            </div>
          </div>
        </Dialog>
      </Transition>

      <ConfirmDialog
        open={clash !== null}
        title={`Replace the installed ${kind}?`}
        confirmLabel="Replace"
        body={<span className="break-words">{clash?.message}</span>}
        onCancel={() => setClash(null)}
        onConfirm={() => {
          const value = clash?.value;
          setClash(null);
          if (value) void install(value, value, true);
        }}
      />
    </>
  );
}

// ------------------------------------------------------------- wordpress.org

function Directory({
  kind,
  busy,
  onInstall,
}: {
  kind: Kind;
  busy: string | null;
  onInstall: (item: DirectoryItem) => void;
}) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<DirectoryItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const latest = useRef(0);

  const run = useCallback(
    async (term: string) => {
      const mine = ++latest.current;
      setLoading(true);
      setError(null);
      try {
        const found = await api.wporgSearch(kind, term);
        if (mine === latest.current) setItems(found);
      } catch (e) {
        if (mine === latest.current) setError(errorText(e));
      } finally {
        if (mine === latest.current) setLoading(false);
      }
    },
    [kind],
  );

  // What is popular to begin with, then the search as it is typed -- with a
  // pause, so one search runs rather than one per keystroke.
  useEffect(() => {
    const timer = window.setTimeout(() => void run(query), query ? 350 : 0);
    return () => window.clearTimeout(timer);
  }, [query, run]);

  return (
    <div>
      <div className="relative">
        <MagnifyingGlassIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={kind === "plugin" ? "Search plugins…" : "Search themes…"}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          autoFocus
          className="w-full rounded-lg border border-gray-300 py-2 pl-9 pr-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/30"
        />
      </div>

      <p className="mt-2 text-[11px] text-gray-500">
        {error
          ? ""
          : loading
            ? "Searching WordPress.org…"
            : query
              ? `${items?.length ?? 0} result${items?.length === 1 ? "" : "s"} for “${query}”`
              : `Popular ${kind}s on WordPress.org`}
      </p>

      {error && <p className="mt-2 text-xs text-red-700">{error}</p>}

      {/* A grid of cards, as the directory itself shows them. Install sits
          over the card on hover, and is always there for the keyboard. */}
      <ul className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {(items ?? []).map((item) => (
          <li
            key={item.slug}
            className="group relative flex flex-col overflow-hidden rounded-xl border border-gray-200 transition-shadow hover:shadow-md"
          >
            <div
              className={clsx(
                "relative overflow-hidden bg-gray-50",
                kind === "plugin" ? "flex items-center justify-center py-4" : "aspect-[4/3]",
              )}
            >
              {item.image ? (
                <img
                  src={item.image}
                  alt=""
                  loading="lazy"
                  className={clsx(
                    kind === "plugin" ? "h-16 w-16 rounded-xl object-contain" : "h-full w-full object-cover",
                  )}
                />
              ) : (
                <span
                  className={clsx(
                    "grid place-items-center text-lg font-semibold uppercase text-gray-400",
                    kind === "plugin" ? "h-16 w-16 rounded-xl bg-gray-100" : "h-full w-full bg-gray-100",
                  )}
                >
                  {item.name.charAt(0)}
                </span>
              )}

              {/* Over the picture on hover, or whenever it has focus. */}
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-gray-900/45 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => onInstall(item)}
                  className="pointer-events-auto rounded-lg bg-white px-3 py-1.5 text-xs font-semibold text-gray-900 shadow transition-colors hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {busy === item.slug ? "Installing…" : "Install"}
                </button>
              </div>
            </div>

            <div className="min-w-0 flex-1 border-t border-gray-100 p-3">
              <p className="truncate text-[13px] font-semibold text-gray-900" title={item.name}>
                {item.name}
              </p>
              <p className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-gray-600">
                {item.description}
              </p>
              <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-gray-500">
                <span>v{item.version}</span>
                {item.num_ratings > 0 && (
                  <span className="inline-flex items-center gap-0.5">
                    <StarIcon className="h-3 w-3 text-amber-500" />
                    {(item.rating / 20).toFixed(1)}
                  </span>
                )}
                {item.active_installs > 0 && <span>{formatInstalls(item.active_installs)}</span>}
                <a
                  href={item.homepage}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-0.5 underline underline-offset-2 hover:no-underline"
                >
                  Details
                  <ArrowTopRightOnSquareIcon className="h-3 w-3" />
                </a>
              </p>
              {item.author && (
                <p className="mt-0.5 truncate text-[11px] text-gray-400">by {item.author}</p>
              )}
            </div>
          </li>
        ))}
      </ul>

      {!loading && !error && items?.length === 0 && (
        <p className="py-6 text-center text-xs text-gray-500">
          Nothing on WordPress.org matches “{query}”.
        </p>
      )}
    </div>
  );
}

function formatInstalls(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 1_000_000)}M+`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k+`;
  return `${n}+`;
}

// -------------------------------------------------------------------- zip

function FromZip({
  kind,
  busy,
  onInstall,
}: {
  kind: Kind;
  busy: string | null;
  onInstall: (value: string, label: string) => Promise<void>;
}) {
  const [zip, setZip] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const choose = async () => {
    setError(null);
    try {
      // The native panel, so what comes back is a real path WP-CLI can read.
      // A browser <input type="file"> hands over a File with no path at all.
      const picked = await pickFile({
        multiple: false,
        directory: false,
        filters: [{ name: "Zip archive", extensions: ["zip"] }],
      });
      if (typeof picked === "string") setZip(picked);
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <div className="py-2">
      <div className="rounded-xl border border-dashed border-gray-300 px-4 py-8 text-center">
        <ArrowUpTrayIcon className="mx-auto h-6 w-6 text-gray-400" />
        <p className="mt-2 text-xs text-gray-600">
          Choose the {kind}&apos;s .zip file, as wp-admin&apos;s upload does.
        </p>
        <button
          type="button"
          onClick={() => void choose()}
          className="mt-3 rounded-lg border border-gray-300 bg-white px-3 py-2 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50"
        >
          Choose file…
        </button>
        {zip && <p className="mt-3 break-all font-mono text-[11px] text-gray-600">{zip}</p>}
      </div>

      <button
        type="button"
        disabled={!zip || busy !== null}
        onClick={() => zip && void onInstall(zip, zip.split("/").pop() ?? "The zip")}
        className="mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <ArrowDownTrayIcon className="h-4 w-4" />
        {busy && zip === busy ? "Installing…" : "Install now"}
      </button>

      {error && <p className="mt-2 text-xs text-red-700">{error}</p>}
    </div>
  );
}

// ------------------------------------------------------------------- git

function FromGit({
  kind,
  domain,
  busy,
  setBusy,
  setNote,
  onInstalled,
}: {
  kind: Kind;
  domain: string;
  busy: string | null;
  setBusy: (v: string | null) => void;
  setNote: (v: { ok: boolean; text: string } | null) => void;
  onInstalled: () => Promise<void> | void;
}) {
  const [url, setUrl] = useState("");
  const [branch, setBranch] = useState("");

  const pull = async () => {
    setBusy("git");
    setNote(null);
    try {
      const msg = await api.wpInstallFromGit(domain, kind, url.trim(), branch.trim());
      await onInstalled();
      setNote({ ok: true, text: msg });
    } catch (e) {
      setNote({ ok: false, text: errorText(e) });
    } finally {
      setBusy(null);
    }
  };

  const field =
    "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/30";

  return (
    <div className="space-y-3 py-2">
      <div>
        <label htmlFor="git-url" className="mb-1.5 block text-xs font-medium text-gray-700">
          Repository URL
        </label>
        <input
          id="git-url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && url.trim()) void pull();
          }}
          placeholder="https://github.com/owner/repo  or  owner/repo"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          autoFocus
          className={clsx(field, "font-mono text-xs")}
        />
      </div>

      <div>
        <label htmlFor="git-branch" className="mb-1.5 block text-xs font-medium text-gray-700">
          Branch <span className="font-normal text-gray-400">optional</span>
        </label>
        <input
          id="git-branch"
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && url.trim()) void pull();
          }}
          placeholder="main"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          className={clsx(field, "font-mono text-xs")}
        />
      </div>

      <button
        type="button"
        disabled={!url.trim() || busy !== null}
        onClick={() => void pull()}
        className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <ArrowDownTrayIcon className="h-4 w-4" />
        {busy === "git" ? "Pulling…" : "Pull"}
      </button>

      <p className="text-[11px] leading-relaxed text-gray-500">
        Cloned into wp-content/{kind}s with a shallow checkout, so it stays a git working copy
        you can pull again yourself. <span className="font-mono">owner/repo</span> means
        github.com.
      </p>
    </div>
  );
}
