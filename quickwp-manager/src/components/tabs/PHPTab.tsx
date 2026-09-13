import { useEffect, useState } from "react";
import {
  CheckIcon,
  ArrowPathIcon,
  PlayIcon,
  StopIcon,
  ExclamationTriangleIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import clsx from "clsx";
import { api, errorText, hasBackend, InstallProgress, PhpVersion } from "../../lib/api";
import { useAsync } from "../../lib/useAsync";

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
  const [selected, setSelected] = useState<string | null>(null);
  const [ini, setIni] = useState<[string, string][]>([]);

  useEffect(() => {
    let un: (() => void) | undefined;
    void api.onInstallProgress(setProgress).then((f) => {
      un = f as () => void;
    });
    return () => un?.();
  }, []);

  // Default the ini editor to whichever version is installed and current.
  useEffect(() => {
    if (!selected && versions?.length) {
      const first = versions.find((v) => v.installed && v.is_default) ?? versions.find((v) => v.installed);
      if (first) setSelected(first.minor);
    }
  }, [versions, selected]);

  useEffect(() => {
    if (!selected) return;
    api.phpIniGet(selected).then(setIni).catch(() => setIni([]));
  }, [selected]);

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
      <div className="max-w-6xl mx-auto p-6">
        <div className="border border-amber-200 bg-amber-50 rounded-lg p-5 max-w-xl">
          <h2 className="text-sm font-semibold text-amber-900 mb-1">No backend behind this window</h2>
          <p className="text-xs text-amber-800 leading-relaxed">
            You are viewing Nexora in a browser. PHP versions, pools and sites all live in the
            Rust backend, so run <code className="bg-amber-100 px-1 rounded">npm run tauri dev</code>{" "}
            to see real data.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto p-4">
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">PHP</h1>
            <p className="text-xs text-gray-600">
              One pool per version, shared by every site on it.
            </p>
          </div>
          <button
            onClick={() => void reload()}
            disabled={loading}
            className="inline-flex items-center px-3 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-colors disabled:opacity-50"
          >
            <ArrowPathIcon className={clsx("h-4 w-4 mr-2", loading && "animate-spin")} />
            Refresh
          </button>
        </div>

        {notice && (
          <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-xs text-blue-900 whitespace-pre-wrap">
            {notice}
          </div>
        )}
        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-900">
            {error}
          </div>
        )}
        {progress && (
          <div className="rounded-lg border border-gray-200 bg-white px-4 py-3">
            <div className="flex items-center justify-between text-xs text-gray-700 mb-2">
              <span>{progress.component}</span>
              <span className="tabular-nums">
                {(progress.received / 1048576).toFixed(1)} MB
                {progress.total ? ` / ${(progress.total / 1048576).toFixed(1)} MB` : ""}
              </span>
            </div>
            <div className="h-1.5 w-full rounded-full bg-gray-200 overflow-hidden">
              {/* No content-length means no honest percentage, so the bar stays
                  indeterminate rather than showing a plausible false number. */}
              <div
                className={clsx(
                  "h-full bg-blue-600",
                  !progress.total && "w-1/3 animate-pulse",
                )}
                style={
                  progress.total
                    ? { width: `${Math.min(100, (progress.received / progress.total) * 100)}%` }
                    : undefined
                }
              />
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* ---------------------------------------------- versions */}
          <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
            <div className="p-4">
              <div className="mb-3">
                <h2 className="text-lg font-semibold text-gray-900">Versions</h2>
                <p className="text-gray-600 text-xs">
                  Each is downloaded on demand and verified against a pinned checksum.
                </p>
              </div>

              <div className="border border-gray-200 rounded-lg overflow-hidden">
                {loading ? (
                  <div className="flex items-center justify-center py-8">
                    <ArrowPathIcon className="h-6 w-6 text-blue-500 animate-spin" />
                    <span className="ml-2 text-sm text-gray-600">Loading…</span>
                  </div>
                ) : (
                  <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-4 py-2 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">
                          Version
                        </th>
                        <th className="px-4 py-2 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">
                          Pool
                        </th>
                        <th className="px-4 py-2 text-right text-xs font-semibold text-gray-600 uppercase tracking-wider">
                          Actions
                        </th>
                      </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-100">
                      {(versions ?? []).map((php: PhpVersion) => (
                        <tr
                          key={php.minor}
                          onClick={() => php.installed && setSelected(php.minor)}
                          className={clsx(
                            "transition-colors",
                            php.installed && "cursor-pointer hover:bg-gray-50",
                            selected === php.minor && "bg-blue-50/60",
                          )}
                        >
                          <td className="px-4 py-2 whitespace-nowrap">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-sm font-semibold text-gray-900">
                                PHP {php.minor}
                              </span>
                              <span className="text-xs text-gray-500 bg-gray-100 px-1.5 py-0.5 rounded tabular-nums">
                                {php.patch}
                              </span>
                              {php.is_default && (
                                <span className="text-[10px] font-medium bg-blue-100 text-blue-800 px-1.5 py-0.5 rounded">
                                  DEFAULT
                                </span>
                              )}
                              {/* Badged, never hidden: plenty of real client work
                                  runs on a legacy codebase. */}
                              {php.eol && (
                                <span
                                  title="Past its php.net security-end date"
                                  className="inline-flex items-center gap-1 text-[10px] font-medium bg-amber-100 text-amber-900 px-1.5 py-0.5 rounded"
                                >
                                  <ExclamationTriangleIcon className="h-3 w-3" />
                                  EOL
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="px-4 py-2 whitespace-nowrap">
                            {php.installed ? (
                              <span
                                className={clsx(
                                  "inline-flex items-center gap-1.5 text-xs",
                                  php.running ? "text-green-800" : "text-gray-500",
                                )}
                              >
                                <span
                                  className={clsx(
                                    "h-1.5 w-1.5 rounded-full",
                                    php.running ? "bg-green-500" : "bg-gray-300",
                                  )}
                                />
                                <span className="tabular-nums">
                                  {php.running ? php.port : "stopped"}
                                </span>
                              </span>
                            ) : (
                              <span className="text-xs text-gray-400">—</span>
                            )}
                          </td>
                          <td className="px-4 py-2 whitespace-nowrap text-right">
                            <div className="flex items-center justify-end gap-1">
                              {!php.installed ? (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    void act(php.minor, () => api.phpInstall(php.minor));
                                  }}
                                  disabled={busy !== null}
                                  className="inline-flex items-center px-3 py-1 border border-gray-300 text-xs font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50"
                                >
                                  {busy === php.minor ? (
                                    <>
                                      <ArrowPathIcon className="h-3 w-3 mr-1 animate-spin" />
                                      Installing
                                    </>
                                  ) : (
                                    "Install"
                                  )}
                                </button>
                              ) : (
                                <>
                                  <button
                                    title={php.running ? "Stop pool" : "Start pool"}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      void act(php.minor, () =>
                                        php.running
                                          ? api.phpStop(php.minor)
                                          : api.phpStart(php.minor),
                                      );
                                    }}
                                    disabled={busy !== null}
                                    className="p-1.5 rounded-md border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                                  >
                                    {php.running ? (
                                      <StopIcon className="h-3.5 w-3.5" />
                                    ) : (
                                      <PlayIcon className="h-3.5 w-3.5" />
                                    )}
                                  </button>
                                  {!php.is_default && (
                                    <button
                                      title="Use for new sites"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        void act(php.minor, () => api.phpSetDefault(php.minor));
                                      }}
                                      disabled={busy !== null}
                                      className="p-1.5 rounded-md border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                                    >
                                      <CheckIcon className="h-3.5 w-3.5" />
                                    </button>
                                  )}
                                  <button
                                    title="Uninstall"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      if (!confirm(`Remove PHP ${php.minor}? Sites on it will stop serving.`))
                                        return;
                                      void act(php.minor, () => api.phpUninstall(php.minor));
                                    }}
                                    disabled={busy !== null}
                                    className="p-1.5 rounded-md border border-gray-300 text-gray-500 hover:bg-red-50 hover:text-red-700 disabled:opacity-50"
                                  >
                                    <TrashIcon className="h-3.5 w-3.5" />
                                  </button>
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

              <p className="mt-3 text-[11px] leading-relaxed text-gray-500">
                Xdebug needs Zend symbols the static 8.0 build does not export, so the toggle is
                offered on 8.1 and above only. PHP 7.4 has no portable build published upstream.
              </p>
            </div>
          </div>

          {/* ---------------------------------------------- php.ini */}
          <div className="space-y-4">
            <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
              <div className="px-4 py-4">
                <div className="flex items-baseline justify-between mb-1">
                  <h3 className="text-lg font-semibold text-gray-900">Configuration</h3>
                  {selected && (
                    <span className="text-xs text-gray-500">PHP {selected}</span>
                  )}
                </div>
                <p className="text-xs text-gray-600 mb-3">
                  Edited per version, because one pool serves every site on it. Saving restarts
                  that pool.
                </p>

                {!selected ? (
                  <p className="text-xs text-gray-500">
                    Install a version and select it to edit its settings.
                  </p>
                ) : (
                  <div className="grid grid-cols-1 gap-3">
                    {ini.map(([key, value]) => (
                      <div key={key} className="border border-gray-200 rounded-lg p-3">
                        <label className="block">
                          <span className="text-sm font-semibold text-gray-900">
                            {INI_LABELS[key]?.title ?? key}
                          </span>
                          <span className="block text-xs text-gray-600 mb-2">
                            {INI_LABELS[key]?.hint ?? key}
                          </span>
                          <div className="flex gap-2">
                            <input
                              type="text"
                              value={value}
                              onChange={(e) =>
                                setIni((prev) =>
                                  prev.map(([k, v]) => (k === key ? [k, e.target.value] : [k, v])),
                                )
                              }
                              className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 text-sm font-mono"
                            />
                            <button
                              onClick={() =>
                                void act(`ini:${key}`, () =>
                                  api.phpIniSet(selected, key, value),
                                )
                              }
                              disabled={busy !== null}
                              className="px-3 py-2 text-xs font-medium rounded-md border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50 whitespace-nowrap"
                            >
                              Save
                            </button>
                          </div>
                        </label>
                        <p className="mt-1 text-[10px] text-gray-400 font-mono">{key}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
