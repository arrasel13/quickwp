import { useEffect, useState } from "react";
import { BugAntIcon, CodeBracketIcon, ExclamationTriangleIcon } from "@heroicons/react/24/outline";
import clsx from "clsx";
import { api, errorText, hasBackend, WpDebugState } from "../../lib/api";
import IconButton from "../ui/IconButton";

type Busy = "enable" | "disable" | "insert" | "remove" | null;

const PLACEHOLDER = `define( 'WP_DEBUG_DISPLAY', false );
define( 'SCRIPT_DEBUG', true );
define( 'SAVEQUERIES', true );`;

/**
 * Debug logging for one WordPress site, switched here instead of by editing
 * wp-config.php: the two standard lines on or off, and the site's own debug
 * code inserted or removed. Everything is checked by PHP before it is saved.
 */
export default function WpDebugPanel({
  domain,
  size,
  path,
  actions,
  onChanged,
}: {
  domain: string;
  /** The debug log's size, when it exists. */
  size?: string | null;
  /** Where the debug log is, shown on hover. */
  path?: string;
  /** The log's own actions -- refresh, download, open, clear -- so this tab
   *  has one bar rather than a panel under a toolbar. */
  actions?: React.ReactNode;
  /** After a change, so the log below can show what is now being written. */
  onChanged: () => void;
}) {
  const [debug, setDebug] = useState<WpDebugState | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    if (!hasBackend) return;
    let live = true;
    setDebug(null);
    setError(null);
    api
      .wpDebugState(domain)
      .then((d) => {
        if (!live) return;
        setDebug(d);
        setDraft(d.custom_code);
        setCustomOpen(d.custom_active);
      })
      .catch((e) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [domain]);

  const run = async (kind: Exclude<Busy, null>, fn: () => Promise<WpDebugState>) => {
    setBusy(kind);
    setError(null);
    try {
      const next = await fn();
      setDebug(next);
      if (kind === "remove" || kind === "insert") setDraft(next.custom_code);
      onChanged();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const logging = Boolean(debug?.logging);
  // On, but not by Nexora's lines: set in wp-config.php some other way.
  const onElsewhere = logging && debug && !debug.standard && !debug.custom_active;
  const draftChanged = debug ? draft.trim() !== debug.custom_code.trim() : false;

  return (
    <section className="flex-shrink-0 border-b border-gray-200 bg-gradient-to-b from-gray-50/80 to-white px-4 py-3.5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="flex min-w-0 items-center gap-3">
          <span
            className={clsx(
              "grid h-9 w-9 flex-shrink-0 place-items-center rounded-xl ring-1 ring-inset transition-colors",
              logging ? "bg-emerald-50 text-emerald-600 ring-emerald-100" : "bg-white text-gray-400 ring-gray-200",
            )}
          >
            <BugAntIcon className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-sm font-semibold text-gray-900" title={path || undefined}>
              Debug logging
              {debug && (
                <span
                  className={clsx(
                    "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
                    logging ? "bg-emerald-50 text-emerald-700" : "bg-gray-100 text-gray-500",
                  )}
                >
                  <span className={clsx("h-1.5 w-1.5 rounded-full", logging ? "bg-emerald-500" : "bg-gray-400")} />
                  {logging ? "On" : "Off"}
                </span>
              )}
              {size && <span className="text-[11px] font-normal text-gray-400">debug.log · {size}</span>}
            </p>
            <p className="mt-0.5 text-xs text-gray-500">
              {!debug
                ? "Reading wp-config.php…"
                : logging
                  ? "WordPress writes PHP notices, warnings and errors to wp-content/debug.log."
                  : "Record PHP notices, warnings and errors from this site in wp-content/debug.log."}
            </p>
          </div>
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          {actions && (
            <>
              <div className="flex items-center gap-0.5">{actions}</div>
              <span aria-hidden className="mx-1 h-5 w-px bg-gray-200" />
            </>
          )}
          <IconButton
            label={debug?.custom_active ? "Custom code · inserted" : "Custom code"}
            onClick={() => setCustomOpen((o) => !o)}
            disabled={!debug}
            active={customOpen}
          >
            <CodeBracketIcon className="h-4 w-4" />
            {debug?.custom_active && (
              <span aria-hidden className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-emerald-500 ring-2 ring-white" />
            )}
          </IconButton>

          <span aria-hidden className="mx-1 h-5 w-px bg-gray-200" />

          {/* The switch is Nexora's two lines: on puts them in wp-config.php. */}
          <Switch
            label="Debug logging"
            checked={Boolean(debug?.standard || onElsewhere)}
            busy={busy === "enable" || busy === "disable"}
            disabled={!debug || busy !== null || Boolean(onElsewhere)}
            onChange={(on) =>
              void run(on ? "enable" : "disable", () => api.wpDebugSet(domain, on))
            }
          />
        </div>
      </div>

      {/* What the button adds, shown before it is pressed and while it is on. */}
      {debug && !onElsewhere && (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-gray-500">
          <span>{debug.standard ? "In wp-config.php:" : "Adds to wp-config.php:"}</span>
          {debug.standard_code.split("\n").map((line) => (
            <code
              key={line}
              className={clsx(
                "rounded-md px-2 py-0.5 font-mono ring-1 ring-inset",
                debug.standard ? "bg-emerald-50/60 text-emerald-800 ring-emerald-100" : "bg-white text-gray-700 ring-gray-200",
              )}
            >
              {line}
            </code>
          ))}
        </div>
      )}

      {onElsewhere && (
        <p className="mt-3 text-xs text-gray-500">
          Debug logging is already turned on in wp-config.php, outside Nexora. Change it there to turn it off.
        </p>
      )}

      {customOpen && debug && (
        <div className="mt-3.5 overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
          <div className="flex flex-wrap items-center gap-2 border-b border-gray-100 px-3.5 py-2.5">
            <p className="text-xs font-semibold text-gray-900">Custom debug code</p>
            <span
              className={clsx(
                "rounded-full px-2 py-0.5 text-[10px] font-medium",
                debug.custom_active ? "bg-emerald-50 text-emerald-700" : "bg-gray-100 text-gray-500",
              )}
            >
              {debug.custom_active ? "Inserted in wp-config.php" : "Not inserted"}
            </span>
            <span className="ml-auto text-[11px] text-gray-400">PHP, without &lt;?php tags</span>
          </div>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            rows={Math.min(10, Math.max(4, draft.split("\n").length + 1))}
            placeholder={PLACEHOLDER}
            aria-label="Custom debug code"
            className="block w-full resize-y border-0 bg-gray-950 px-3.5 py-3 font-mono text-[12px] leading-relaxed text-gray-100 placeholder:text-gray-500 focus:outline-none focus:ring-0"
          />
          <div className="flex flex-wrap items-center gap-2 bg-gray-50/70 px-3.5 py-2.5">
            <p className="mr-auto text-[11px] text-gray-500">
              {debug.custom_active
                ? "Removing takes it out of wp-config.php; it stays here to insert again."
                : "Checked by PHP first, so a mistake cannot break the site."}
            </p>
            {debug.custom_active && (
              <button
                type="button"
                onClick={() => void run("remove", () => api.wpDebugCustomRemove(domain))}
                disabled={busy !== null}
                className="inline-flex items-center gap-1.5 rounded-lg bg-white px-3 py-1.5 text-xs font-semibold text-gray-700 ring-1 ring-inset ring-gray-300 transition-colors hover:bg-gray-50 disabled:opacity-60"
              >
                {busy === "remove" && <Spinner dark />}
                {busy === "remove" ? "Removing…" : "Remove code"}
              </button>
            )}
            <button
              type="button"
              onClick={() => void run("insert", () => api.wpDebugCustomInsert(domain, draft))}
              disabled={busy !== null || !draft.trim() || (debug.custom_active && !draftChanged)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-gray-900 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-gray-800 disabled:opacity-40"
            >
              {busy === "insert" && <Spinner />}
              {busy === "insert" ? "Inserting…" : debug.custom_active ? "Update code" : "Insert code"}
            </button>
          </div>
        </div>
      )}

      {error && (
        <p role="alert" className="mt-3 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs leading-relaxed text-red-700">
          <ExclamationTriangleIcon className="mt-px h-4 w-4 flex-shrink-0" />
          <span className="break-words">{error}</span>
        </p>
      )}
    </section>
  );
}

/** An on/off switch; the knob spins while the change is being saved. */
function Switch({
  label,
  checked,
  busy,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  busy?: boolean;
  disabled?: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-busy={busy || undefined}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx(
        "relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-wp-blue/40 focus-visible:ring-offset-2 disabled:cursor-not-allowed",
        checked ? "bg-emerald-500" : "bg-gray-300",
        disabled && !busy && "opacity-60",
      )}
    >
      <span
        className={clsx(
          "grid h-5 w-5 place-items-center rounded-full bg-white shadow ring-1 ring-black/5 transition-transform duration-200",
          checked ? "translate-x-[22px]" : "translate-x-0.5",
        )}
      >
        {busy && (
          <span aria-hidden className="h-3 w-3 animate-spin rounded-full border-2 border-gray-200 border-t-gray-600" />
        )}
      </span>
    </button>
  );
}

function Spinner({ dark }: { dark?: boolean }) {
  return (
    <span
      aria-hidden
      className={clsx(
        "h-3.5 w-3.5 animate-spin rounded-full border-2",
        dark ? "border-gray-300 border-t-gray-700" : "border-white/40 border-t-white",
      )}
    />
  );
}
