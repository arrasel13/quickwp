import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowDownTrayIcon,
  ArrowPathIcon,
  ArrowTopRightOnSquareIcon,
  DocumentTextIcon,
  PauseIcon,
  PlayIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import clsx from "clsx";
import { api, errorText, hasBackend, SiteLog } from "../../lib/api";
import ConfirmDialog from "../ui/ConfirmDialog";

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
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [spinning, setSpinning] = useState(false);
  const boxRef = useRef<HTMLPreElement>(null);

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

  // Follow the file until paused. Switching stream reloads immediately so the
  // pane is never showing the previous log under the new tab's name.
  useEffect(() => {
    void loadBody();
    if (paused) return;
    const timer = setInterval(() => {
      if (!document.hidden) void loadBody();
    }, 3000);
    return () => clearInterval(timer);
  }, [loadBody, paused]);

  // Pinned to the newest line while following, which is the point of following.
  useEffect(() => {
    if (!paused && boxRef.current) {
      boxRef.current.scrollTop = boxRef.current.scrollHeight;
    }
  }, [body, paused]);

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
  const loggingOff = current?.id === "wp-debug" && current.logging === false;

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

        {/* Toolbar */}
        <div className="flex flex-shrink-0 flex-wrap items-center gap-2 border-b border-gray-200 px-3 py-2.5">
          <DocumentTextIcon className="h-4 w-4 flex-shrink-0 text-gray-400" />
          <span className="font-mono text-sm text-gray-900">{fileName}</span>

          {loggingOff && (
            <span className="rounded-full bg-gray-100 px-2 py-0.5 font-mono text-[11px] text-gray-500">
              logging off
            </span>
          )}
          {current?.exists && (
            <span className="text-[11px] text-gray-400">
              {human(current.bytes)}
            </span>
          )}

          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            <ToolbarButton onClick={() => void refresh()} disabled={spinning}>
              <ArrowPathIcon
                className={clsx("h-4 w-4", spinning && "animate-spin")}
              />
              Refresh
            </ToolbarButton>

            <ToolbarButton onClick={() => setPaused((p) => !p)}>
              {paused ? (
                <PlayIcon className="h-4 w-4" />
              ) : (
                <PauseIcon className="h-4 w-4" />
              )}
              {paused ? "Resume" : "Pause"}
            </ToolbarButton>

            <ToolbarButton
              onClick={() => setConfirmClear(true)}
              disabled={!current?.exists || busy === "clear"}
            >
              <TrashIcon className="h-4 w-4" />
              Clear
            </ToolbarButton>

            <ToolbarButton
              disabled={!current?.exists || busy === "download"}
              onClick={() =>
                void act("download", async () => {
                  const path = await api.siteLogDownload(domain, selected);
                  return `Saved to ${path}`;
                })
              }
            >
              <ArrowDownTrayIcon className="h-4 w-4" />
              {busy === "download" ? "Saving…" : "Download"}
            </ToolbarButton>

            <ToolbarButton
              disabled={!current?.exists}
              onClick={() =>
                void api
                  .pathOpen(current?.path ?? "")
                  .catch((e) => setNote(errorText(e)))
              }
            >
              <ArrowTopRightOnSquareIcon className="h-4 w-4" />
              Open file
            </ToolbarButton>
          </div>
        </div>

        {/* Path */}
        <div className="flex-shrink-0 border-b border-gray-200 px-3 py-2.5">
          <span className="break-all font-mono text-xs text-gray-600">
            {current?.path ?? "—"}
          </span>
        </div>

        {/* Body */}
        {error ? (
          <p className="p-4 text-xs text-red-700">{error}</p>
        ) : loggingOff && !body ? (
          <DebugOff path={current?.path ?? ""} />
        ) : !current?.exists && !body ? (
          <p className="p-4 font-mono text-xs leading-relaxed text-gray-500">
            This log has not been written to yet — nothing has had anything to
            say.
          </p>
        ) : (
          <pre
            ref={boxRef}
            className="min-h-0 flex-1 overflow-auto p-4 font-mono text-[11px] leading-relaxed text-gray-700"
          >
            {body || "— empty —"}
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

function ToolbarButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center gap-1.5 rounded-lg bg-gray-100 px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-200 disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-400"
    >
      {children}
    </button>
  );
}

/** What to do about it, not just that it is off. */
function DebugOff({ path }: { path: string }) {
  return (
    <div className="flex-1 overflow-auto p-4 font-mono text-xs leading-relaxed text-gray-700">
      <p>WordPress debug logging is off — nothing is being written to {path.split("/").pop()}.</p>
      <p className="mt-4">
        Turn on <span className="font-semibold">WP_DEBUG</span> from the{" "}
        <span className="font-semibold">WordPress → Tools</span> tab, which
        writes this into wp-config.php for you:
      </p>
      <pre className="mt-3 inline-block rounded-lg bg-gray-100 p-3 text-xs">
        {`define( 'WP_DEBUG', true );\ndefine( 'WP_DEBUG_LOG', true );`}
      </pre>
    </div>
  );
}

function human(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}
