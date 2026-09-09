import { useState } from "react";
import {
  ArrowPathIcon,
  ArrowRightCircleIcon,
  ShieldCheckIcon,
  ExclamationTriangleIcon,
} from "@heroicons/react/24/outline";
import clsx from "clsx";
import { api, errorText, hasBackend, FoundSite, ConfigDiff } from "../../lib/api";
import { useAsync } from "../../lib/useAsync";

export default function MigrateTab() {
  const { data: scan, error, loading, reload } = useAsync(() => api.migrateScan(), []);
  const [chosen, setChosen] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  // Stage 2 and 3 act on sites already imported, so they read the live list.
  const { data: mine, reload: reloadMine } = useAsync(() => api.siteList(), []);
  const [stageBusy, setStageBusy] = useState<string | null>(null);
  const [diff, setDiff] = useState<{ domain: string; diff: ConfigDiff } | null>(null);

  const importable = (scan?.sites ?? []).filter((s) => s.importable);
  const selected = importable.filter((s) => chosen[s.domain]);

  const runImport = async () => {
    setBusy(true);
    setLog([]);
    try {
      const results = await api.migrateImport(
        selected.map((s) => ({
          domain: s.domain,
          path: s.path,
          name: s.name,
          aliases: s.aliases,
          php_minor: s.php_minor ?? "8.3",
        })),
      );
      setLog(results);
      setChosen({});
      await reload();
    } catch (e) {
      setLog([errorText(e)]);
    } finally {
      setBusy(false);
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
          <h1 className="text-2xl font-bold text-gray-900">Import from Herd</h1>
          <p className="text-xs text-gray-600">
            Finds the sites Herd and Valet are serving, and brings them across.
          </p>
        </div>
        <button
          onClick={() => void reload()}
          disabled={loading}
          className="inline-flex items-center px-3 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50"
        >
          <ArrowPathIcon className={clsx("h-4 w-4 mr-2", loading && "animate-spin")} />
          Scan again
        </button>
      </div>

      <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 flex items-start gap-2">
        <ShieldCheckIcon className="h-4 w-4 text-green-700 flex-shrink-0 mt-0.5" />
        <p className="text-xs text-green-900 leading-relaxed">
          <strong>Your Herd install is never written to.</strong> Nothing is moved, nothing is
          deleted, and no config of theirs is edited — Herd keeps working exactly as it does now.
          Imported sites are <em>linked</em>, so your code stays where it is. If you decide against
          this, there is nothing to undo.
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-900">{error}</div>
      )}

      {(scan?.stale_resolvers?.length ?? 0) > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 flex items-start gap-2">
          <ExclamationTriangleIcon className="h-4 w-4 text-amber-700 flex-shrink-0 mt-0.5" />
          <div className="text-xs text-amber-900 leading-relaxed">
            <strong>Another tool owns a TLD on this Mac.</strong>{" "}
            {scan!.stale_resolvers.join(", ")} does not point at QuickWP. Until that changes,
            those domains resolve elsewhere — QuickWP will not overwrite it without you deciding.
          </div>
        </div>
      )}

      {log.length > 0 && (
        <div className="rounded-lg border border-gray-200 bg-white px-4 py-3">
          <h3 className="text-[10px] font-semibold uppercase tracking-wider text-gray-500 mb-2">
            Result
          </h3>
          <ul className="space-y-1">
            {log.map((l, i) => (
              <li key={i} className="text-xs font-mono text-gray-800 break-words">
                {l}
              </li>
            ))}
          </ul>
        </div>
      )}


      {/* Stages 2 and 3 ------------------------------------------------ */}
      {(mine ?? []).filter((s) => s.is_linked).length > 0 && (
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
          <h2 className="text-lg font-semibold text-gray-900">Bring the data across</h2>
          <p className="text-xs text-gray-600 mb-3">
            Stage 2 copies a site's database into QuickWP's MySQL. Stage 3 points its config at
            the copy — the most invasive step, so it shows a diff and takes a backup first.
          </p>

          <div className="divide-y divide-gray-100 border border-gray-200 rounded-lg">
            {(mine ?? [])
              .filter((s) => s.is_linked)
              .map((s) => (
                <div key={s.id} className="px-3 py-3">
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-gray-900">{s.domain}</p>
                      <p className="text-[11px] text-gray-500">
                        {s.db_name ? (
                          <>
                            Copied into <code className="bg-gray-100 px-1 rounded">{s.db_name}</code>
                          </>
                        ) : (
                          "No database copied yet"
                        )}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <button
                        onClick={() =>
                          void (async () => {
                            setStageBusy(s.domain);
                            setLog([]);
                            try {
                              const r = await api.migrateCopyDatabase(s.domain);
                              setLog([
                                `${r.site}: ${r.source_db} -> ${r.target_db}`,
                                r.message,
                              ]);
                              await reloadMine();
                            } catch (e) {
                              setLog([errorText(e)]);
                            } finally {
                              setStageBusy(null);
                            }
                          })()
                        }
                        disabled={stageBusy !== null}
                        className="px-3 py-1.5 text-xs font-medium rounded-md border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50"
                      >
                        {stageBusy === s.domain ? "Copying…" : "Copy database"}
                      </button>
                      <button
                        onClick={() =>
                          void (async () => {
                            setStageBusy(s.domain);
                            try {
                              const d = await api.migratePreviewConfig(s.domain);
                              setDiff({ domain: s.domain, diff: d });
                            } catch (e) {
                              setLog([errorText(e)]);
                            } finally {
                              setStageBusy(null);
                            }
                          })()
                        }
                        disabled={stageBusy !== null || !s.db_name}
                        className="px-3 py-1.5 text-xs font-medium rounded-md border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-40"
                      >
                        Preview config rewrite
                      </button>
                    </div>
                  </div>
                </div>
              ))}
          </div>
        </div>
      )}

      {diff && (
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
          <h2 className="text-sm font-semibold text-gray-900 mb-1">
            {diff.diff.changes.length} line(s) would change
          </h2>
          <p className="text-[11px] font-mono text-gray-500 mb-3 break-all">{diff.diff.file}</p>

          {diff.diff.changes.length === 0 ? (
            <p className="text-xs text-gray-600">
              Nothing to change — this config already points at QuickWP.
            </p>
          ) : (
            <div className="border border-gray-200 rounded-lg overflow-hidden font-mono text-[11px]">
              {diff.diff.changes.map((c) => (
                <div key={c.line_number} className="border-b border-gray-100 last:border-0">
                  <div className="bg-red-50 text-red-900 px-3 py-1 flex gap-2">
                    <span className="text-red-400 tabular-nums w-8 text-right flex-shrink-0">
                      {c.line_number}
                    </span>
                    <span className="break-all">- {c.before.trim()}</span>
                  </div>
                  <div className="bg-green-50 text-green-900 px-3 py-1 flex gap-2">
                    <span className="text-green-500 tabular-nums w-8 text-right flex-shrink-0">
                      {c.line_number}
                    </span>
                    <span className="break-all">+ {c.after.trim()}</span>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="mt-3 flex items-center gap-2">
            <button
              onClick={() =>
                void (async () => {
                  setStageBusy(diff.domain);
                  try {
                    const msg = await api.migrateApplyConfig(diff.domain);
                    setLog([msg]);
                    setDiff(null);
                  } catch (e) {
                    setLog([errorText(e)]);
                  } finally {
                    setStageBusy(null);
                  }
                })()
              }
              disabled={stageBusy !== null || diff.diff.changes.length === 0}
              className="px-4 py-2 text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-40"
            >
              Apply, with a backup
            </button>
            <button
              onClick={() => setDiff(null)}
              className="px-3 py-2 text-xs font-medium rounded-md border border-gray-300 text-gray-700 bg-white hover:bg-gray-50"
            >
              Leave it alone
            </button>
            <span className="text-[11px] text-gray-500">
              Declining is a supported outcome — the site keeps talking to whatever it talks to now.
            </span>
          </div>
        </div>
      )}

      {loading ? (
        <p className="text-xs text-gray-500">Scanning…</p>
      ) : (scan?.sites.length ?? 0) === 0 ? (
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-6">
          <h2 className="text-sm font-semibold text-gray-900 mb-1">Nothing found</h2>
          <p className="text-xs text-gray-600 max-w-prose">
            No Laravel Herd or Valet installation is serving sites on this Mac. That is a supported
            outcome, not a failure — if you expected sites here, check that Herd is installed and
            has at least one linked or parked site.
          </p>
        </div>
      ) : (
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
          <div className="p-4">
            <div className="flex items-baseline justify-between mb-3">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">
                  {scan!.sites.length} site{scan!.sites.length === 1 ? "" : "s"} found
                </h2>
                <p className="text-xs text-gray-600">
                  Found in {scan!.tools.join(" and ")}. Nothing is imported because it was found —
                  choose what you want.
                </p>
              </div>
              <button
                onClick={() => void runImport()}
                disabled={busy || selected.length === 0}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-40"
              >
                <ArrowRightCircleIcon className="h-4 w-4" />
                Import {selected.length > 0 ? `${selected.length} site${selected.length === 1 ? "" : "s"}` : ""}
              </button>
            </div>

            <div className="divide-y divide-gray-100 border border-gray-200 rounded-lg">
              {scan!.sites.map((s: FoundSite) => (
                <label
                  key={s.domain + s.path}
                  className={clsx(
                    "flex items-start gap-3 px-3 py-3",
                    s.importable ? "cursor-pointer hover:bg-gray-50" : "opacity-60",
                  )}
                >
                  <input
                    type="checkbox"
                    disabled={!s.importable}
                    checked={!!chosen[s.domain]}
                    onChange={(e) =>
                      setChosen((p) => ({ ...p, [s.domain]: e.target.checked }))
                    }
                    className="mt-0.5 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-semibold text-gray-900">{s.domain}</span>
                      <span className="text-[10px] font-medium bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded">
                        {s.source}
                      </span>
                      {s.is_wordpress && (
                        <span className="text-[10px] font-medium bg-blue-100 text-blue-800 px-1.5 py-0.5 rounded">
                          WORDPRESS
                        </span>
                      )}
                      {s.php_minor && (
                        <span className="text-[10px] text-gray-500">PHP {s.php_minor}</span>
                      )}
                    </div>
                    <p className="text-[11px] font-mono text-gray-500 break-all">{s.path}</p>
                    {s.aliases.length > 0 && (
                      <p className="text-[11px] text-gray-500 mt-0.5">
                        Also answers on {s.aliases.join(", ")} — one site, not{" "}
                        {s.aliases.length + 1}.
                      </p>
                    )}
                    {s.note && <p className="text-[11px] text-amber-700 mt-0.5">{s.note}</p>}
                  </div>
                </label>
              ))}
            </div>

            <p className="mt-3 text-[11px] leading-relaxed text-gray-500">
              Sites import as <em>linked</em>, so your code never moves. Copy their databases
              below. Tool-level Herd configuration — parked directories, custom drivers, per-tool
              extensions — is worth reviewing by hand.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
