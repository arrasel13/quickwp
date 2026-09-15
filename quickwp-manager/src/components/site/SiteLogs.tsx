import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowDownTrayIcon,
  ArrowPathIcon,
  ArrowTopRightOnSquareIcon,
  DocumentTextIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import clsx from "clsx";
import { api, errorText, hasBackend, SiteLog } from "../../lib/api";
import ConfirmDialog from "../ui/ConfirmDialog";
import IconButton from "../ui/IconButton";
import WpDebugPanel from "./WpDebugPanel";

const TAIL_LINES = 1000;

/**
 * The four log streams that can explain one site, one at a time.
 *
 * Tailing a file is cheap -- it reads the end of it -- so this follows by
 * default and says so, rather than making you press refresh to find out
 * whether anything happened.
 */
export default function SiteLogs({ domain }: { domain: string }) {
  const [streams, setStreams] = useState<SiteLog[]>([]);
  const [selected, setSelected] = useState<string>("wp-debug");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [spinning, setSpinning] = useState(false);
  const boxRef = useRef<HTMLPreElement>(null);
  // Whether the view is at the newest line, so new lines may move it there.
  const atBottom = useRef(true);

  const current = streams.find((s) => s.id === selected) ?? null;

  const loadStreams = useCallback(async () => {
    try {
      setStreams(await api.siteLogs(domain));
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, [domain]);

  useEffect(() => {
    void loadStreams();
  }, [loadStreams]);

  const loadBody = useCallback(async () => {
    if (!hasBackend) return;
    try {
      setBody(await api.siteLogTail(domain, selected, TAIL_LINES));
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, [domain, selected]);

  // Always following. Switching stream reloads at once, so the pane never
  // shows the previous log under the new tab's name.
  useEffect(() => {
    void loadBody();
    const timer = setInterval(() => {
      if (!document.hidden) void loadBody();
    }, 3000);
    return () => clearInterval(timer);
  }, [loadBody]);

  // A new stream opens at its newest line.
  useEffect(() => {
    atBottom.current = true;
  }, [selected]);

  // New lines keep the view at the bottom -- unless you have scrolled up to
  // read, which used to need a Pause button.
  useEffect(() => {
    const box = boxRef.current;
    if (box && atBottom.current) box.scrollTop = box.scrollHeight;
  }, [body]);

  const refresh = async () => {
    setSpinning(true);
    const started = Date.now();
    try {
      await Promise.all([loadBody(), loadStreams()]);
    } finally {
      // Held briefly: reading a file is faster than the eye, and a spinner
      // that never appears reads as a dead button.
      const held = Date.now() - started;
      if (held < 400) await new Promise((r) => setTimeout(r, 400 - held));
      setSpinning(false);
    }
  };

  const act = async (key: string, fn: () => Promise<string>) => {
    setBusy(key);
    setNote(null);
    try {
      setNote(await fn());
    } catch (e) {
      setNote(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const fileName = current?.path.split("/").pop() ?? "—";
  const isWpDebug = current?.id === "wp-debug";
  // Only a WordPress site reports whether it logs; the panel is for those.
  const wordpress = isWpDebug && current?.logging !== null && current?.logging !== undefined;
  const loggingOff = isWpDebug && current?.logging === false;

  // The log's actions: in the file header for most logs, and inside the debug
  // panel for a WordPress debug log, so that tab has one bar rather than two.
  const renderActions = (lastAtEdge: boolean) => (
    <>
      <IconButton label="Refresh" onClick={() => void refresh()} disabled={spinning}>
        <ArrowPathIcon className={clsx("h-4 w-4", spinning && "animate-spin")} />
      </IconButton>
      <IconButton
        label={busy === "download" ? "Saving…" : "Download"}
        disabled={!current?.exists || busy === "download"}
        onClick={() =>
          void act("download", async () => {
            const path = await api.siteLogDownload(domain, selected);
            return `Saved to ${path}`;
          })
        }
      >
        <ArrowDownTrayIcon className="h-4 w-4" />
      </IconButton>
      <IconButton
        label="Open file"
        disabled={!current?.exists}
        onClick={() => void api.pathOpen(current?.path ?? "").catch((e) => setNote(errorText(e)))}
      >
        <ArrowTopRightOnSquareIcon className="h-4 w-4" />
      </IconButton>
      <IconButton
        label="Clear log"
        tone="danger"
        tipAlign={lastAtEdge ? "right" : "center"}
        onClick={() => setConfirmClear(true)}
        disabled={!current?.exists || busy === "clear"}
      >
        <TrashIcon className="h-4 w-4" />
      </IconButton>
    </>
  );

  return (
    <div className="flex h-full flex-col p-4">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
        {/* Stream tabs */}
        <nav className="flex flex-shrink-0 gap-1 border-b border-gray-200 px-3">
          {streams.map((s) => (
            <button
              key={s.id}
              onClick={() => setSelected(s.id)}
              className={clsx(
                "-mb-px border-b-2 px-3 py-3 text-sm font-medium transition-colors",
                selected === s.id
                  ? "border-blue-600 text-gray-900"
                  : "border-transparent text-gray-500 hover:text-gray-800",
              )}
            >
              {s.label}
            </button>
          ))}
        </nav>

        {/* Header: which file, how big, where, and its actions. A WordPress
            debug log has none of its own -- its panel carries all of it. */}
        {!wordpress && (
          <div className="flex flex-shrink-0 items-center gap-3 border-b border-gray-200 px-4 py-2.5">
            <span className="grid h-8 w-8 flex-shrink-0 place-items-center rounded-lg bg-gray-50 text-gray-400 ring-1 ring-inset ring-gray-200">
              <DocumentTextIcon className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="flex min-w-0 items-center gap-2">
                <span className="truncate font-mono text-[13px] font-medium text-gray-900">{fileName}</span>
                {current?.exists && (
                  <span className="flex-shrink-0 text-[11px] text-gray-400">{human(current.bytes)}</span>
                )}
                {current?.exists && (
                  <span className="inline-flex flex-shrink-0 items-center gap-1 rounded-full bg-emerald-50 px-1.5 py-px text-[10px] font-medium text-emerald-700">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
                    Live
                  </span>
                )}
              </p>
              <p className="truncate font-mono text-[11px] text-gray-400" title={current?.path}>
                {current?.path ?? "—"}
              </p>
            </div>
            <div className="flex flex-shrink-0 items-center gap-0.5">{renderActions(true)}</div>
          </div>
        )}

        {wordpress && (
          <WpDebugPanel
            domain={domain}
            size={current?.exists ? human(current.bytes) : null}
            path={current?.path ?? ""}
            actions={renderActions(false)}
            onChanged={() => void Promise.all([loadStreams(), loadBody()])}
          />
        )}

        {/* Body */}
        {error ? (
          <p className="p-4 text-xs text-red-700">{error}</p>
        ) : loggingOff && !body ? (
          <EmptyLog
            title="Debug logging is off"
            text="Enable the debug log above, then load a page of the site. Notices, warnings and errors show up here as they happen."
          />
        ) : !current?.exists && !body ? (
          <EmptyLog
            title={isWpDebug ? "Nothing logged yet" : "This log is empty"}
            text={
              isWpDebug
                ? "Debug logging is on. Load a page of the site, and anything PHP reports appears here."
                : "Nothing has written to this log yet."
            }
          />
        ) : (
          <pre
            ref={boxRef}
            onScroll={(e) => {
              const b = e.currentTarget;
              atBottom.current = b.scrollHeight - b.scrollTop - b.clientHeight < 40;
            }}
            className="min-h-0 flex-1 overflow-auto p-4 font-mono text-[11px] leading-relaxed text-gray-700"
          >
            {body
              ? body.split("\n").map((line, i) => (
                  <span key={i} className={clsx("block whitespace-pre-wrap break-all", levelTone(line))}>
                    {line || "\u00a0"}
                  </span>
                ))
              : "— empty —"}
          </pre>
        )}
      </div>

      {note && (
        <p className="mt-2 break-all font-mono text-[11px] text-gray-600">
          {note}
        </p>
      )}

      <ConfirmDialog
        open={confirmClear}
        title={`Empty ${fileName}?`}
        body="Everything written to this log so far is discarded. The file stays in place so whatever is writing to it keeps working."
        confirmLabel="Clear"
        busy={busy === "clear"}
        onCancel={() => setConfirmClear(false)}
        onConfirm={() => {
          setConfirmClear(false);
          void act("clear", async () => {
            const msg = await api.siteLogClear(domain, selected);
            await Promise.all([loadBody(), loadStreams()]);
            return msg;
          });
        }}
      />
    </div>
  );
}

/** A quiet, centred note for a log with nothing in it. */
function EmptyLog({ title, text }: { title: string; text: string }) {
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="max-w-sm text-center">
        <DocumentTextIcon className="mx-auto h-8 w-8 text-gray-300" />
        <p className="mt-2 text-sm font-semibold text-gray-700">{title}</p>
        <p className="mt-1 text-xs leading-relaxed text-gray-500">{text}</p>
      </div>
    </div>
  );
}

/**
 * The colour of a log line, from what it says about itself: warnings amber,
 * errors red, the rest as written. Reads Nexora's own [WARN]/[ERROR] and the
 * words PHP and MySQL use in their logs, so every stream is scanned the same way.
 */
function levelTone(line: string) {
  if (/\[(ERROR|FATAL)\]|\bPHP Fatal error\b|\bFatal error\b|\[ERROR\]|\bERROR:/i.test(line)) {
    return "text-red-700";
  }
  if (/\[WARN(ING)?\]|\bPHP Warning\b|\bWARNING:|\[Warning\]/i.test(line)) {
    return "text-amber-700";
  }
  return "";
}

function human(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}
