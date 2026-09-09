import { useState } from "react";
import {
  ArrowPathIcon,
  GlobeAltIcon,
  StopIcon,
  ClipboardIcon,
  ExclamationTriangleIcon,
} from "@heroicons/react/24/outline";
import clsx from "clsx";
import { api, errorText, hasBackend } from "../../lib/api";
import { useAsync } from "../../lib/useAsync";

export default function ExposeTab() {
  const { data: st, error, loading, reload } = useAsync(() => api.tunnelStatus(), []);
  const { data: sites } = useAsync(() => api.siteList(), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

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

  const open = st?.tunnels ?? [];
  const q = filter.trim().toLowerCase();
  const visible = q
    ? open.filter(
        (t) => t.domain.toLowerCase().includes(q) || t.public_url.toLowerCase().includes(q),
      )
    : open;
  const hidden = open.length - visible.length;

  return (
    <div className="max-w-6xl mx-auto p-4 space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Expose</h1>
          <p className="text-xs text-gray-600">
            Give a local site a public HTTPS URL, for a client review or a webhook.
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

      {!st?.installed ? (
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4 flex items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-gray-900">cloudflared is not installed</h2>
            <p className="text-xs text-gray-600">
              Tunnels are outbound-only: nothing listens on your machine and no port is opened.
            </p>
          </div>
          <button
            onClick={() => void act("install", api.tunnelInstall)}
            disabled={busy !== null}
            className="px-4 py-2 text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50"
          >
            {busy === "install" ? "Installing…" : "Install"}
          </button>
        </div>
      ) : (
        <>
          {open.length > 0 && (
            <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
              <div className="flex items-center justify-between gap-3 mb-3">
                <h2 className="text-sm font-semibold text-gray-900">
                  {open.length} site{open.length === 1 ? "" : "s"} shared publicly
                </h2>
                <input
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Search name or URL…"
                  className="px-3 py-1.5 border border-gray-300 rounded-md text-xs focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                />
              </div>

              {hidden > 0 && (
                <div className="mb-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 flex items-start gap-2">
                  <ExclamationTriangleIcon className="h-4 w-4 text-amber-700 flex-shrink-0 mt-0.5" />
                  <p className="text-[11px] text-amber-900">
                    {hidden} shared site{hidden === 1 ? " is" : "s are"} hidden by this filter —
                    still public until you stop sharing.
                  </p>
                </div>
              )}

              <div className="divide-y divide-gray-100 border border-gray-200 rounded-lg">
                {visible.map((t) => (
                  <div key={t.domain} className="flex items-center justify-between px-3 py-2 gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-gray-900 truncate">{t.domain}</p>
                      <p className="text-[11px] font-mono text-blue-700 truncate">{t.public_url}</p>
                      <p className="text-[10px] text-gray-500">
                        {t.expires_at
                          ? `started from the CLI · closes in ${Math.max(
                              0,
                              Math.round((t.expires_at - Date.now() / 1000) / 60),
                            )} min`
                          : "closes when QuickWP quits"}
                      </p>
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <button
                        title="Copy the public URL"
                        onClick={() => void navigator.clipboard?.writeText(t.public_url)}
                        className="p-1.5 rounded-md border border-gray-300 text-gray-700 hover:bg-gray-50"
                      >
                        <ClipboardIcon className="h-3.5 w-3.5" />
                      </button>
                      <button
                        title="Stop sharing"
                        onClick={() => void act(t.domain, () => api.tunnelStop(t.domain))}
                        disabled={busy !== null}
                        className="p-1.5 rounded-md border border-gray-300 text-gray-700 hover:bg-red-50 hover:text-red-700 disabled:opacity-50"
                      >
                        <StopIcon className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
            <h2 className="text-sm font-semibold text-gray-900 mb-3">Share a site</h2>
            {(sites ?? []).length === 0 ? (
              <p className="text-xs text-gray-500">Create a site first.</p>
            ) : (
              <div className="divide-y divide-gray-100 border border-gray-200 rounded-lg">
                {(sites ?? [])
                  .filter((s) => !open.some((t) => t.domain === s.domain))
                  .map((s) => (
                    <div key={s.id} className="flex items-center justify-between px-3 py-2 gap-3">
                      <span className="text-sm text-gray-900 truncate">{s.domain}</span>
                      <button
                        onClick={() => void act(s.domain, () => api.tunnelStart(s.domain))}
                        disabled={busy !== null}
                        className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-md border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50 flex-shrink-0"
                      >
                        <GlobeAltIcon className="h-3.5 w-3.5" />
                        {busy === s.domain ? "Opening…" : "Share"}
                      </button>
                    </div>
                  ))}
              </div>
            )}
          </div>
        </>
      )}

      <p className="text-[11px] leading-relaxed text-gray-500 max-w-3xl">
        <strong>Every share is guarded.</strong> A small guard process watches whatever started
        the share and closes it the moment that goes — a crash included, because macOS cannot
        signal a child when its parent dies, so the guard polls and matches on the owner's start
        time as well as its pid. A share started from the CLI has no window to close, so it
        carries a deadline the guard enforces. QuickWP also sweeps on launch: a tunnel left
        running by a previous crash is found and closed. Every share is written to the app log.
      </p>
    </div>
  );
}
