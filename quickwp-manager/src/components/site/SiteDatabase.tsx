import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowPathIcon,
  ArrowTopRightOnSquareIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  DocumentDuplicateIcon,
} from "@heroicons/react/24/outline";
import clsx from "clsx";
import { api, errorText, hasBackend, Site, SiteDatabaseInfo } from "../../lib/api";
import { peekCache, putCache } from "../../lib/useAsync";

/**
 * The database behind one site: Adminer on it, and the facts about it.
 *
 * Adminer is the tab rather than a link out of it. Looking at a table is the
 * thing people came here to do, and a page that only tells you the port makes
 * you go find a client to do it with.
 *
 * One backend call gets it ready -- MySQL started if it was not, the database
 * there, Adminer's address -- and the answer is kept, so a second visit shows
 * Adminer at once while that call confirms it underneath.
 */
export default function SiteDatabase({ site }: { site: Site }) {
  const cacheKey = `site-db:${site.domain}`;
  const hasDb = Boolean(site.db_name && site.db_engine);

  const [info, setInfo] = useState<SiteDatabaseInfo | null>(
    () => peekCache<SiteDatabaseInfo>(cacheKey) ?? null,
  );
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [frameReady, setFrameReady] = useState(false);
  const [slow, setSlow] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const frameRef = useRef<HTMLIFrameElement>(null);

  const url = info?.url ?? null;

  const load = useCallback(async () => {
    if (!hasBackend || !hasDb) return;
    setLoading(true);
    setFailure(null);
    try {
      const next = await api.siteDatabase(site.domain);
      putCache(cacheKey, next);
      setInfo(next);
      setFailure(next.url ? null : next.error);
    } catch (e) {
      setFailure(errorText(e));
    } finally {
      setLoading(false);
    }
  }, [site.domain, hasDb, cacheKey]);

  useEffect(() => {
    void load();
  }, [load]);

  // A new address is a new page to wait for; the same one is left alone.
  useEffect(() => {
    setFrameReady(false);
    setSlow(false);
  }, [url]);

  // Adminer answers in well under a second. A frame still empty after a few
  // is not coming, so say so and offer the browser instead of spinning on.
  useEffect(() => {
    if (!url || frameReady) return;
    const timer = setTimeout(() => setSlow(true), 8000);
    return () => clearTimeout(timer);
  }, [url, frameReady]);

  const copy = () => {
    if (!url) return;
    void navigator.clipboard
      .writeText(url)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {
        /* a webview can refuse the clipboard; the URL is on screen regardless */
      });
  };

  const reloadFrame = () => {
    // Re-assigning src rather than calling location.reload(): the frame is a
    // different origin, so its document is not ours to touch.
    const f = frameRef.current;
    if (f && url) {
      setFrameReady(false);
      setSlow(false);
      f.src = url;
    }
  };

  const exportNow = async () => {
    if (!info) return;
    setExporting(true);
    setNote(null);
    try {
      const path = await api.dbExport(info.series, info.name);
      setNote(`Exported to ${path}`);
    } catch (e) {
      setNote(errorText(e));
    } finally {
      setExporting(false);
    }
  };

  if (!hasDb) {
    return (
      <div className="p-4">
        <div className="rounded-xl border border-gray-200 bg-white p-6 text-center shadow-sm">
          <h3 className="text-sm font-semibold text-gray-900">No database</h3>
          <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-gray-500">
            This site has no database recorded. Nexora creates one when it
            installs WordPress; a plain PHP site gets one only if you make it
            yourself.
          </p>
        </div>
      </div>
    );
  }

  const running = Boolean(info?.running);

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      {/* The address bar. Present even before Adminer is ready, so the pane
          does not change shape the moment it loads. */}
      <div className="flex flex-shrink-0 items-center gap-2 rounded-xl border border-gray-200 bg-white px-3 py-2 shadow-sm">
        <span className="flex-1 truncate font-mono text-xs text-gray-600" title={url ?? undefined}>
          {url ?? (loading ? "Starting the web server and database…" : "—")}
        </span>
        <button
          onClick={copy}
          disabled={!url}
          className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-40"
        >
          <DocumentDuplicateIcon className="h-3.5 w-3.5" />
          {copied ? "Copied" : "Copy"}
        </button>
        <button
          onClick={reloadFrame}
          disabled={!url}
          title="Reload"
          className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-40"
        >
          <ArrowPathIcon className="h-3.5 w-3.5" />
          Reload
        </button>
        <button
          onClick={() => void api.siteAdminerOpen(site.domain).catch((e) => setFailure(errorText(e)))}
          disabled={!url}
          className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-40"
        >
          <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5" />
          Open in browser
        </button>
      </div>

      {/* Adminer itself. */}
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
        {url && (
          <iframe
            ref={frameRef}
            src={url}
            title={`Adminer — ${site.db_name}`}
            onLoad={() => setFrameReady(true)}
            className="h-full w-full border-0"
          />
        )}

        {/* Over the frame until its first page arrives, so the wait reads as
            loading rather than as a blank box. */}
        {(!url || !frameReady) && (
          <div className="absolute inset-0 flex items-center justify-center bg-white p-6">
            {failure && !url ? (
              <div className="max-w-sm text-center">
                <h3 className="text-sm font-semibold text-gray-900">The database did not open</h3>
                <p className="mt-1 break-words text-xs leading-relaxed text-gray-500">{failure}</p>
                <button
                  onClick={() => void load()}
                  disabled={loading}
                  className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60"
                >
                  <ArrowPathIcon className={clsx("h-4 w-4", loading && "animate-spin")} />
                  Try again
                </button>
              </div>
            ) : url && slow ? (
              <div className="max-w-sm text-center">
                <h3 className="text-sm font-semibold text-gray-900">
                  Adminer is taking longer than it should
                </h3>
                <p className="mt-1 text-xs leading-relaxed text-gray-500">
                  The database is running. Reload the frame, or open Adminer in your browser.
                </p>
                <div className="mt-3 flex justify-center gap-2">
                  <button
                    onClick={reloadFrame}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50"
                  >
                    <ArrowPathIcon className="h-4 w-4" />
                    Reload
                  </button>
                  <button
                    onClick={() =>
                      void api.siteAdminerOpen(site.domain).catch((e) => setFailure(errorText(e)))
                    }
                    className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50"
                  >
                    <ArrowTopRightOnSquareIcon className="h-4 w-4" />
                    Open in browser
                  </button>
                </div>
              </div>
            ) : (
              <p className="flex items-center gap-2 text-xs text-gray-500">
                <span
                  aria-hidden
                  className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-gray-200 border-t-gray-500"
                />
                {url ? "Loading Adminer…" : "Starting the web server and database…"}
              </p>
            )}
          </div>
        )}
      </div>

      {/* The facts, out of the way of the thing people came for. */}
      <div className="flex-shrink-0 rounded-xl border border-gray-200 bg-white shadow-sm">
        <button
          onClick={() => setDetailsOpen((o) => !o)}
          className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left"
        >
          <span className="flex items-center gap-1.5 text-xs font-semibold text-gray-900">
            {detailsOpen ? (
              <ChevronDownIcon className="h-3.5 w-3.5 text-gray-400" />
            ) : (
              <ChevronRightIcon className="h-3.5 w-3.5 text-gray-400" />
            )}
            Connection and export
          </span>
          <span className="flex items-center gap-2">
            <span className="font-mono text-[11px] text-gray-500">{site.db_name}</span>
            <span
              className={clsx(
                "rounded px-1.5 py-0.5 text-[10px] font-medium",
                running
                  ? "bg-green-100 text-green-700"
                  : info
                    ? "bg-gray-100 text-gray-500"
                    : "bg-amber-50 text-amber-700",
              )}
            >
              {running ? "running" : info ? "stopped" : "starting"}
            </span>
          </span>
        </button>

        {detailsOpen && (
          <div className="border-t border-gray-200">
            <dl className="divide-y divide-gray-100">
              <Row label="Name" value={site.db_name!} mono />
              <Row label="Engine" value={`MySQL ${info?.version || site.db_engine}`} />
              {info && <Row label="Host" value={`127.0.0.1:${info.port}`} mono />}
              <Row label="User" value="root (no password)" mono />
            </dl>
            <div className="px-4 py-3">
              <button
                onClick={() => void exportNow()}
                disabled={exporting || !running}
                className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-2 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <ArrowPathIcon className={clsx("h-4 w-4", exporting && "animate-spin")} />
                {exporting ? "Exporting…" : "Export database"}
              </button>
              {note && <p className="mt-2 break-all font-mono text-[11px] text-gray-600">{note}</p>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 px-4 py-2.5">
      <dt className="text-xs font-medium text-gray-600">{label}</dt>
      <dd className={clsx("break-all text-right text-xs text-gray-900", mono && "font-mono")}>
        {value}
      </dd>
    </div>
  );
}
