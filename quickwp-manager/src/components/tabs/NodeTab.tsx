import { useEffect, useState } from "react";
import {
  ArrowDownTrayIcon,
  ArrowPathIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import clsx from "clsx";
import { api, errorText, hasBackend, InstallProgress, type NodeLine, type NodeVersion } from "../../lib/api";
import { monthYear, type ServiceUpdates } from "../../lib/serviceUpdates";
import ConfirmDialog from "../ui/ConfirmDialog";
import { useAppData } from "../../lib/appData";

/**
 * Node's supported LTS lines, which Nexora can install from nodejs.org, and
 * any Node already on this Mac from nvm, fnm, Volta, Homebrew and the like.
 */
export default function NodeTab({ updates }: { updates?: ServiceUpdates }) {
  const { data: lines, error, loading, reload } = useAppData("node-lines");
  const { data: found, reload: reloadFound } = useAppData("node-list");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [progress, setProgress] = useState<(InstallProgress & { id: string }) | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  useEffect(() => {
    let un: (() => void) | undefined;
    void api.onDownloadProgress(setProgress).then((f) => {
      un = f as () => void;
    });
    return () => un?.();
  }, []);

  const act = async (label: string, fn: () => Promise<string>) => {
    setBusy(label);
    setNotice(null);
    try {
      setNotice({ ok: true, text: await fn() });
      await Promise.all([reload(), reloadFound()]);
    } catch (e) {
      setNotice({ ok: false, text: errorText(e) });
    } finally {
      setBusy(null);
      setProgress(null);
    }
  };

  if (!hasBackend) {
    return (
      <p className="p-4 text-xs text-gray-500">
        Run <code className="rounded bg-gray-100 px-1">npm run tauri dev</code> to see Node.
      </p>
    );
  }

  // Every Node on this Mac, Nexora's own included, newest first.
  const local = [...(found ?? [])].sort((a, b) => compareVersions(b.version, a.version));
  const lineOf = (major: string) => (lines ?? []).find((l) => l.major === major);

  return (
    <div className="p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-semibold text-gray-900">Node.js</h2>
          <p className="mt-0.5 text-xs text-gray-600">
            The LTS lines Node still supports, from nodejs.org and checked against its published
            checksums. For a theme's build step; WordPress itself needs none.
          </p>
        </div>
        <button
          onClick={() => void Promise.all([reload(), reloadFound()])}
          disabled={loading}
          title="Reload"
          className="flex-shrink-0 rounded-sm border border-gray-300 bg-white p-1.5 text-gray-600 transition-colors hover:bg-gray-50 disabled:opacity-50"
        >
          <ArrowPathIcon className={clsx("h-4 w-4", loading && "animate-spin")} />
        </button>
      </div>

      {notice && (
        <p
          className={clsx(
            "mb-3 whitespace-pre-wrap break-words rounded-sm border px-3 py-2 text-xs",
            notice.ok ? "border-blue-200 bg-blue-50 text-blue-900" : "border-red-200 bg-red-50 text-red-900",
          )}
        >
          {notice.text}
        </p>
      )}
      {error && (
        <p className="mb-3 rounded-sm border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-900">
          nodejs.org could not be reached: {error}
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

      <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-gray-400">
        On this Mac
      </p>
      <ul className="mb-4 divide-y divide-gray-100 border-y border-gray-100">
        {local.map((n) => {
          const nexora = n.source === "Nexora";
          const update = nexora ? updates?.find("node", n.major) ?? null : null;
          return (
            <Local
              key={n.path}
              node={n}
              status={statusOf(n.major, lines ?? [])}
              newer={lineOf(n.major)?.latest}
              update={update}
              applying={updates?.applying === `node:${n.major}`}
              busy={busy}
              onUpdate={() => {
                if (update) void updates!.apply(update).then(() => Promise.all([reload(), reloadFound()]));
              }}
              onRemove={nexora ? () => setRemoving(n.version) : undefined}
            />
          );
        })}
        {found && local.length === 0 && (
          <li className="py-3 text-xs text-gray-500">No Node installed yet.</li>
        )}
      </ul>

      <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-gray-400">
        LTS releases
      </p>
      <ul className="divide-y divide-gray-100 border-y border-gray-100">
        {(lines ?? []).map((line) => (
          <Line
            key={line.major}
            line={line}
            busy={busy}
            present={local.some((n) => n.version === line.latest)}
            onInstall={() => void act(line.major, () => api.nodeInstall(line.latest))}
          />
        ))}
        {loading && !lines && <li className="py-6 text-center text-xs text-gray-500">Loading…</li>}
      </ul>

      <ConfirmDialog
        open={removing !== null}
        title={`Remove Node ${removing}?`}
        confirmLabel="Remove"
        body="The copy Nexora installed is deleted. A site set to use it falls back to another Node."
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          const v = removing;
          setRemoving(null);
          if (v) void act(`remove:${v}`, () => api.nodeRemove(v));
        }}
      />
    </div>
  );
}

type Status = { label: string; tone: "lts" | "maintenance" | "current" | "eol"; until?: string; title: string };

/**
 * Where a major stands: one of Node's LTS lines, a Current release newer
 * than all of them, or a line Node no longer supports.
 */
function statusOf(major: string, lines: NodeLine[]): Status | null {
  if (lines.length === 0) return null;
  const line = lines.find((l) => l.major === major);
  if (line) {
    return {
      label: `LTS${line.codename ? ` · ${line.codename}` : ""}`,
      tone: line.phase === "active" ? "lts" : "maintenance",
      until: line.end,
      title: line.phase === "active" ? "Active LTS: fixes and backports" : "Maintenance LTS: security and critical fixes only",
    };
  }
  const newest = Math.max(...lines.map((l) => Number(l.major)));
  if (Number(major) > newest) {
    return { label: "Current", tone: "current", title: "Current release: not LTS yet, for trying what is new" };
  }
  return { label: "EOL", tone: "eol", title: "Node no longer fixes this line" };
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

const TONES: Record<Status["tone"], string> = {
  lts: "border-green-200 bg-green-50 text-green-800",
  maintenance: "border-gray-200 bg-gray-50 text-gray-600",
  current: "border-blue-200 bg-blue-50 text-blue-800",
  eol: "border-amber-200 bg-amber-50 text-amber-800",
};

function Badge({ status }: { status: Status }) {
  return (
    <span title={status.title} className={clsx("rounded-full border px-2 py-0.5 text-[11px] font-medium", TONES[status.tone])}>
      {status.label}
    </span>
  );
}

/** A Node on this Mac: Nexora's own can be updated and removed here. */
function Local({
  node,
  status,
  newer,
  update,
  applying,
  busy,
  onUpdate,
  onRemove,
}: {
  node: NodeVersion;
  status: Status | null;
  /** The newest release on its LTS line, if it is on one. */
  newer?: string;
  update: { latest: string } | null;
  applying: boolean;
  busy: string | null;
  onUpdate: () => void;
  onRemove?: () => void;
}) {
  const behind = !update && newer && compareVersions(newer, node.version) > 0 ? newer : null;
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5" title={node.path}>
      <span className="h-2 w-2 flex-shrink-0 rounded-full bg-green-500" />
      <span className="font-mono text-[13px] font-semibold text-gray-900">Node {node.version}</span>
      {status && <Badge status={status} />}
      {status?.until && <span className="text-[11px] text-gray-400">until {monthYear(status.until)}</span>}
      <div className="ml-auto flex flex-shrink-0 items-center gap-3">
        {behind && (
          <span className="text-[11px] text-gray-400" title={`Update it with ${node.source}`}>
            {behind} available
          </span>
        )}
        <span className="text-[11px] text-gray-500">{node.source}</span>
        {update && (
          <button
            onClick={onUpdate}
            disabled={applying || busy !== null}
            className="inline-flex items-center gap-1.5 rounded-sm bg-amber-500 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-amber-600 disabled:opacity-50"
          >
            <ArrowPathIcon className={clsx("h-3.5 w-3.5", applying && "animate-spin")} />
            Update to {update.latest}
          </button>
        )}
        {onRemove && (
          <button
            title="Remove"
            aria-label={`Remove Node ${node.version}`}
            onClick={onRemove}
            disabled={busy !== null}
            className="rounded text-gray-400 transition-colors hover:text-red-600 disabled:opacity-40"
          >
            <TrashIcon className="h-4 w-4" />
          </button>
        )}
      </div>
    </li>
  );
}

/** An LTS line Node supports, to install its newest release. */
function Line({
  line,
  busy,
  present,
  onInstall,
}: {
  line: NodeLine;
  busy: string | null;
  /** Its newest release is already on this Mac. */
  present: boolean;
  onInstall: () => void;
}) {
  const status = statusOf(line.major, [line])!;
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5">
      <span className="font-mono text-[13px] font-semibold text-gray-900">Node {line.major}</span>
      <span className="font-mono text-[13px] text-gray-400 tabular-nums">{line.latest}</span>
      <Badge status={status} />
      <span className="text-[11px] text-gray-400">until {monthYear(line.end)}</span>
      <div className="ml-auto flex flex-shrink-0 items-center gap-3">
        {present ? (
          <span className="text-xs text-gray-500">Installed</span>
        ) : (
          <button
            onClick={onInstall}
            disabled={busy !== null}
            className="inline-flex items-center gap-1.5 rounded-sm bg-wp-blue px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-wp-blue/90 disabled:opacity-50"
          >
            {busy === line.major ? (
              <>
                <ArrowPathIcon className="h-3.5 w-3.5 animate-spin" />
                Installing
              </>
            ) : (
              <>
                <ArrowDownTrayIcon className="h-3.5 w-3.5" />
                Install {line.latest}
              </>
            )}
          </button>
        )}
      </div>
    </li>
  );
}
