import { useEffect, useRef, useState } from "react";
import { ArrowPathIcon, DocumentTextIcon } from "@heroicons/react/24/outline";
import clsx from "clsx";
import { api, errorText, hasBackend, LogSource } from "../../lib/api";
import { useAsync } from "../../lib/useAsync";

function human(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

export default function LogsTab() {
  const { data: sources, error, loading, reload } = useAsync(() => api.logsSources(), []);
  const [selected, setSelected] = useState<string>("quickwp");
  const [body, setBody] = useState("");
  const [follow, setFollow] = useState(true);
  const [tailError, setTailError] = useState<string | null>(null);
  const boxRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const t = await api.logsTail(selected, 500);
        if (!cancelled) {
          setBody(t);
          setTailError(null);
        }
      } catch (e) {
        if (!cancelled) setTailError(errorText(e));
      }
    };
    void load();
    if (!follow) return () => {
      cancelled = true;
    };
    const id = setInterval(load, 2000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [selected, follow]);

  useEffect(() => {
    if (follow && boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [body, follow]);

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
          <h1 className="text-2xl font-bold text-gray-900">Logs</h1>
          <p className="text-xs text-gray-600">
            QuickWP's own log is first — when a service did not start, the reason is there and not
            in that service's empty file.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="inline-flex items-center gap-1.5 text-xs text-gray-700">
            <input
              type="checkbox"
              checked={follow}
              onChange={(e) => setFollow(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            Follow
          </label>
          <button
            onClick={() => void reload()}
            disabled={loading}
            className="inline-flex items-center px-3 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50"
          >
            <ArrowPathIcon className={clsx("h-4 w-4 mr-2", loading && "animate-spin")} />
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-900">{error}</div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[220px_1fr] gap-4">
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden self-start">
          <ul className="divide-y divide-gray-100">
            {(sources ?? []).map((l: LogSource) => (
              <li key={l.id}>
                <button
                  onClick={() => setSelected(l.id)}
                  className={clsx(
                    "w-full text-left px-3 py-2 transition-colors",
                    selected === l.id ? "bg-blue-50" : "hover:bg-gray-50",
                  )}
                >
                  <div className="flex items-center gap-1.5">
                    <DocumentTextIcon
                      className={clsx(
                        "h-3.5 w-3.5 flex-shrink-0",
                        l.is_app ? "text-blue-600" : "text-gray-400",
                      )}
                    />
                    <span
                      className={clsx(
                        "text-xs truncate",
                        l.is_app ? "font-semibold text-gray-900" : "text-gray-700",
                      )}
                    >
                      {l.label}
                    </span>
                  </div>
                  <span className="text-[10px] text-gray-400 tabular-nums pl-5">
                    {human(l.bytes)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
          {tailError ? (
            <p className="p-4 text-xs text-red-800">{tailError}</p>
          ) : body.trim() === "" ? (
            <p className="p-4 text-xs text-gray-500">
              This log is empty — nothing has written to it yet. That is not an error.
            </p>
          ) : (
            <pre
              ref={boxRef}
              className="p-3 text-[11px] leading-relaxed font-mono text-gray-800 overflow-auto max-h-[65vh] whitespace-pre-wrap break-words"
            >
              {body}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
