import { useEffect, useState } from "react";
import {
  ArrowPathIcon,
  ArrowTopRightOnSquareIcon,
  CircleStackIcon,
  PlayIcon,
  StopIcon,
  TableCellsIcon,
} from "@heroicons/react/24/outline";
import clsx from "clsx";
import { api, errorText, EngineStatus, hasBackend, InstallProgress } from "../../lib/api";
import { useAsync } from "../../lib/useAsync";
import ConfirmDialog from "../ui/ConfirmDialog";

/**
 * The databases Nexora runs, and Adminer, which browses them.
 *
 * One section rather than an engine list beside a MySQL list: from here there
 * is one question -- what is running, on which port, and how to look inside.
 */
export default function ServicesTab() {
  const { data: engines, error, loading, reload } = useAsync(() => api.dbList(), []);
  const { data: adminer, reload: reloadAdminer } = useAsync(() => api.adminerStatus(), []);
  /** The series picked in the dropdown, waiting on "Switch". */
  const [switching, setSwitching] = useState<EngineStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [progress, setProgress] = useState<(InstallProgress & { id: string }) | null>(null);

  useEffect(() => {
    let un: (() => void) | undefined;
    void api.onDownloadProgress(setProgress).then((f) => {
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
      await Promise.all([reload(), reloadAdminer()]);
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
        Run <code className="rounded bg-gray-100 px-1">npm run tauri dev</code> to see the
        databases.
      </p>
    );
  }

  const list = engines ?? [];
  const running = list.find((e) => e.running);
  /** What the picker shows: what is running, else what is installed. */
  const current = running ?? list.find((e) => e.installed) ?? list[0];

  /** Only one series can run: they share the port. */
  const switchTo = async (target: EngineStatus) => {
    await act(target.series, async () => {
      for (const e of list) if (e.running && e.series !== target.series) await api.dbStop(e.series);
      if (!target.installed) await api.dbInstall(target.series);
      await api.dbStart(target.series);
      return `MySQL ${target.version} is running.`;
    });
  };

  return (
    <div className="p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-semibold text-gray-900">Database</h2>
          <p className="mt-0.5 font-mono text-xs text-gray-500">
            {list.filter((e) => e.running).length}/{list.length} running
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
        <p className="mb-3 whitespace-pre-wrap break-words rounded-sm border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900">
          {notice}
        </p>
      )}
      {error && (
        <p className="mb-3 rounded-sm border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-900">
          {error}
        </p>
      )}
      {progress && (
        <div className="mb-3 rounded-sm border border-gray-200 bg-white px-3 py-2.5">
          <div className="mb-2 flex items-center justify-between text-xs text-gray-700">
            <span>{progress.component}</span>
            <span className="tabular-nums">
              {(progress.received / 1048576).toFixed(0)} MB
              {progress.total ? ` / ${(progress.total / 1048576).toFixed(0)} MB` : ""}
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-200">
            {/* No content-length means no honest percentage. */}
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
      )}

      <ul className="divide-y divide-gray-100 rounded-sm border border-gray-200">
        {current && (
          <Engine
            engine={current}
            others={list}
            busy={busy}
            onPick={(series) => {
              const target = list.find((e) => e.series === series);
              if (target && target.series !== current.series) setSwitching(target);
            }}
            onInstall={() => void act(current.series, () => api.dbInstall(current.series))}
            onStart={() => void act(current.series, () => api.dbStart(current.series))}
            onStop={() => void act(current.series, () => api.dbStop(current.series))}
            onBrowse={() => void act(`browse:${current.series}`, () => api.dbBrowse())}
          />
        )}
        {list.length === 0 && (
          <li className="px-3 py-6 text-center text-xs text-gray-500">
            {loading ? "Loading…" : "No database engine found."}
          </li>
        )}
      </ul>

      {/* What browses them, kept with them. */}
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-sm border border-gray-200 px-3 py-2.5">
        <TableCellsIcon className="h-4 w-4 flex-shrink-0 text-gray-400" />
        <span className="text-[13px] font-semibold text-gray-900">Adminer</span>
        <span className="font-mono text-xs text-gray-400">
          {adminer?.version ?? adminer?.latest ?? ""}
        </span>
        <span className="ml-auto text-xs text-gray-500">
          {!adminer ? null : !adminer.installed ? (
            <button
              onClick={() => void act("adminer", () => api.setupInstallAdminer())}
              disabled={busy !== null}
              className="font-medium text-wp-blue transition-colors hover:text-wp-blue/80 disabled:opacity-50"
            >
              {busy === "adminer" ? "Installing…" : "Install"}
            </button>
          ) : adminer.update_available ? (
            <button
              onClick={() => void act("adminer", () => api.adminerUpdate())}
              disabled={busy !== null}
              className="font-medium text-wp-blue transition-colors hover:text-wp-blue/80 disabled:opacity-50"
            >
              {busy === "adminer" ? "Updating…" : `Update to ${adminer.latest}`}
            </button>
          ) : running ? (
            "Ready"
          ) : (
            "Start MySQL to browse"
          )}
        </span>
      </div>

      <ConfirmDialog
        open={switching !== null}
        title={`Switch MySQL to ${switching?.version}?`}
        confirmLabel="Switch"
        destructive={false}
        busy={busy === switching?.series}
        body={
          <>
            Each version keeps its own data directory: databases created on {current?.version}{" "}
            stay with {current?.version} and are not visible on {switching?.version} (export them
            first to move them). MySQL restarts on {switching?.version} now.
          </>
        }
        onCancel={() => setSwitching(null)}
        onConfirm={() => {
          const target = switching;
          setSwitching(null);
          if (target) void switchTo(target);
        }}
      />

      <p className="mt-3 text-[11px] leading-relaxed text-gray-500">
        Each series keeps its own data directory, so starting 8.0 after 8.4 runs it against its
        own data — it is not a migration. MySQL is the only engine with an official macOS build to
        pin: MariaDB and PostgreSQL publish none, so offering them means building and verifying
        our own, which is not done yet.
      </p>
    </div>
  );
}

function Engine({
  engine,
  others,
  busy,
  onPick,
  onInstall,
  onStart,
  onStop,
  onBrowse,
}: {
  engine: EngineStatus;
  /** Every series of this engine, for the picker. */
  others: EngineStatus[];
  busy: string | null;
  onPick: (series: string) => void;
  onInstall: () => void;
  onStart: () => void;
  onStop: () => void;
  onBrowse: () => void;
}) {
  const working = busy === engine.series;
  return (
    <li className="flex items-center gap-2.5 px-3 py-2.5">
      <span className="grid h-8 w-8 flex-shrink-0 place-items-center rounded-sm border border-gray-200 bg-gray-50 text-gray-500">
        <CircleStackIcon className="h-4 w-4" />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-semibold text-gray-900">MySQL</span>
          {/* One row, every version on the picker: they share a port, so only
              one of them can be the one running. */}
          <select
            aria-label="MySQL version"
            value={engine.series}
            disabled={busy !== null}
            onChange={(e) => onPick(e.target.value)}
            className="w-[5.5rem] flex-shrink-0 rounded-sm border border-gray-300 bg-white py-0.5 pl-1.5 pr-5 font-mono text-[11px] text-gray-700 focus:border-wp-blue focus:outline-none focus:ring-1 focus:ring-wp-blue disabled:opacity-50"
          >
            {others.map((o) => (
              <option key={o.series} value={o.series}>
                {o.version}
                {o.installed ? "" : " (not installed)"}
              </option>
            ))}
          </select>
        </div>
        <p className="mt-0.5 truncate font-mono text-[11px] text-gray-500">127.0.0.1:{engine.port}</p>
      </div>

      <span
        className={clsx(
          "inline-flex flex-shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium",
          engine.running ? "bg-green-50 text-green-800" : "bg-gray-100 text-gray-600",
        )}
      >
        <span
          className={clsx(
            "h-1.5 w-1.5 rounded-full",
            engine.running ? "bg-green-500" : "bg-gray-400",
          )}
        />
        {engine.running ? "Running" : engine.installed ? "Stopped" : "Not installed"}
      </span>

      <div className="flex flex-shrink-0 items-center gap-2">
        {!engine.installed ? (
          <button
            onClick={onInstall}
            disabled={busy !== null}
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-sm border border-gray-300 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50"
          >
            {working ? (
              <>
                <ArrowPathIcon className="h-3.5 w-3.5 animate-spin" />
                Downloading
              </>
            ) : (
              "Install"
            )}
          </button>
        ) : engine.running ? (
          <>
            <button
              onClick={onBrowse}
              disabled={busy !== null}
              className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-sm border border-gray-300 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50"
            >
              <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5" />
              Browse
            </button>
            <button
              title="Stop"
              aria-label={`Stop MySQL ${engine.series}`}
              onClick={onStop}
              disabled={busy !== null}
              className="rounded-sm border border-gray-300 bg-white p-1 text-gray-600 transition-colors hover:bg-gray-50 disabled:opacity-50"
            >
              <StopIcon className="h-3.5 w-3.5" />
            </button>
          </>
        ) : (
          <button
            onClick={onStart}
            disabled={busy !== null}
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-sm border border-gray-300 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50"
          >
            <PlayIcon className="h-3.5 w-3.5" />
            {working ? "Starting…" : `Start ${engine.series}`}
          </button>
        )}
      </div>
    </li>
  );
}
