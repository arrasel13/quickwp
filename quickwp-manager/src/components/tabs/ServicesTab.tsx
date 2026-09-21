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
import type { ReactNode } from "react";
import {
  api,
  errorText,
  EngineStatus,
  hasBackend,
  InstallProgress,
  type MariadbStatus,
  type ServiceUpdate,
} from "../../lib/api";
import { useAsync } from "../../lib/useAsync";
import {
  isPast,
  monthYear,
  MYSQL_SUPPORT,
  type ServiceUpdates,
} from "../../lib/serviceUpdates";
import ConfirmDialog from "../ui/ConfirmDialog";

/**
 * The databases Nexora runs, and Adminer, which browses them.
 *
 * One section rather than an engine list beside a MySQL list: from here there
 * is one question -- what is running, on which port, and how to look inside.
 */
export default function ServicesTab({ updates }: { updates?: ServiceUpdates }) {
  const { data: engines, error, loading, reload } = useAsync(() => api.dbList(), []);
  const { data: maria, reload: reloadMaria } = useAsync(() => api.mariadbList(), []);
  const { data: adminer, reload: reloadAdminer } = useAsync(() => api.adminerStatus(), []);
  /** The series picked in a dropdown, waiting on "Switch". */
  const [switching, setSwitching] = useState<{ from: EngineStatus; to: EngineStatus } | null>(null);
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
      await Promise.all([reload(), reloadMaria(), reloadAdminer()]);
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
  const mariaList: MariadbStatus[] = maria ?? [];
  /** What a picker shows: what is running, else what is installed, else the
   *  newest that can be installed at all. */
  const pick = <T extends EngineStatus>(series: T[], canInstall: (e: T) => boolean = () => true) =>
    series.find((e) => e.running) ??
    series.find((e) => e.installed) ??
    series.find(canInstall) ??
    series[0];
  const current = pick(list);
  const mariaCurrent = pick(mariaList, (e) => e.available);
  const applyUpdate = (u: ServiceUpdate) =>
    void updates?.apply(u).then(() => Promise.all([reload(), reloadMaria(), reloadAdminer()]));
  const running = list.find((e) => e.running) ?? mariaList.find((e) => e.running);
  const nameOf = (e: EngineStatus) => (e.engine === "mariadb" ? "MariaDB" : "MySQL");

  /** Only one series of an engine runs at a time: they share its port. */
  const switchTo = async (target: EngineStatus) => {
    await act(target.series, async () => {
      if (target.engine === "mariadb") {
        // Starting one MariaDB series stops the other itself.
        if (!target.installed) await api.mariadbInstall(target.series);
        await api.mariadbStart(target.series);
        // Before it was installed, its version was only a label.
        const now = (await api.mariadbList()).find((e) => e.series === target.series);
        return `MariaDB ${now?.version ?? target.version} is running.`;
      } else {
        for (const e of list) if (e.running && e.series !== target.series) await api.dbStop(e.series);
        if (!target.installed) await api.dbInstall(target.series);
        await api.dbStart(target.series);
      }
      return `${nameOf(target)} ${target.version} is running.`;
    });
  };

  return (
    <div className="p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-semibold text-gray-900">Database</h2>
          <p className="mt-0.5 font-mono text-xs text-gray-500">
            {[current, mariaCurrent].filter((e) => e?.running).length}/
            {[current, mariaCurrent].filter(Boolean).length} running
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
            name="MySQL"
            engine={current}
            others={list}
            busy={busy}
            option={(o) => {
              const s = MYSQL_SUPPORT[o.series];
              const tag = !s ? "" : isPast(s.ends) ? " · EOL" : s.lts ? " · LTS" : "";
              return `${o.version}${tag}${o.installed ? "" : " (not installed)"}`;
            }}
            update={updates?.find("mysql", current.series) ?? null}
            applying={updates?.applying === `mysql:${current.series}`}
            onUpdate={applyUpdate}
            support={<Support engine={current} onUpgrade={() => {
              const target = list.find((e) => e.series === "8.4");
              if (target) setSwitching({ from: current, to: target });
            }} />}
            onPick={(series) => {
              const target = list.find((e) => e.series === series);
              if (target && target.series !== current.series) setSwitching({ from: current, to: target });
            }}
            onInstall={() => void act(current.series, () => api.dbInstall(current.series))}
            onStart={() => void act(current.series, () => api.dbStart(current.series))}
            onStop={() => void act(current.series, () => api.dbStop(current.series))}
            onBrowse={() => void act(`browse:${current.series}`, () => api.dbBrowse())}
          />
        )}
        {mariaCurrent && (
          <Engine
            name="MariaDB"
            engine={mariaCurrent}
            others={mariaList}
            busy={busy}
            installHint="Installs from Homebrew, then starts"
            startInstalls
            option={(o) => {
              const m = o as MariadbStatus;
              if (!m.available) return `${m.version} · LTS (not in Homebrew yet)`;
              return `${m.version}${m.eol ? " · LTS" : ""}${m.installed ? "" : " (not installed)"}`;
            }}
            disabledOption={(o) => !(o as MariadbStatus).available}
            update={updates?.find("mariadb", mariaCurrent.series) ?? null}
            applying={updates?.applying === `mariadb:${mariaCurrent.series}`}
            onUpdate={applyUpdate}
            support={<Support engine={mariaCurrent} />}
            onPick={(series) => {
              const target = mariaList.find((e) => e.series === series);
              if (target && target.series !== mariaCurrent.series)
                setSwitching({ from: mariaCurrent, to: target });
            }}
            onInstall={() =>
              void act(mariaCurrent.series, () => api.mariadbInstall(mariaCurrent.series))
            }
            onStart={() =>
              void act(mariaCurrent.series, async () => {
                await api.mariadbStart(mariaCurrent.series);
                return `MariaDB is running on port ${mariaCurrent.port}.`;
              })
            }
            onStop={() => void act(mariaCurrent.series, () => api.mariadbStop(mariaCurrent.series))}
            onBrowse={() =>
              void act(`browse:${mariaCurrent.series}`, () => api.dbBrowse(mariaCurrent.series))
            }
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
        title={`Switch ${switching ? nameOf(switching.to) : ""} to ${switching?.to.version}?`}
        confirmLabel="Switch"
        destructive={false}
        busy={busy === switching?.to.series}
        body={
          <>
            Each version keeps its own data directory: databases created on{" "}
            {switching?.from.version} stay with {switching?.from.version} and are not visible on{" "}
            {switching?.to.version} (export them first to move them).{" "}
            {switching ? nameOf(switching.to) : ""}{" "}
            {switching?.to.installed ? "restarts" : "is installed, then starts"} on{" "}
            {switching?.to.version} now.
            {switching && supportOf(switching.to) && (
              <span className="mt-2 block">
                {nameOf(switching.to)} {switching.to.version}:{" "}
                {supportOf(switching.to)!.eol
                  ? `end of life since ${monthYear(supportOf(switching.to)!.ends)}.`
                  : `${supportOf(switching.to)!.lts ? "LTS, " : ""}supported until ${monthYear(supportOf(switching.to)!.ends)}.`}
              </span>
            )}
          </>
        }
        onCancel={() => setSwitching(null)}
        onConfirm={() => {
          const target = switching?.to;
          setSwitching(null);
          if (target) void switchTo(target);
        }}
      />

      <p className="mt-3 text-[11px] leading-relaxed text-gray-500">
        Each version keeps its own data directory, so switching runs the other one against its own
        data — it is not a migration. MySQL comes from its vendor's official macOS builds. MariaDB
        publishes none, so it comes from Homebrew, and runs here against a data directory and a
        port (13317) of Nexora's own. New sites still use MySQL.
      </p>
    </div>
  );
}

function Engine({
  name,
  engine,
  others,
  busy,
  installHint,
  startInstalls,
  option,
  disabledOption,
  support,
  update,
  applying,
  onUpdate,
  onPick,
  onInstall,
  onStart,
  onStop,
  onBrowse,
}: {
  name: string;
  engine: EngineStatus;
  /** Every series of this engine, for the picker. */
  others: EngineStatus[];
  busy: string | null;
  /** Said on the Install button, when installing is slower than a download. */
  installHint?: string;
  /** Start installs first, so a missing series offers Start, not Install. */
  startInstalls?: boolean;
  /** How a series reads in the picker. */
  option: (o: EngineStatus) => string;
  disabledOption?: (o: EngineStatus) => boolean;
  /** Beside the address: the selected version's support window. */
  support?: ReactNode;
  update: ServiceUpdate | null;
  applying: boolean;
  onUpdate: (u: ServiceUpdate) => void;
  onPick: (series: string) => void;
  onInstall: () => void;
  onStart: () => void;
  onStop: () => void;
  onBrowse: () => void;
}) {
  const working = busy === engine.series;
  return (
    <li className="px-3 py-2.5">
      <div className="flex items-center gap-2.5">
      <span className="grid h-8 w-8 flex-shrink-0 place-items-center rounded-sm border border-gray-200 bg-gray-50 text-gray-500">
        <CircleStackIcon className="h-4 w-4" />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-semibold text-gray-900">{name}</span>
          {/* One row, every version on the picker: they share a port, so only
              one of them can be the one running. */}
          <select
            aria-label={`${name} version`}
            value={engine.series}
            disabled={busy !== null}
            onChange={(e) => onPick(e.target.value)}
            className="w-auto max-w-[9.5rem] min-w-0 truncate rounded-sm border border-gray-300 bg-white py-0.5 pl-1.5 pr-6 font-mono text-[11px] text-gray-700 focus:border-wp-blue focus:outline-none focus:ring-1 focus:ring-wp-blue disabled:opacity-50"
          >
            {others.map((o) => (
              <option key={o.series} value={o.series} disabled={disabledOption?.(o)}>
                {option(o)}
              </option>
            ))}
          </select>
        </div>
        <p className="mt-0.5 truncate text-[11px] text-gray-500">
          <span className="font-mono">127.0.0.1:{engine.port}</span>
          {support && <> {support}</>}
        </p>
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
        {update ? (
          <button
            onClick={() => onUpdate(update)}
            disabled={applying || busy !== null}
            title={`Installed ${update.installed}`}
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-sm bg-amber-500 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-amber-600 disabled:opacity-50"
          >
            <ArrowPathIcon className={clsx("h-3.5 w-3.5", applying && "animate-spin")} />
            Update to {update.latest}
          </button>
        ) : null}
        {!engine.installed && startInstalls ? (
          <button
            onClick={onStart}
            title={installHint}
            disabled={busy !== null || disabledOption?.(engine)}
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-sm border border-gray-300 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50"
          >
            {working ? (
              <>
                <ArrowPathIcon className="h-3.5 w-3.5 animate-spin" />
                Installing…
              </>
            ) : (
              <>
                <PlayIcon className="h-3.5 w-3.5" />
                Start
              </>
            )}
          </button>
        ) : !engine.installed ? (
          <button
            onClick={onInstall}
            title={installHint}
            disabled={busy !== null}
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-sm border border-gray-300 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50"
          >
            {working ? (
              <>
                <ArrowPathIcon className="h-3.5 w-3.5 animate-spin" />
                Installing
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
              aria-label={`Stop ${name} ${engine.version}`}
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
            {working ? "Starting…" : "Start"}
          </button>
        )}
      </div>
      </div>
    </li>
  );
}

/** "Feb 2030", to fit beside the address. */
function shortMonthYear(date: string): string {
  const d = new Date(`${date}T00:00:00`);
  return Number.isNaN(d.getTime()) ? date : d.toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

/** How long a MySQL or MariaDB series is supported, when that is known. */
function supportOf(e: EngineStatus): { lts: boolean; ends: string; eol: boolean } | null {
  const m = e as MariadbStatus;
  const s = e.engine === "mariadb" ? (m.eol ? { lts: true, ends: m.eol } : null) : MYSQL_SUPPORT[e.series];
  return s ? { ...s, eol: isPast(s.ends) } : null;
}

/**
 * "(LTS, until April 2032)" beside the address, for whichever version is
 * selected; a line that has ended says so, with the way off it.
 */
function Support({ engine, onUpgrade }: { engine: EngineStatus; onUpgrade?: () => void }) {
  const s = supportOf(engine);
  if (!s) return null;
  if (s.eol) {
    return (
      <span className="text-amber-800">
        (EOL {shortMonthYear(s.ends)}
        {onUpgrade && (
          <>
            {" · "}
            <button onClick={onUpgrade} className="font-medium underline underline-offset-2 hover:no-underline">
              switch to 8.4 LTS
            </button>
          </>
        )}
        )
      </span>
    );
  }
  return <span title={`Supported until ${monthYear(s.ends)}`}>({s.lts ? "LTS, " : ""}until {shortMonthYear(s.ends)})</span>;
}
