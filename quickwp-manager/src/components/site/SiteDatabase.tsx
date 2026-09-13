import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowPathIcon,
  ArrowTopRightOnSquareIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  DocumentDuplicateIcon,
} from "@heroicons/react/24/outline";
import clsx from "clsx";
import { api, errorText, hasBackend, Site } from "../../lib/api";
import { useAsync } from "../../lib/useAsync";

/**
 * The database behind one site: Adminer on it, and the facts about it.
 *
 * Adminer is the tab rather than a link out of it. Looking at a table is the
 * thing people came here to do, and a page that only tells you the port makes
 * you go find a client to do it with.
 */
export default function SiteDatabase({ site }: { site: Site }) {
  const { data: engines, loading } = useAsync(() => api.dbList(), [], "db-list");
  const [exporting, setExporting] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const frameRef = useRef<HTMLIFrameElement>(null);

  const engine = engines?.find((e) => e.engine === site.db_engine);
  const running = Boolean(engine?.running);
  const hasDb = Boolean(site.db_name && site.db_engine);

  // Built by the backend, because the URL carries the token that gates Adminer
  // and the first call is also what fetches it.
  const prepare = useCallback(async () => {
    if (!hasBackend || !hasDb || !running) return;
    setPreparing(true);
    setUrlError(null);
    try {
      setUrl(await api.siteAdminerUrl(site.domain));
    } catch (e) {
      setUrlError(errorText(e));
      setUrl(null);
    } finally {
      setPreparing(false);
    }
  }, [site.domain, hasDb, running]);

  useEffect(() => {
    void prepare();
  }, [prepare]);

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
    if (f && url) f.src = url;
  };

  const exportNow = async () => {
    setExporting(true);
    setNote(null);
    try {
      const path = await api.dbExport(engine?.series ?? "", site.db_name!);
      setNote(`Exported to ${path}`);
    } catch (e) {
      setNote(errorText(e));
    } finally {
      setExporting(false);
    }
  };

  if (loading) {
    return <p className="p-4 text-xs text-gray-500">Reading engines…</p>;
  }

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

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      {/* The address bar. Present even before Adminer is ready, so the pane
          does not change shape the moment it loads. */}
      <div className="flex flex-shrink-0 items-center gap-2 rounded-xl border border-gray-200 bg-white px-3 py-2 shadow-sm">
        <span
          className="flex-1 truncate font-mono text-xs text-gray-600"
          title={url ?? undefined}
        >
          {url ?? (preparing ? "Preparing the database browser…" : "—")}
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
          onClick={() =>
            void api.siteAdminerOpen(site.domain).catch((e) => setUrlError(errorText(e)))
          }
          disabled={!url}
          className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-40"
        >
          <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5" />
          Open in browser
        </button>
      </div>

      {/* Adminer itself. */}
      <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
        {url ? (
          <iframe
            ref={frameRef}
            src={url}
            title={`Adminer — ${site.db_name}`}
            className="h-full w-full border-0"
          />
        ) : (
          <div className="flex h-full items-center justify-center p-6">
            <div className="max-w-sm text-center">
              {!running ? (
                <>
                  <h3 className="text-sm font-semibold text-gray-900">
                    The {site.db_engine} engine is stopped
                  </h3>
                  <p className="mt-1 text-xs leading-relaxed text-gray-500">
                    Start it from Nexora Settings › Services and this page will connect.
                  </p>
                </>
              ) : urlError ? (
                <>
                  <h3 className="text-sm font-semibold text-gray-900">
                    The database browser did not open
                  </h3>
                  <p className="mt-1 break-words text-xs leading-relaxed text-gray-500">
                    {urlError}
                  </p>
                  <button
                    onClick={() => void prepare()}
                    className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50"
                  >
                    <ArrowPathIcon className="h-4 w-4" />
                    Try again
                  </button>
                </>
              ) : (
                <p className="text-xs text-gray-500">
                  {preparing
                    ? "Fetching the database browser…"
                    : "Preparing…"}
                </p>
              )}
            </div>
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
            <span className="font-mono text-[11px] text-gray-500">
              {site.db_name}
            </span>
            <span
              className={clsx(
                "rounded px-1.5 py-0.5 text-[10px] font-medium",
                running ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500",
              )}
            >
              {running ? "running" : "stopped"}
            </span>
          </span>
        </button>

        {detailsOpen && (
          <div className="border-t border-gray-200">
            <dl className="divide-y divide-gray-100">
              <Row label="Name" value={site.db_name!} mono />
              <Row label="Engine" value={site.db_engine!} />
              {engine && (
                <>
                  <Row label="Version" value={engine.version} mono />
                  <Row label="Host" value={`127.0.0.1:${engine.port}`} mono />
                </>
              )}
            </dl>
            <div className="px-4 py-3">
              <button
                onClick={() => void exportNow()}
                disabled={exporting || !running}
                className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-2 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <ArrowPathIcon
                  className={clsx("h-4 w-4", exporting && "animate-spin")}
                />
                {exporting ? "Exporting…" : "Export database"}
              </button>
              {!running && (
                <p className="mt-2 text-[11px] text-gray-500">
                  The engine is stopped — start it from Nexora Settings › Services first.
                </p>
              )}
              {note && (
                <p className="mt-2 break-all font-mono text-[11px] text-gray-600">
                  {note}
                </p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 px-4 py-2.5">
      <dt className="text-xs font-medium text-gray-600">{label}</dt>
      <dd
        className={clsx(
          "break-all text-right text-xs text-gray-900",
          mono && "font-mono",
        )}
      >
        {value}
      </dd>
    </div>
  );
}
