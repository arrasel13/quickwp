import { useEffect, useState } from "react";
import {
  ArrowPathIcon,
  PlayIcon,
  StopIcon,
  ArrowDownTrayIcon,
  ArrowUpTrayIcon,
  CircleStackIcon,
} from "@heroicons/react/24/outline";
import clsx from "clsx";
import { api, errorText, hasBackend, EngineStatus, InstallProgress } from "../../lib/api";
import { useAsync } from "../../lib/useAsync";

export default function ServicesTab() {
  const { data: engines, error, loading, reload } = useAsync(() => api.dbList(), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [progress, setProgress] = useState<(InstallProgress & { id: string }) | null>(null);
  const [databases, setDatabases] = useState<string[]>([]);
  const [openSeries, setOpenSeries] = useState<string | null>(null);

  useEffect(() => {
    let un: (() => void) | undefined;
    void api.onDownloadProgress(setProgress).then((f) => {
      un = f as () => void;
    });
    return () => un?.();
  }, []);

  const running = (engines ?? []).find((e) => e.running);

  useEffect(() => {
    if (!running) {
      setDatabases([]);
      setOpenSeries(null);
      return;
    }
    setOpenSeries(running.series);
    api.dbDatabases(running.series).then(setDatabases).catch(() => setDatabases([]));
  }, [running?.series, running?.running]);

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
          <p className="text-xs text-amber-800">
            Run <code className="bg-amber-100 px-1 rounded">npm run tauri dev</code>.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto p-4 space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Services</h1>
          <p className="text-xs text-gray-600">
            Database engines, on ports offset so they never collide with one you already run.
          </p>
        </div>
        <button
          onClick={() => void reload()}
          disabled={loading}
          className="inline-flex items-center px-3 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50"
        >
          <ArrowPathIcon className={clsx("h-4 w-4 mr-2", loading && "animate-spin")} />
          Refresh
        </button>
      </div>

      {notice && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-xs text-blue-900 whitespace-pre-wrap break-words">
          {notice}
        </div>
      )}
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-900">{error}</div>
      )}
      {progress && (
        <div className="rounded-lg border border-gray-200 bg-white px-4 py-3">
          <div className="flex items-center justify-between text-xs text-gray-700 mb-2">
            <span>{progress.component}</span>
            <span className="tabular-nums">
              {(progress.received / 1048576).toFixed(0)} MB
              {progress.total ? ` / ${(progress.total / 1048576).toFixed(0)} MB` : ""}
            </span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-gray-200 overflow-hidden">
            <div
              className={clsx("h-full bg-blue-600", !progress.total && "w-1/3 animate-pulse")}
              style={
                progress.total
                  ? { width: `${Math.min(100, (progress.received / progress.total) * 100)}%` }
                  : undefined
              }
            />
          </div>
        </div>
      )}

      <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
        <div className="p-4">
          <h2 className="text-lg font-semibold text-gray-900">MySQL</h2>
          <p className="text-xs text-gray-600 mb-3">
            Each series keeps its own data directory. Switching 8.4 to 8.0 starts the other series
            against its own data — it is not a migration, and nothing follows you across.
          </p>

          <div className="border border-gray-200 rounded-lg overflow-hidden">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-2 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">
                    Series
                  </th>
                  <th className="px-4 py-2 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">
                    State
                  </th>
                  <th className="px-4 py-2 text-right text-xs font-semibold text-gray-600 uppercase tracking-wider">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-100">
                {(engines ?? []).map((e: EngineStatus) => (
                  <tr key={e.series} className="hover:bg-gray-50">
                    <td className="px-4 py-2 whitespace-nowrap">
                      <div className="flex items-center gap-2">
                        <CircleStackIcon className="h-4 w-4 text-gray-400" />
                        <span className="text-sm font-semibold text-gray-900">MySQL {e.series}</span>
                        <span className="text-xs text-gray-500 bg-gray-100 px-1.5 py-0.5 rounded tabular-nums">
                          {e.version}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-2 whitespace-nowrap">
                      <span
                        className={clsx(
                          "inline-flex items-center gap-1.5 text-xs",
                          e.running ? "text-green-800" : "text-gray-500",
                        )}
                      >
                        <span
                          className={clsx(
                            "h-1.5 w-1.5 rounded-full",
                            e.running ? "bg-green-500" : "bg-gray-300",
                          )}
                        />
                        <span className="tabular-nums">
                          {e.running ? e.port : e.installed ? "stopped" : "not installed"}
                        </span>
                      </span>
                    </td>
                    <td className="px-4 py-2 whitespace-nowrap text-right">
                      <div className="flex items-center justify-end gap-1">
                        {!e.installed ? (
                          <button
                            onClick={() => void act(e.series, () => api.dbInstall(e.series))}
                            disabled={busy !== null}
                            className="inline-flex items-center px-3 py-1 border border-gray-300 text-xs font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50"
                          >
                            {busy === e.series ? (
                              <>
                                <ArrowPathIcon className="h-3 w-3 mr-1 animate-spin" />
                                Downloading
                              </>
                            ) : (
                              "Install"
                            )}
                          </button>
                        ) : (
                          <button
                            title={e.running ? "Stop" : "Start"}
                            onClick={() =>
                              void act(e.series, () =>
                                e.running ? api.dbStop(e.series) : api.dbStart(e.series),
                              )
                            }
                            disabled={busy !== null}
                            className="p-1.5 rounded-md border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                          >
                            {e.running ? (
                              <StopIcon className="h-3.5 w-3.5" />
                            ) : (
                              <PlayIcon className="h-3.5 w-3.5" />
                            )}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="mt-3 text-[11px] leading-relaxed text-gray-500">
            MariaDB is not offered: upstream publishes no macOS build, so shipping it means
            producing a reproducible build of our own. Listing it as “coming soon” would be a
            promise nobody can keep.
          </p>
        </div>
      </div>

      {openSeries && databases.length > 0 && (
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
          <h2 className="text-sm font-semibold text-gray-900 mb-1">Databases</h2>
          <p className="text-xs text-gray-600 mb-3">
            Exports are written to ~/Downloads. Import overwrites the target's tables.
          </p>
          <div className="divide-y divide-gray-100 border border-gray-200 rounded-lg">
            {databases.map((name) => (
              <div key={name} className="flex items-center justify-between px-3 py-2 gap-3">
                <span className="font-mono text-xs text-gray-800 truncate">{name}</span>
                <div className="flex items-center gap-1 flex-shrink-0">
                  <button
                    title="Export to ~/Downloads"
                    onClick={() =>
                      void act(`export:${name}`, async () => {
                        const p = await api.dbExport(openSeries, name);
                        return `Exported to ${p}`;
                      })
                    }
                    disabled={busy !== null}
                    className="p-1.5 rounded-md border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                  >
                    <ArrowDownTrayIcon className="h-3.5 w-3.5" />
                  </button>
                  <button
                    title="Import a .sql file (overwrites)"
                    onClick={() => {
                      const file = prompt(
                        `Import a .sql file into \`${name}\`.\n\nThis OVERWRITES its tables. Full path:`,
                      );
                      if (!file) return;
                      void act(`import:${name}`, () => api.dbImport(openSeries, name, file));
                    }}
                    disabled={busy !== null}
                    className="p-1.5 rounded-md border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                  >
                    <ArrowUpTrayIcon className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
