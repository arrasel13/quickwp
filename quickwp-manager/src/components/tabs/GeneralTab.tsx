import { useState } from "react";
import {
  PlayIcon,
  StopIcon,
  ArrowPathIcon,
  CheckCircleIcon,
  InformationCircleIcon,
  ExclamationTriangleIcon,
  FolderOpenIcon,
} from "@heroicons/react/24/outline";
import clsx from "clsx";
import { api, errorText, hasBackend, Finding } from "../../lib/api";
import { useAsync } from "../../lib/useAsync";

const LEVEL_STYLE: Record<string, { ring: string; icon: typeof CheckCircleIcon; tone: string }> = {
  ok: { ring: "border-green-200 bg-green-50", icon: CheckCircleIcon, tone: "text-green-700" },
  info: { ring: "border-blue-200 bg-blue-50", icon: InformationCircleIcon, tone: "text-blue-700" },
  warn: { ring: "border-amber-200 bg-amber-50", icon: ExclamationTriangleIcon, tone: "text-amber-700" },
  error: { ring: "border-red-200 bg-red-50", icon: ExclamationTriangleIcon, tone: "text-red-700" },
};

export default function GeneralTab() {
  const { data: status, error, loading, reload } = useAsync(() => api.stackStatus(), []);
  const { data: settings, reload: reloadSettings } = useAsync(() => api.settingsGet(), []);
  const { data: findings, reload: reloadDoctor } = useAsync(() => api.doctor(), []);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const refreshAll = async () => {
    await Promise.all([reload(), reloadSettings(), reloadDoctor()]);
  };

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setNotice(null);
    try {
      const r = await fn();
      if (typeof r === "string") setNotice(r);
      await refreshAll();
    } catch (e) {
      setNotice(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  if (!hasBackend) {
    return (
      <div className="max-w-6xl mx-auto p-6">
        <div className="border border-amber-200 bg-amber-50 rounded-lg p-5 max-w-xl">
          <h2 className="text-sm font-semibold text-amber-900 mb-1">No backend behind this window</h2>
          <p className="text-xs text-amber-800 leading-relaxed">
            Run <code className="bg-amber-100 px-1 rounded">npm run tauri dev</code> to start the
            desktop app with its Rust backend.
          </p>
        </div>
      </div>
    );
  }

  const running = status?.edge_running ?? false;

  return (
    <div className="max-w-6xl mx-auto p-4 space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">General</h1>
          <p className="text-xs text-gray-600">The stack, and where everything lives.</p>
        </div>
        <button
          onClick={() => void refreshAll()}
          disabled={loading}
          className="inline-flex items-center px-3 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50"
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

      {/* stack */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <span
              className={clsx(
                "h-2.5 w-2.5 rounded-full",
                running ? "bg-green-500" : "bg-gray-300",
              )}
            />
            <div>
              <h2 className="text-sm font-semibold text-gray-900">
                {running ? "Serving" : "Stopped"}
              </h2>
              <p className="text-xs text-gray-600 tabular-nums">
                {running
                  ? `Edge on 127.0.0.1:${status?.edge_port} · ${status?.site_count ?? 0} site(s) · .${status?.tld ?? "test"}`
                  : "Nothing is listening."}
              </p>
            </div>
          </div>
          <button
            onClick={() => void act(running ? api.stackStop : api.stackStart)}
            disabled={busy}
            className={clsx(
              "inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-md text-white disabled:opacity-50",
              running ? "bg-gray-700 hover:bg-gray-800" : "bg-blue-600 hover:bg-blue-700",
            )}
          >
            {running ? <StopIcon className="h-4 w-4" /> : <PlayIcon className="h-4 w-4" />}
            {running ? "Stop all" : "Start all"}
          </button>
        </div>

        {(status?.pools?.length ?? 0) > 0 && (
          <div className="mt-4 border-t border-gray-100 pt-3">
            <h3 className="text-[10px] font-semibold uppercase tracking-wider text-gray-500 mb-2">
              PHP pools
            </h3>
            <div className="flex flex-wrap gap-2">
              {status!.pools.map((p) => (
                <span
                  key={p.name}
                  className={clsx(
                    "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs",
                    p.running
                      ? "border-green-200 bg-green-50 text-green-800"
                      : "border-gray-200 bg-gray-50 text-gray-500",
                  )}
                >
                  <span
                    className={clsx(
                      "h-1.5 w-1.5 rounded-full",
                      p.running ? "bg-green-500" : "bg-gray-300",
                    )}
                  />
                  <span className="font-mono">{p.name.replace("php-fpm-", "PHP ")}</span>
                  {p.port && <span className="tabular-nums text-[10px] opacity-70">:{p.port}</span>}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* doctor */}
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
          <h2 className="text-sm font-semibold text-gray-900 mb-1">Diagnostics</h2>
          <p className="text-xs text-gray-600 mb-3">
            What is actually true right now — ports, and anything already claiming a TLD.
          </p>
          <div className="space-y-2">
            {(findings ?? []).map((f: Finding, i: number) => {
              const s = LEVEL_STYLE[f.level] ?? LEVEL_STYLE.info;
              const Icon = s.icon;
              return (
                <div key={i} className={clsx("rounded-lg border p-3", s.ring)}>
                  <div className="flex items-start gap-2">
                    <Icon className={clsx("h-4 w-4 flex-shrink-0 mt-0.5", s.tone)} />
                    <div className="min-w-0">
                      <h3 className="text-xs font-semibold text-gray-900">{f.title}</h3>
                      <p className="text-xs text-gray-700 leading-relaxed break-words">{f.detail}</p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* where things live */}
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
          <h2 className="text-sm font-semibold text-gray-900 mb-1">Where things live</h2>
          <p className="text-xs text-gray-600 mb-3">
            One directory holds your sites, the downloaded runtimes and the logs.
          </p>
          <dl className="space-y-2 text-xs">
            {[
              ["Data directory", settings?.root],
              ["Sites", settings?.sites_dir],
              ["Logs", settings?.logs_dir],
            ].map(([label, value]) => (
              <div key={label as string} className="border border-gray-200 rounded-lg px-3 py-2">
                <dt className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                  {label}
                </dt>
                <dd className="font-mono text-[11px] text-gray-800 break-all">{value ?? "—"}</dd>
              </div>
            ))}
          </dl>

          <div className="mt-3 flex items-center gap-2">
            <button
              onClick={() => {
                if (settings?.root) void api.siteOpen("").catch(() => {});
              }}
              className="hidden"
            />
            <span className="inline-flex items-center gap-1.5 text-[11px] text-gray-500">
              <FolderOpenIcon className="h-3.5 w-3.5" />
              Default TLD is <code className="bg-gray-100 px-1 rounded">.{settings?.tld ?? "test"}</code>,
              default PHP is {settings?.default_php ?? "—"}
            </span>
          </div>
        </div>
      </div>

      <p className="text-[11px] text-gray-500 leading-relaxed max-w-3xl">
        Sites are reachable through the edge on port {status?.edge_port ?? 18089}. A trusted{" "}
        <code className="bg-gray-100 px-1 rounded">https://name.{settings?.tld ?? "test"}</code> with
        no port number needs the DNS resolver, the local certificate authority and the privileged
        edge — those are the next things to build, and each asks for permission once.
      </p>
    </div>
  );
}
