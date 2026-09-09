import { useEffect, useRef, useState } from "react";
import { ArrowTopRightOnSquareIcon, ArrowPathIcon } from "@heroicons/react/24/outline";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { api, errorText, hasBackend } from "../../lib/api";
import { useAsync } from "../../lib/useAsync";

export default function TerminalTab() {
  const { data: sites } = useAsync(() => api.siteList(), []);
  const [domain, setDomain] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [exited, setExited] = useState(false);

  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const idRef = useRef<string>("");

  useEffect(() => {
    if (!domain && sites?.length) setDomain(sites[0].domain);
  }, [sites, domain]);

  // One terminal per site: switching sites tears the old one down rather than
  // leaving a shell running with nothing showing it.
  useEffect(() => {
    if (!domain || !hostRef.current || !hasBackend) return;

    const id = `term:${domain}`;
    idRef.current = id;
    setExited(false);
    setError(null);

    const term = new Terminal({
      fontFamily:
        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
      fontSize: 12,
      cursorBlink: true,
      convertEol: false,
      theme: {
        background: "#111827",
        foreground: "#e5e7eb",
        cursor: "#60a5fa",
        selectionBackground: "#374151",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    const unlisteners: Array<() => void> = [];

    void api
      .onPtyOutput((p) => {
        if (p.id === idRef.current) term.write(p.data);
      })
      .then((f) => unlisteners.push(f as () => void));

    void api
      .onPtyExit((p) => {
        if (p.id === idRef.current) {
          setExited(true);
          term.write("\r\n\x1b[2m[the shell exited]\x1b[0m\r\n");
        }
      })
      .then((f) => unlisteners.push(f as () => void));

    // Keystrokes go straight to the PTY. This is what makes a prompt
    // answerable and Ctrl-C mean what it means.
    const onData = term.onData((d) => {
      void api.ptyWrite(id, d).catch((e) => setError(errorText(e)));
    });

    void api
      .ptyOpen(id, domain, term.cols, term.rows)
      .catch((e) => setError(errorText(e)));

    const onResize = () => {
      try {
        fit.fit();
        void api.ptyResize(id, term.cols, term.rows).catch(() => {});
      } catch {
        /* the pane can be hidden mid-resize */
      }
    };
    window.addEventListener("resize", onResize);
    const ro = new ResizeObserver(onResize);
    if (hostRef.current) ro.observe(hostRef.current);

    return () => {
      window.removeEventListener("resize", onResize);
      ro.disconnect();
      onData.dispose();
      unlisteners.forEach((u) => u());
      void api.ptyClose(id).catch(() => {});
      term.dispose();
      termRef.current = null;
    };
  }, [domain]);

  const restart = () => {
    const d = domain;
    setDomain("");
    setTimeout(() => setDomain(d), 0);
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
    <div className="max-w-6xl mx-auto p-4 space-y-3">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Terminal</h1>
          <p className="text-xs text-gray-600">
            A real shell in the site's docroot, with that site's own PHP and{" "}
            <code className="bg-gray-100 px-1 rounded">wp</code> on PATH.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
          >
            {(sites ?? []).map((s) => (
              <option key={s.id} value={s.domain}>
                {s.domain} (PHP {s.php_minor})
              </option>
            ))}
          </select>
          {exited && (
            <button
              onClick={restart}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-md border border-gray-300 text-gray-700 bg-white hover:bg-gray-50"
            >
              <ArrowPathIcon className="h-3.5 w-3.5" />
              New shell
            </button>
          )}
          <button
            onClick={() => void api.siteTerminal(domain).catch((e) => setError(errorText(e)))}
            disabled={!domain}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-md border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50"
          >
            <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5" />
            Open in Terminal.app
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-900">{error}</div>
      )}

      {(sites ?? []).length === 0 ? (
        <p className="text-xs text-gray-500">Create a site first.</p>
      ) : (
        <div className="rounded-lg border border-gray-200 shadow-sm overflow-hidden bg-[#111827] p-2">
          <div ref={hostRef} className="h-[62vh] w-full" />
        </div>
      )}

      <p className="text-[11px] leading-relaxed text-gray-500 max-w-3xl">
        This is a real pseudo-terminal, so <code className="bg-gray-100 px-1 rounded">vim</code>,{" "}
        <code className="bg-gray-100 px-1 rounded">top</code> and any command that asks a question
        all work. It closes when QuickWP quits — a shell with no window attached is a process
        nobody can see.
      </p>
    </div>
  );
}
