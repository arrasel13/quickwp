import { useEffect, useState } from "react";
import { ExclamationTriangleIcon } from "@heroicons/react/24/outline";
import clsx from "clsx";
import { api, errorText, type Site, type WpDebugState } from "../../lib/api";
import { useDebugState, useSettingsSnapshot } from "../../lib/wpSettings";
import { Panel, Toggle } from "./SiteTools";

/** The constants worth a switch, beside WP_DEBUG itself. */
const DEBUG_CONSTANTS = [
  ["WP_DEBUG_LOG", "write errors to wp-content/debug.log"],
  ["WP_DEBUG_DISPLAY", "print errors on pages"],
  ["SCRIPT_DEBUG", "use unminified core JS/CSS"],
] as const;

const PLACEHOLDER = `define( 'WP_DEBUG_DISPLAY', false );
define( 'SCRIPT_DEBUG', true );
define( 'SAVEQUERIES', true );`;

/**
 * Debugging for one WordPress site: wp-config.php's switches, and the site's
 * own debug code. Everything written here is checked by PHP first, so a
 * mistake cannot take the site down.
 */
export default function SiteDebugging({
  site,
  onChanged,
}: {
  site: Site;
  /** Re-reads the site list: Xdebug is a property of the site. */
  onChanged: () => Promise<void> | void;
}) {
  const domain = site.domain;
  return (
    <div className="p-4">
      <Panel title="Debugging">
        <Constants domain={domain} />
        <Rule />
        <CustomCode domain={domain} />
        <Rule />
        <Xdebug site={site} onChanged={onChanged} />
      </Panel>
    </div>
  );
}

/** What separates the parts of the one panel. */
function Rule() {
  return <div className="my-4 h-px bg-gray-200" />;
}

// ------------------------------------------------------------- wp-config.php

function Constants({ domain }: { domain: string }) {
  const snapshot = useSettingsSnapshot(domain);
  const { reload: reloadDebug } = useDebugState(domain);
  const flags: Record<string, boolean> = snapshot.data?.constants ?? {};
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const write = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      await Promise.all([snapshot.reload(), reloadDebug()]);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  // The recommended trio for local work: log everything, show nothing. Errors
  // printed into a page break JSON responses and leak into markup.
  const setTrio = (on: boolean) =>
    void write("WP_DEBUG", async () => {
      await api.wpConfigSetBool(domain, "WP_DEBUG", on);
      await api.wpConfigSetBool(domain, "WP_DEBUG_LOG", on);
      await api.wpConfigSetBool(domain, "WP_DEBUG_DISPLAY", false);
    });

  return (
    <div>
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3 border-b border-gray-100 pb-3">
          <p className="text-xs text-gray-700">
            <span className="font-mono font-medium text-gray-900">WP_DEBUG</span> — sets the
            recommended trio (log on, display off).
          </p>
          <Toggle on={flags.WP_DEBUG ?? false} busy={busy === "WP_DEBUG"} onChange={setTrio} />
        </div>

        {DEBUG_CONSTANTS.map(([key, blurb]) => (
          <div key={key} className="flex items-center justify-between gap-3">
            <p className="text-xs text-gray-700">
              <span className="font-mono font-medium text-gray-900">{key}</span> — {blurb}
            </p>
            <Toggle
              on={flags[key] ?? false}
              busy={busy === key}
              onChange={(v) => void write(key, () => api.wpConfigSetBool(domain, key, v))}
            />
          </div>
        ))}
      </div>

      {error && <Error text={error} />}
    </div>
  );
}

// ------------------------------------------------------------- custom code

function CustomCode({ domain }: { domain: string }) {
  const { data: debug, setData } = useDebugState(domain);
  const [busy, setBusy] = useState<"insert" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The code being edited. It starts from what the site has, and is left
  // alone after that: typing must not be overwritten by a refresh.
  const [draft, setDraft] = useState("");
  const [edited, setEdited] = useState(false);

  useEffect(() => {
    if (debug && !edited) setDraft(debug.custom_code);
  }, [debug, edited]);

  useEffect(() => {
    setEdited(false);
  }, [domain]);

  const run = async (
    kind: "insert" | "remove",
    fn: () => Promise<WpDebugState>,
    /** Emptied on purpose: the box stays empty rather than filling again
     *  with the code that was just taken out. */
    emptied = false,
  ) => {
    setBusy(kind);
    setError(null);
    try {
      const next = await fn();
      setData(next);
      setDraft(emptied ? "" : next.custom_code);
      setEdited(emptied);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const changed = debug ? draft.trim() !== debug.custom_code.trim() : false;
  // An empty box saved over inserted code takes it out of wp-config.php.
  const clearing = Boolean(debug?.custom_active) && !draft.trim();

  return (
    <div>
      <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
        <div className="flex flex-wrap items-center gap-2 border-b border-gray-100 px-3.5 py-2.5">
          <p className="text-xs font-semibold text-gray-900">Custom debug code</p>
          <span
            className={clsx(
              "rounded-full px-2 py-0.5 text-[10px] font-medium",
              debug?.custom_active ? "bg-emerald-50 text-emerald-700" : "bg-gray-100 text-gray-500",
            )}
          >
            {debug?.custom_active ? "Inserted in wp-config.php" : "Not inserted"}
          </span>
          <span className="ml-auto text-[11px] text-gray-400">PHP, without &lt;?php tags</span>
        </div>

        <textarea
          value={draft}
          onChange={(e) => {
            setEdited(true);
            setDraft(e.target.value);
          }}
          spellCheck={false}
          disabled={!debug}
          rows={Math.min(14, Math.max(5, draft.split("\n").length + 1))}
          placeholder={PLACEHOLDER}
          aria-label="Custom debug code"
          className="block w-full resize-y border-0 bg-gray-950 px-3.5 py-3 font-mono text-[12px] leading-relaxed text-gray-100 placeholder:text-gray-500 focus:outline-none focus:ring-0"
        />

        <div className="flex flex-wrap items-center gap-2 bg-gray-50/70 px-3.5 py-2.5">
          <p className="mr-auto text-[11px] text-gray-500">
            {debug?.custom_active
              ? "Removing takes it out of wp-config.php; it stays here to insert again."
              : "Checked by PHP first, so a mistake cannot break the site."}
          </p>
          {debug?.custom_active && (
            <button
              type="button"
              onClick={() => void run("remove", () => api.wpDebugCustomRemove(domain))}
              disabled={busy !== null}
              className="inline-flex items-center gap-1.5 rounded-lg bg-white px-3 py-1.5 text-xs font-semibold text-gray-700 ring-1 ring-inset ring-gray-300 transition-colors hover:bg-gray-50 disabled:opacity-60"
            >
              {busy === "remove" && !clearing && <Spinner dark />}
              {busy === "remove" && !clearing ? "Removing…" : "Remove code"}
            </button>
          )}
          <button
            type="button"
            onClick={() =>
              void (clearing
                ? run("remove", () => api.wpDebugCustomRemove(domain), true)
                : run("insert", () => api.wpDebugCustomInsert(domain, draft)))
            }
            disabled={
              !debug ||
              busy !== null ||
              (debug.custom_active ? !changed : !draft.trim())
            }
            className="inline-flex items-center gap-1.5 rounded-lg bg-gray-900 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-gray-800 disabled:opacity-40"
          >
            {(busy === "insert" || (clearing && busy === "remove")) && <Spinner />}
            {busy === "insert"
              ? "Inserting…"
              : clearing && busy === "remove"
                ? "Removing…"
                : debug?.custom_active
                  ? "Update code"
                  : "Insert code"}
          </button>
        </div>
      </div>

      {debug && (
        <p className="mt-2 font-mono text-[11px] text-gray-400" title={debug.config_path}>
          {debug.config_path}
        </p>
      )}

      {error && <Error text={error} />}
    </div>
  );
}

// ------------------------------------------------------------------ xdebug

function Xdebug({ site, onChanged }: { site: Site; onChanged: () => Promise<void> | void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div>
      <h4 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
        Xdebug
      </h4>
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs leading-relaxed text-gray-700">
          Step debugging for this site only — its PHP moves to a separate debug pool with Xdebug
          loaded; every other site stays on the shared pool at full speed.
        </p>
        <Toggle
          on={site.xdebug}
          busy={busy}
          onChange={(on) =>
            void (async () => {
              setBusy(true);
              setError(null);
              try {
                await api.siteSetXdebug(site.domain, on);
                await onChanged();
              } catch (e) {
                setError(errorText(e));
              } finally {
                setBusy(false);
              }
            })()
          }
        />
      </div>
      {error && <Error text={error} />}
    </div>
  );
}

function Error({ text }: { text: string }) {
  return (
    <p
      role="alert"
      className="mt-3 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs leading-relaxed text-red-700"
    >
      <ExclamationTriangleIcon className="mt-px h-4 w-4 flex-shrink-0" />
      <span className="break-words">{text}</span>
    </p>
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
