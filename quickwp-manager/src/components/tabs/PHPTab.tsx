import { Fragment, useEffect, useState } from "react";
import { Dialog, Transition } from "@headlessui/react";
import {
  AdjustmentsHorizontalIcon,
  ArrowDownTrayIcon,
  ArrowPathIcon,
  ExclamationTriangleIcon,
  StarIcon,
  TrashIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import { StarIcon as StarSolidIcon } from "@heroicons/react/24/solid";
import clsx from "clsx";
import { api, errorText, hasBackend, InstallProgress, PhpVersion } from "../../lib/api";
import { useAsync } from "../../lib/useAsync";
import { unlessWindowDrag } from "../../lib/windowDrag";
import ConfirmDialog from "../ui/ConfirmDialog";

const INI_LABELS: Record<string, { title: string; hint: string }> = {
  memory_limit: { title: "Memory limit", hint: "Large imports, page builders, WooCommerce" },
  upload_max_filesize: { title: "Max upload size", hint: "Media uploads failing in WordPress" },
  post_max_size: { title: "Max post size", hint: "Must be at least the upload size" },
  max_execution_time: { title: "Max execution time", hint: "Long imports and migrations, in seconds" },
  display_errors: { title: "Display errors", hint: "See the error instead of a white page" },
  error_reporting: { title: "Error reporting", hint: "Which levels PHP reports" },
};

export default function PHPTab() {
  const { data: versions, error, loading, reload } = useAsync(() => api.phpList(), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<InstallProgress | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** The version whose php.ini is open in the panel. */
  const [tuning, setTuning] = useState<string | null>(null);
  const [removing, setRemoving] = useState<PhpVersion | null>(null);

  useEffect(() => {
    let un: (() => void) | undefined;
    void api.onInstallProgress(setProgress).then((f) => {
      un = f as () => void;
    });
    return () => un?.();
  }, []);

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setNotice(null);
    try {
      const r = await fn();
      if (typeof r === "string") setNotice(r);
      await reload();
    } catch (e) {
      setNotice(errorText(e));
    } finally {
      setBusy(null);
      setProgress(null);
    }
  };

  if (!hasBackend) {
    return (
      <p className="p-4 text-xs text-gray-500">
        Run <code className="rounded bg-gray-100 px-1">npm run tauri dev</code> to see real PHP
        versions.
      </p>
    );
  }

  return (
    <div className="p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-semibold text-gray-900">PHP versions</h2>
          <p className="mt-0.5 text-xs text-gray-600">
            Each is downloaded on demand and checked against a pinned checksum. One pool per
            version, shared by every site on it.
          </p>
        </div>
        <button
          onClick={() => void reload()}
          disabled={loading}
          title="Reload"
          className="flex-shrink-0 rounded-sm border border-gray-300 bg-white p-1.5 text-gray-600 transition-colors hover:bg-gray-50 disabled:opacity-50"
        >
          <ArrowPathIcon className={clsx("h-4 w-4", loading && "animate-spin")} />
        </button>
      </div>

      {notice && (
        <p className="mb-3 whitespace-pre-wrap rounded-sm border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900">
          {notice}
        </p>
      )}
      {error && (
        <p className="mb-3 rounded-sm border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-900">
          {error}
        </p>
      )}
      {progress && <Progress progress={progress} />}

      <ul className="divide-y divide-gray-100 border-y border-gray-100">
        {(versions ?? []).map((php) => (
          <li key={php.minor} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5">
            {/* Filled when the version is here, hollow when it is not. */}
            <span
              title={php.installed ? (php.running ? `Serving on port ${php.port}` : "Installed") : "Not installed"}
              className={clsx(
                "h-2 w-2 flex-shrink-0 rounded-full",
                php.installed
                  ? php.running
                    ? "bg-green-500"
                    : "bg-gray-400"
                  : "border border-gray-300",
              )}
            />
            <span className="font-mono text-[13px] font-semibold text-gray-900">
              PHP {php.minor}
            </span>
            <span className="font-mono text-[13px] text-gray-400 tabular-nums">{php.patch}</span>

            {php.eol && (
              <span
                title="Past its php.net security-end date"
                className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-900"
              >
                <ExclamationTriangleIcon className="h-3 w-3" />
                End of life
              </span>
            )}

            {php.is_default && (
              <span className="inline-flex items-center gap-1 rounded-full border border-wp-blue/30 bg-wp-blue/5 px-2 py-0.5 text-[11px] font-medium text-wp-blue">
                <StarSolidIcon className="h-3 w-3" />
                Default
              </span>
            )}

            <div className="ml-auto flex flex-shrink-0 items-center gap-3">
              {!php.installed ? (
                <button
                  onClick={() => void act(php.minor, () => api.phpInstall(php.minor))}
                  disabled={busy !== null}
                  className="inline-flex items-center gap-1.5 rounded-sm bg-wp-blue px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-wp-blue/90 disabled:opacity-50"
                >
                  {busy === php.minor ? (
                    <>
                      <ArrowPathIcon className="h-3.5 w-3.5 animate-spin" />
                      Installing
                    </>
                  ) : (
                    <>
                      <ArrowDownTrayIcon className="h-3.5 w-3.5" />
                      Install
                    </>
                  )}
                </button>
              ) : (
                <>
                  {/* The default cannot be unset, only moved to another
                      version, so that one has no star to press. */}
                  {!php.is_default && (
                    <IconButton
                      title="Use for new sites"
                      disabled={busy !== null}
                      onClick={() => void act(php.minor, () => api.phpSetDefault(php.minor))}
                    >
                      <StarIcon className="h-4 w-4" />
                    </IconButton>
                  )}
                  <IconButton title="php.ini settings" onClick={() => setTuning(php.minor)}>
                    <AdjustmentsHorizontalIcon className="h-4 w-4" />
                  </IconButton>
                  {/* Removing the default would leave new sites with no PHP
                      to use, so it is offered on the others. */}
                  {!php.is_default && (
                    <IconButton
                      title="Remove"
                      tone="hover:text-red-600"
                      disabled={busy !== null}
                      onClick={() => setRemoving(php)}
                    >
                      <TrashIcon className="h-4 w-4" />
                    </IconButton>
                  )}
                </>
              )}
            </div>
          </li>
        ))}
        {loading && (versions ?? []).length === 0 && (
          <li className="py-6 text-center text-xs text-gray-500">Loading…</li>
        )}
      </ul>

      <div className="mt-3 flex flex-wrap items-center gap-4 text-[11px] text-gray-500">
        <span className="inline-flex items-center gap-1.5">
          <StarIcon className="h-3.5 w-3.5" /> make default
        </span>
        <span className="inline-flex items-center gap-1.5">
          <AdjustmentsHorizontalIcon className="h-3.5 w-3.5" /> php.ini settings
        </span>
        <span className="inline-flex items-center gap-1.5">
          <TrashIcon className="h-3.5 w-3.5" /> remove
        </span>
      </div>

      <p className="mt-2 text-[11px] leading-relaxed text-gray-500">
        New sites use the default; a site can pick its own version in its Settings tab. Xdebug
        needs Zend symbols the static 8.0 build does not export, so it is offered on 8.1 and
        above; PHP 7.4 has no portable build published upstream.
      </p>

      <IniPanel
        minor={tuning}
        onClose={() => setTuning(null)}
        onSaved={(text) => setNotice(text)}
      />

      <ConfirmDialog
        open={removing !== null}
        title={`Remove PHP ${removing?.minor}?`}
        confirmLabel="Remove"
        body={
          <>
            Its pool stops and its files are deleted. Any site on PHP {removing?.minor} stops
            serving until you move it to another version.
          </>
        }
        busy={busy === removing?.minor}
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          const target = removing;
          setRemoving(null);
          if (target) void act(target.minor, () => api.phpUninstall(target.minor));
        }}
      />
    </div>
  );
}

function IconButton({
  title,
  onClick,
  disabled,
  tone,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  tone?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className={clsx(
        "rounded text-gray-400 transition-colors disabled:cursor-not-allowed disabled:opacity-40",
        tone ?? "hover:text-gray-900",
      )}
    >
      {children}
    </button>
  );
}

function Progress({ progress }: { progress: InstallProgress }) {
  return (
    <div className="mb-3 rounded-sm border border-gray-200 bg-white px-3 py-2.5">
      <div className="mb-2 flex items-center justify-between text-xs text-gray-700">
        <span>{progress.component}</span>
        <span className="tabular-nums">
          {(progress.received / 1048576).toFixed(1)} MB
          {progress.total ? ` / ${(progress.total / 1048576).toFixed(1)} MB` : ""}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-200">
        {/* No content-length means no honest percentage, so the bar stays
            indeterminate rather than showing a plausible false number. */}
        <div
          className={clsx("h-full bg-wp-blue", !progress.total && "w-1/3 animate-pulse")}
          style={
            progress.total
              ? { width: `${Math.min(100, (progress.received / progress.total) * 100)}%` }
              : undefined
          }
        />
      </div>
    </div>
  );
}

/**
 * One version's php.ini, in a panel from the right.
 *
 * Edited per version because one pool serves every site on it, and saving a
 * directive restarts that pool.
 */
function IniPanel({
  minor,
  onClose,
  onSaved,
}: {
  minor: string | null;
  onClose: () => void;
  onSaved: (text: string) => void;
}) {
  const [ini, setIni] = useState<[string, string][]>([]);
  const [saved, setSaved] = useState<[string, string][]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!minor) return;
    setError(null);
    setIni([]);
    api
      .phpIniGet(minor)
      .then((rows) => {
        setIni(rows);
        setSaved(rows);
      })
      .catch((e) => setError(errorText(e)));
  }, [minor]);

  const changed = ini.filter(([k, v]) => saved.find(([sk]) => sk === k)?.[1] !== v);

  const save = async () => {
    if (!minor) return;
    setBusy(true);
    setError(null);
    try {
      for (const [key, value] of changed) await api.phpIniSet(minor, key, value);
      setSaved(ini);
      onSaved(
        `PHP ${minor}: ${changed.length} setting${changed.length === 1 ? "" : "s"} saved. Its pool restarted.`,
      );
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Transition appear show={minor !== null} as={Fragment}>
      <Dialog as="div" className="relative z-[70]" onClose={busy ? () => {} : unlessWindowDrag(onClose)}>
        <Transition.Child
          as={Fragment}
          enter="ease-out duration-200"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave="ease-in duration-150"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <div className="fixed inset-0 bg-gray-900/30" />
        </Transition.Child>

        <div className="fixed inset-0 overflow-hidden">
          <div className="absolute inset-y-0 right-0 flex max-w-full">
            <Transition.Child
              as={Fragment}
              enter="transform transition ease-out duration-250"
              enterFrom="translate-x-full"
              enterTo="translate-x-0"
              leave="transform transition ease-in duration-200"
              leaveFrom="translate-x-0"
              leaveTo="translate-x-full"
            >
              <Dialog.Panel className="flex h-full w-screen max-w-md flex-col bg-white shadow-xl">
                <div className="flex items-center gap-3 border-b border-gray-200 px-4 py-3">
                  <Dialog.Title className="text-sm font-semibold text-gray-900">
                    php.ini
                  </Dialog.Title>
                  <span className="font-mono text-xs text-gray-500">PHP {minor}</span>
                  <button
                    type="button"
                    onClick={onClose}
                    aria-label="Close"
                    className="ml-auto rounded-md p-1 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700"
                  >
                    <XMarkIcon className="h-4 w-4" />
                  </button>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto p-4">
                  <p className="mb-3 text-xs leading-relaxed text-gray-500">
                    These apply to every site on PHP {minor}: one pool serves them all. Saving
                    restarts it.
                  </p>

                  {error && <p className="mb-3 text-xs text-red-700">{error}</p>}

                  <div className="space-y-3">
                    {ini.map(([key, value]) => (
                      <label key={key} className="block">
                        <span className="text-[13px] font-medium text-gray-900">
                          {INI_LABELS[key]?.title ?? key}
                        </span>
                        <span className="mt-0.5 block text-xs text-gray-500">
                          {INI_LABELS[key]?.hint ?? key}
                        </span>
                        <input
                          type="text"
                          value={value}
                          disabled={busy}
                          onChange={(e) =>
                            setIni((prev) =>
                              prev.map(([k, v]) => (k === key ? [k, e.target.value] : [k, v])),
                            )
                          }
                          autoComplete="off"
                          autoCorrect="off"
                          autoCapitalize="off"
                          spellCheck={false}
                          className="mt-1.5 block w-full rounded-sm border border-gray-300 px-3 py-2 font-mono text-[13px] focus:border-wp-blue focus:outline-none focus:ring-1 focus:ring-wp-blue disabled:opacity-60"
                        />
                        <span className="mt-1 block font-mono text-[10px] text-gray-400">{key}</span>
                      </label>
                    ))}
                    {ini.length === 0 && !error && (
                      <p className="text-xs text-gray-500">Reading php.ini…</p>
                    )}
                  </div>
                </div>

                <div className="flex items-center justify-between gap-3 border-t border-gray-200 px-4 py-3">
                  <span className="text-xs text-gray-500">
                    {changed.length > 0
                      ? `${changed.length} unsaved change${changed.length === 1 ? "" : "s"}`
                      : ""}
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={onClose}
                      disabled={busy}
                      className="rounded-sm px-3 py-2 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-100 hover:text-gray-900 disabled:opacity-50"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => void save()}
                      disabled={busy || changed.length === 0}
                      className="rounded-sm bg-wp-blue px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-wp-blue/90 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {busy ? "Saving…" : "Save changes"}
                    </button>
                  </div>
                </div>
              </Dialog.Panel>
            </Transition.Child>
          </div>
        </div>
      </Dialog>
    </Transition>
  );
}
