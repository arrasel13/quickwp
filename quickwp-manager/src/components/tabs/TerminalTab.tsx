import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowTopRightOnSquareIcon } from "@heroicons/react/24/outline";
import { Eraser, RotateCw } from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { api, errorText, hasBackend } from "../../lib/api";
import { useAsync } from "../../lib/useAsync";
import { usePreferredApps } from "../../lib/usePreferredApps";

/**
 * A light palette, because this pane sits in a light window. xterm's stock
 * ANSI colours assume a dark background -- yellow and cyan vanish on white --
 * so WP-CLI's success and warning lines get colours picked to stay readable
 * here.
 */
const THEME = {
  background: "#f8f9fb",
  foreground: "#1f2937",
  cursor: "#2563eb",
  cursorAccent: "#f8f9fb",
  selectionBackground: "#bfdbfe",
  selectionForeground: "#111827",
  black: "#1f2937",
  red: "#b91c1c",
  green: "#15803d",
  yellow: "#a16207",
  blue: "#1d4ed8",
  magenta: "#a21caf",
  cyan: "#0e7490",
  white: "#d1d5db",
  brightBlack: "#6b7280",
  brightRed: "#dc2626",
  brightGreen: "#16a34a",
  brightYellow: "#ca8a04",
  brightBlue: "#2563eb",
  brightMagenta: "#c026d3",
  brightCyan: "#0891b2",
  brightWhite: "#111827",
};

/**
 * @param fixedDomain When set, this is that one site's shell: the heading and
 *        the site picker are dropped, so it can be embedded in a site's own
 *        Terminal tab rather than duplicating the xterm wiring there.
 */
export default function TerminalTab({
  fixedDomain,
}: {
  fixedDomain?: string;
} = {}) {
  const embedded = Boolean(fixedDomain);
  const externalTerminal = usePreferredApps().terminal ?? "Terminal";
  const { data: sites } = useAsync(
    () => (embedded ? Promise.resolve([]) : api.siteList()),
    [embedded],
  );
  const [domain, setDomain] = useState(fixedDomain ?? "");
  const [error, setError] = useState<string | null>(null);
  const [exited, setExited] = useState(false);
  // Bumped by Restart. It is part of the session id, so the shell being torn
  // down and the one being started can never be the same session -- otherwise
  // the old one's exit event lands on the new terminal.
  const [generation, setGeneration] = useState(0);

  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const idRef = useRef<string>("");

  useEffect(() => {
    if (fixedDomain) {
      setDomain(fixedDomain);
      return;
    }
    if (!domain && sites?.length) setDomain(sites[0].domain);
  }, [sites, domain, fixedDomain]);

  // One terminal per site: switching sites tears the old one down rather than
  // leaving a shell running with nothing showing it.
  useEffect(() => {
    if (!domain || !hostRef.current || !hasBackend) return;

    const host = hostRef.current;
    const id = `term:${domain}:${generation}`;
    idRef.current = id;
    setExited(false);
    setError(null);

    const term = new Terminal({
      fontFamily:
        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.35,
      cursorBlink: true,
      convertEol: false,
      scrollback: 5000,
      theme: THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;

    // The pane can be laid out at zero size for a frame (a tab that was just
    // switched to), and fitting against that produces a 0-column terminal.
    const refit = () => {
      if (!host.clientWidth || !host.clientHeight) return;
      try {
        fit.fit();
      } catch {
        /* the pane can be hidden mid-resize */
      }
    };
    refit();

    let disposed = false;
    const unlisteners: Array<() => void> = [];

    // Listeners first, then open. A shell prints its prompt the moment it
    // starts, and attaching afterwards drops that first paint.
    void (async () => {
      try {
        const offOutput = await api.onPtyOutput((p) => {
          if (p.id === idRef.current) term.write(p.data);
        });
        const offExit = await api.onPtyExit((p) => {
          if (p.id === idRef.current) {
            setExited(true);
            term.write("\r\n\x1b[2m[the shell exited]\x1b[0m\r\n");
          }
        });
        if (disposed) {
          offOutput();
          offExit();
          return;
        }
        unlisteners.push(offOutput, offExit);
        await api.ptyOpen(id, domain, term.cols, term.rows);
        if (!disposed) term.focus();
      } catch (e) {
        if (!disposed) setError(errorText(e));
      }
    })();

    // Keystrokes go straight to the PTY. This is what makes a prompt
    // answerable and Ctrl-C mean what it means.
    const onData = term.onData((d) => {
      void api.ptyWrite(id, d).catch((e) => setError(errorText(e)));
    });

    const onResize = () => {
      refit();
      if (term.cols && term.rows) {
        void api.ptyResize(id, term.cols, term.rows).catch(() => {});
      }
    };
    window.addEventListener("resize", onResize);
    const ro = new ResizeObserver(onResize);
    ro.observe(host);

    return () => {
      disposed = true;
      window.removeEventListener("resize", onResize);
      ro.disconnect();
      onData.dispose();
      unlisteners.forEach((u) => u());
      void api.ptyClose(id).catch(() => {});
      term.dispose();
      termRef.current = null;
    };
  }, [domain, generation]);

  const clear = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    // Scrollback and viewport, keeping the prompt line you are typing on.
    term.clear();
    term.focus();
  }, []);

  const restart = useCallback(() => setGeneration((g) => g + 1), []);

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

  const noSites = !embedded && (sites ?? []).length === 0;

  return (
    <div
      className={
        embedded
          ? "flex h-full flex-col gap-3 p-4"
          : "mx-auto flex h-full max-w-6xl flex-col gap-3 p-4"
      }
    >
      {!embedded && (
        <div className="flex flex-shrink-0 items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Terminal</h1>
            <p className="text-xs text-gray-600">
              A real shell in the site's docroot, with that site's own PHP and{" "}
              <code className="bg-gray-100 px-1 rounded">wp</code> on PATH.
            </p>
          </div>
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
        </div>
      )}

      {error && (
        <div className="flex-shrink-0 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-900">
          {error}
        </div>
      )}

      {noSites ? (
        <p className="text-xs text-gray-500">Create a site first.</p>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
          <div className="flex flex-shrink-0 items-center justify-between gap-4 border-b border-gray-200 px-4 py-2.5">
            {exited ? (
              <span className="font-mono text-xs text-amber-700">
                the shell exited — press Restart
              </span>
            ) : (
              <span className="font-mono text-xs text-gray-500">
                bundled php + wp on PATH
              </span>
            )}
            <div className="flex items-center gap-1.5">
              <button
                onClick={() =>
                  void api.siteTerminal(domain).catch((e) => setError(errorText(e)))
                }
                disabled={!domain}
                title={`Open this docroot in ${externalTerminal}`}
                className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50"
              >
                <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5" />
                {externalTerminal}
              </button>
              <button
                onClick={clear}
                title="Clear the screen and scrollback"
                className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50"
              >
                <Eraser className="h-3.5 w-3.5" strokeWidth={1.75} />
                Clear
              </button>
              <button
                onClick={restart}
                title="Kill this shell and start a fresh one"
                className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50"
              >
                <RotateCw className="h-3.5 w-3.5" strokeWidth={1.75} />
                Restart
              </button>
            </div>
          </div>

          <div className="min-h-0 flex-1 bg-[#f8f9fb] p-3">
            <div ref={hostRef} className="h-full w-full" />
          </div>
        </div>
      )}
    </div>
  );
}
