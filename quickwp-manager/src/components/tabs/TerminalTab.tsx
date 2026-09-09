import { useEffect, useRef, useState } from "react";
import { CommandLineIcon, ArrowTopRightOnSquareIcon } from "@heroicons/react/24/outline";
import clsx from "clsx";
import { api, errorText, hasBackend, ExecLine } from "../../lib/api";
import { useAsync } from "../../lib/useAsync";

interface Row {
  stream: "stdout" | "stderr" | "meta";
  text: string;
}

export default function TerminalTab() {
  const { data: sites } = useAsync(() => api.siteList(), []);
  const [domain, setDomain] = useState<string>("");
  const [command, setCommand] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [running, setRunning] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState(-1);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!domain && sites?.length) setDomain(sites[0].domain);
  }, [sites, domain]);

  useEffect(() => {
    let un: (() => void) | undefined;
    void api
      .onExecLine((l: ExecLine) => {
        if (l.domain !== domain) return;
        setRows((p) => [...p, { stream: l.stream, text: l.text }]);
      })
      .then((f) => {
        un = f as () => void;
      });
    return () => un?.();
  }, [domain]);

  useEffect(() => {
    if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [rows]);

  const run = async () => {
    const cmd = command.trim();
    if (!cmd || running || !domain) return;
    setRows((p) => [...p, { stream: "meta", text: `$ ${cmd}` }]);
    setHistory((h) => [cmd, ...h.filter((x) => x !== cmd)].slice(0, 50));
    setHistIdx(-1);
    setCommand("");
    setRunning(true);
    try {
      const code = await api.siteExec(domain, cmd);
      if (code !== 0) {
        setRows((p) => [...p, { stream: "meta", text: `exit ${code}` }]);
      }
    } catch (e) {
      setRows((p) => [...p, { stream: "stderr", text: errorText(e) }]);
    } finally {
      setRunning(false);
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

  return (
    <div className="max-w-6xl mx-auto p-4 space-y-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Terminal</h1>
          <p className="text-xs text-gray-600">
            Runs in the site's docroot, with that site's own PHP and <code>wp</code> on PATH.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={domain}
            onChange={(e) => {
              setDomain(e.target.value);
              setRows([]);
            }}
            className="px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
          >
            {(sites ?? []).map((s) => (
              <option key={s.id} value={s.domain}>
                {s.domain} (PHP {s.php_minor})
              </option>
            ))}
          </select>
          <button
            onClick={() => void api.siteTerminal(domain).catch((e) => alert(errorText(e)))}
            disabled={!domain}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-md border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50"
          >
            <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5" />
            Open Terminal.app
          </button>
        </div>
      </div>

      {(sites ?? []).length === 0 ? (
        <p className="text-xs text-gray-500">Create a site first.</p>
      ) : (
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
          <div
            ref={boxRef}
            className="p-3 h-[55vh] overflow-auto bg-gray-900 font-mono text-[11px] leading-relaxed"
          >
            {rows.length === 0 ? (
              <p className="text-gray-500">
                Try <span className="text-gray-300">wp plugin list</span>,{" "}
                <span className="text-gray-300">php -v</span> or{" "}
                <span className="text-gray-300">composer install</span>.
              </p>
            ) : (
              rows.map((r, i) => (
                <div
                  key={i}
                  className={clsx(
                    "whitespace-pre-wrap break-words",
                    r.stream === "stderr" && "text-red-400",
                    r.stream === "stdout" && "text-gray-200",
                    r.stream === "meta" && "text-blue-400",
                  )}
                >
                  {r.text}
                </div>
              ))
            )}
          </div>

          <div className="flex items-center gap-2 border-t border-gray-200 p-2">
            <CommandLineIcon className="h-4 w-4 text-gray-400 flex-shrink-0" />
            <input
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void run();
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  const next = Math.min(histIdx + 1, history.length - 1);
                  if (next >= 0) {
                    setHistIdx(next);
                    setCommand(history[next]);
                  }
                }
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  const next = histIdx - 1;
                  setHistIdx(next);
                  setCommand(next >= 0 ? history[next] : "");
                }
              }}
              disabled={running}
              placeholder={running ? "Running…" : "Type a command and press Enter"}
              className="flex-1 px-2 py-1.5 text-sm font-mono border border-gray-300 rounded-md focus:outline-none focus:ring-blue-500 focus:border-blue-500 disabled:bg-gray-50"
            />
            <button
              onClick={() => void run()}
              disabled={running || !command.trim()}
              className="px-3 py-1.5 text-xs font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-40"
            >
              Run
            </button>
            <button
              onClick={() => setRows([])}
              className="px-3 py-1.5 text-xs font-medium rounded-md border border-gray-300 text-gray-700 bg-white hover:bg-gray-50"
            >
              Clear
            </button>
          </div>
        </div>
      )}

      <p className="text-[11px] leading-relaxed text-gray-500 max-w-3xl">
        This is a <strong>command runner</strong>, not a full TTY: it runs one command at a time
        and streams its output. Anything interactive — vim, a REPL, a prompt waiting for input —
        needs a real shell, so <em>Open Terminal.app</em> starts one in the same directory with
        the same PATH rather than hanging on a prompt you cannot see.
      </p>
    </div>
  );
}
