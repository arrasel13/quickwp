import { useCallback, useEffect, useState } from "react";
import {
  ArrowPathIcon,
  ArrowRightEndOnRectangleIcon,
  ExclamationTriangleIcon,
  MagnifyingGlassIcon,
  SparklesIcon,
  TrashIcon,
  ShieldCheckIcon,
} from "@heroicons/react/24/outline";
import clsx from "clsx";
import { open } from "@tauri-apps/plugin-dialog";
import { api, errorText, CronEvent, WpLanguage } from "../../lib/api";
import { useAsync } from "../../lib/useAsync";
import ConfirmDialog from "../ui/ConfirmDialog";
import { Action } from "./SiteManage";
import { DatabaseTableIcon, ExportIcon, ImportIcon } from "../ui/WpIcons";

/**
 * Maintenance for one WordPress site.
 *
 * Every control is one WP-CLI subcommand. The destructive ones are the reason
 * this file has a confirmation dialog rather than a `confirm()`.
 */
/** One place for "run it, say what happened, never leave a spinner stuck". */
function useAct() {
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const act = useCallback(async (key: string, fn: () => Promise<string>) => {
    setBusy(key);
    setNote(null);
    try {
      setNote(await fn());
    } catch (e) {
      setNote(errorText(e));
    } finally {
      setBusy(null);
    }
  }, []);
  return { note, busy, act };
}

/** What the last action said, under the panels that ran it. */
function Note({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <pre className="whitespace-pre-wrap rounded-xl border border-gray-200 bg-white p-3 font-mono text-[11px] leading-relaxed text-gray-700 shadow-sm">
      {text}
    </pre>
  );
}

/** Maintenance and Backup & restore, shown in Overview beside Manage. */
export function MaintenanceAndBackup({ domain }: { domain: string }) {
  const { note, busy, act } = useAct();
  return (
    <div className="space-y-7">
      <Maintenance domain={domain} busy={busy} act={act} flat />
      <Backup domain={domain} busy={busy} act={act} flat />
      <Note text={note} />
    </div>
  );
}

export default function SiteTools({ domain }: { domain: string }) {
  const { note, busy, act } = useAct();

  return (
    <div className="space-y-4">
      <SearchReplace domain={domain} />

      <div className="grid gap-4 pane-lg:grid-cols-2">
        <div className="space-y-4">
          <Debugging domain={domain} busy={busy} act={act} />
          <Permalinks domain={domain} busy={busy} act={act} />
        </div>

        <div className="space-y-4">
          <Language domain={domain} busy={busy} act={act} />
          <Core domain={domain} busy={busy} act={act} />
        </div>
      </div>

      <SiteOptions domain={domain} />

      <Note text={note} />
    </div>
  );
}

type Act = (key: string, fn: () => Promise<string>) => Promise<void>;

function Panel({
  title,
  flat,
  children,
}: {
  title: string;
  /** A heading over the rows, as Manage has, rather than a card. */
  flat?: boolean;
  children: React.ReactNode;
}) {
  if (flat)
    return (
      <section>
        <h2 className="mb-3 text-sm font-semibold text-gray-900">{title}</h2>
        {children}
      </section>
    );
  return (
    <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <h4 className="mb-3 text-sm font-semibold text-gray-900">{title}</h4>
      {children}
    </section>
  );
}

const btn =
  "w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50";
const field =
  "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/30";

function Toggle({
  on,
  busy,
  onChange,
}: {
  on: boolean;
  busy?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      role="switch"
      aria-checked={on}
      disabled={busy}
      onClick={() => onChange(!on)}
      className={clsx(
        "relative h-6 w-11 flex-shrink-0 rounded-full transition-colors disabled:opacity-50",
        on ? "bg-blue-600" : "bg-gray-300",
      )}
    >
      <span
        className={clsx(
          "absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform",
          on ? "translate-x-5" : "translate-x-0",
        )}
      />
    </button>
  );
}

// -------------------------------------------------------- search & replace

function SearchReplace({ domain }: { domain: string }) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [dryRun, setDryRun] = useState(true);
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const go = async (dry: boolean) => {
    setBusy(true);
    setResult(null);
    try {
      setResult(await api.wpSearchReplace(domain, from.trim(), to.trim(), dry));
    } catch (e) {
      setResult(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const ready = Boolean(from.trim() && to.trim());

  return (
    <Panel title="Search & replace">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          placeholder="old (e.g. old.test)"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          className={clsx(field, "min-w-0 flex-1 font-mono text-xs")}
        />
        <span className="text-gray-400">→</span>
        <input
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder={`new (e.g. ${domain})`}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          className={clsx(field, "min-w-0 flex-1 font-mono text-xs")}
        />
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-xs text-gray-700">
          <input
            type="checkbox"
            checked={dryRun}
            onChange={(e) => setDryRun(e.target.checked)}
            className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-2 focus:ring-blue-500/30"
          />
          Dry run (report only, don't change data)
        </label>

        <button
          disabled={busy || !ready}
          onClick={() => (dryRun ? void go(true) : setConfirming(true))}
          className={clsx(
            "inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50",
            dryRun
              ? "border border-gray-300 bg-white text-gray-700 hover:bg-gray-50"
              : "bg-blue-600 text-white hover:bg-blue-700",
          )}
        >
          <MagnifyingGlassIcon className="h-4 w-4" />
          {busy ? "Working…" : dryRun ? "Preview" : "Replace"}
        </button>
      </div>

      {result && (
        <pre className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-gray-50 p-3 font-mono text-[11px] leading-relaxed text-gray-700">
          {result}
        </pre>
      )}

      <ConfirmDialog
        open={confirming}
        title="Replace across the database?"
        body={
          <>
            Every occurrence of <span className="font-mono">{from}</span>{" "}
            becomes <span className="font-mono">{to}</span>, in every table
            including inside serialised values. There is no undo — export the
            database first if you are unsure.
          </>
        }
        confirmLabel="Replace"
        busy={busy}
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          void go(false);
        }}
      />
    </Panel>
  );
}

// --------------------------------------------------------------- debugging

const DEBUG_CONSTANTS = [
  ["WP_DEBUG_LOG", "write errors to wp-content/debug.log"],
  ["WP_DEBUG_DISPLAY", "print errors on pages"],
  ["SCRIPT_DEBUG", "use unminified core JS/CSS"],
] as const;

function Debugging({
  domain,
  busy,
  act,
}: {
  domain: string;
  busy: string | null;
  act: Act;
}) {
  const [flags, setFlags] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    const keys = ["WP_DEBUG", ...DEBUG_CONSTANTS.map(([k]) => k)];
    const entries = await Promise.all(
      keys.map(async (k) => {
        try {
          const v = await api.wpConfigGet(domain, k);
          // Undefined and "false" are both off; only a true literal is on.
          return [k, v === "true" || v === "1"] as const;
        } catch {
          return [k, false] as const;
        }
      }),
    );
    setFlags(Object.fromEntries(entries));
  }, [domain]);

  useEffect(() => {
    void load();
  }, [load]);

  const setOne = (key: string, on: boolean) =>
    void act(key, async () => {
      const msg = await api.wpConfigSetBool(domain, key, on);
      await load();
      return msg;
    });

  // The recommended trio for local work: log everything, show nothing. Errors
  // printed into a page break JSON responses and leak into markup.
  const setTrio = (on: boolean) =>
    void act("WP_DEBUG", async () => {
      await api.wpConfigSetBool(domain, "WP_DEBUG", on);
      await api.wpConfigSetBool(domain, "WP_DEBUG_LOG", on);
      await api.wpConfigSetBool(domain, "WP_DEBUG_DISPLAY", false);
      await load();
      return on
        ? "WP_DEBUG on, logging to wp-content/debug.log, display off."
        : "Debugging off.";
    });

  return (
    <Panel title="Debugging">
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3 border-b border-gray-100 pb-3">
          <p className="text-xs text-gray-700">
            <span className="font-mono font-medium text-gray-900">WP_DEBUG</span>{" "}
            — sets the recommended trio (log on, display off).
          </p>
          <Toggle
            on={flags.WP_DEBUG ?? false}
            busy={busy === "WP_DEBUG"}
            onChange={setTrio}
          />
        </div>

        {DEBUG_CONSTANTS.map(([key, blurb]) => (
          <div key={key} className="flex items-center justify-between gap-3">
            <p className="text-xs text-gray-700">
              <span className="font-mono font-medium text-gray-900">{key}</span>{" "}
              — {blurb}
            </p>
            <Toggle
              on={flags[key] ?? false}
              busy={busy === key}
              onChange={(v) => setOne(key, v)}
            />
          </div>
        ))}

        <button
          onClick={() =>
            void api
              .wpMagicLogin(domain, "admin")
              .catch((e) => alert(errorText(e)))
          }
          className={clsx(btn, "mt-1 inline-flex items-center justify-center gap-1.5")}
        >
          <ArrowRightEndOnRectangleIcon className="h-4 w-4" />
          One-click admin login
        </button>
      </div>
    </Panel>
  );
}

// ------------------------------------------------------------- maintenance

function Maintenance({
  domain,
  busy,
  act,
  flat,
}: {
  domain: string;
  busy: string | null;
  act: Act;
  flat?: boolean;
}) {
  const [on, setOn] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  const load = useCallback(async () => {
    try {
      setOn(await api.wpMaintenanceStatus(domain));
    } catch {
      setOn(false);
    }
  }, [domain]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Panel title="Maintenance" flat={flat}>
      <div className="grid gap-2.5">
        <div className="flex items-center justify-between gap-3 rounded-md border border-gray-300 bg-white px-3.5 py-2.5">
          <p className="text-[13px] text-gray-800">
            <span className="font-semibold text-gray-900">Maintenance mode</span> — visitors see
            "briefly unavailable".
          </p>
          <Toggle
            on={on}
            busy={busy === "maintenance"}
            onChange={(v) =>
              void act("maintenance", async () => {
                const msg = await api.wpSetMaintenance(domain, v);
                await load();
                return msg;
              })
            }
          />
        </div>

        <Action
          icon={SparklesIcon}
          label={busy === "cache" ? "Flushing…" : "Flush object cache"}
          busy={busy === "cache"}
          disabled={busy !== null}
          onClick={() => void act("cache", () => api.wpFlushCache(domain))}
        />
        <Action
          icon={TrashIcon}
          label={busy === "transients" ? "Deleting…" : "Delete all transients"}
          busy={busy === "transients"}
          disabled={busy !== null}
          onClick={() => void act("transients", () => api.wpDeleteTransients(domain))}
        />
        <Action
          icon={ExclamationTriangleIcon}
          label={busy === "reset" ? "Erasing…" : "Erase database & reset site"}
          busy={busy === "reset"}
          destructive
          disabled={busy !== null}
          onClick={() => setConfirmReset(true)}
        />
      </div>

      <ConfirmDialog
        open={confirmReset}
        title="Erase this site's database?"
        body={
          <>
            Every table is dropped — posts, users, plugin settings, everything.
            The files in wp-content stay, but{" "}
            <span className="font-medium text-gray-900">{domain}</span> will
            have no WordPress install until you set one up again. There is no
            undo.
          </>
        }
        confirmLabel="Erase everything"
        busy={busy === "reset"}
        onCancel={() => setConfirmReset(false)}
        onConfirm={() => {
          setConfirmReset(false);
          void act("reset", () => api.wpResetSite(domain));
        }}
      />
    </Panel>
  );
}

// ------------------------------------------------------------------ backup

function Backup({
  domain,
  busy,
  act,
  flat,
}: {
  domain: string;
  busy: string | null;
  act: Act;
  flat?: boolean;
}) {
  const [confirmImport, setConfirmImport] = useState<string | null>(null);

  const pickSql = async () => {
    try {
      const picked = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "SQL dump", extensions: ["sql"] }],
      });
      if (typeof picked === "string") setConfirmImport(picked);
    } catch (e) {
      alert(errorText(e));
    }
  };

  return (
    <Panel title="Backup & restore" flat={flat}>
      <div className="grid gap-2.5">
        <Action
          icon={DatabaseTableIcon}
          label={busy === "export-db" ? "Exporting…" : "Export database"}
          busy={busy === "export-db"}
          disabled={busy !== null}
          onClick={() =>
            void act("export-db", async () => {
              const path = await api.wpExportDatabase(domain);
              return `Database exported to ${path}`;
            })
          }
        />
        <Action
          icon={ImportIcon}
          label={busy === "import-db" ? "Importing…" : "Import database…"}
          busy={busy === "import-db"}
          disabled={busy !== null}
          onClick={() => void pickSql()}
        />
        <Action
          icon={ExportIcon}
          label={busy === "export-wxr" ? "Exporting…" : "Export content (WXR)"}
          busy={busy === "export-wxr"}
          disabled={busy !== null}
          onClick={() => void act("export-wxr", () => api.wpExportContent(domain))}
        />
      </div>

      <ConfirmDialog
        open={confirmImport !== null}
        title="Import this database?"
        body={
          <>
            <span className="break-all font-mono text-[11px]">
              {confirmImport}
            </span>
            <br />
            <br />
            Importing replaces the tables it contains. Export the current
            database first if you might want it back.
          </>
        }
        confirmLabel="Import"
        busy={busy === "import-db"}
        onCancel={() => setConfirmImport(null)}
        onConfirm={() => {
          const file = confirmImport;
          setConfirmImport(null);
          if (file) void act("import-db", () => api.wpImportDatabase(domain, file));
        }}
      />
    </Panel>
  );
}

// -------------------------------------------------------------- permalinks

const PERMALINK_STRUCTURES: [string, string, string][] = [
  ["", "Plain", "?p=123"],
  ["/%year%/%monthnum%/%day%/%postname%/", "Day and name", "/2026/09/09/sample-post/"],
  ["/%year%/%monthnum%/%postname%/", "Month and name", "/2026/09/sample-post/"],
  ["/archives/%post_id%", "Numeric", "/archives/123"],
  ["/%postname%/", "Post name", "/sample-post/"],
];

function Permalinks({
  domain,
  busy,
  act,
}: {
  domain: string;
  busy: string | null;
  act: Act;
}) {
  const [structure, setStructure] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setStructure(await api.wpOptionGet(domain, "permalink_structure"));
    } catch {
      setStructure("");
    }
  }, [domain]);

  useEffect(() => {
    void load();
  }, [load]);

  const known = PERMALINK_STRUCTURES.find(([v]) => v === structure);

  return (
    <Panel title="Permalinks">
      <select
        value={structure ?? ""}
        disabled={busy === "permalinks" || structure === null}
        onChange={(e) =>
          void act("permalinks", async () => {
            const msg = await api.wpSetPermalinks(domain, e.target.value);
            await load();
            return msg;
          })
        }
        className={field}
      >
        {/* A structure set outside Nexora is kept and shown rather than
            silently snapped to one of ours. */}
        {structure !== null && !known && (
          <option value={structure}>Custom — {structure || "(empty)"}</option>
        )}
        {PERMALINK_STRUCTURES.map(([value, label, sample]) => (
          <option key={label} value={value}>
            {label} — {sample}
          </option>
        ))}
      </select>

      <p className="mt-2 font-mono text-[11px] text-gray-500">
        {known ? `${known[2]} (${known[1].toLowerCase()})` : structure || "—"}
      </p>

      <button
        disabled={busy === "rewrites"}
        onClick={() => void act("rewrites", () => api.wpFlushRewrites(domain))}
        className={clsx(btn, "mt-3")}
      >
        {busy === "rewrites" ? "Regenerating…" : "Regenerate permalinks"}
      </button>
    </Panel>
  );
}

// ---------------------------------------------------------------- language

function Language({
  domain,
  busy,
  act,
}: {
  domain: string;
  busy: string | null;
  act: Act;
}) {
  const { data: languages, reload } = useAsync(
    () => api.wpLanguages(domain),
    [domain],
    `wp-languages:${domain}`,
  );

  const list: WpLanguage[] = languages ?? [];
  const active = list.find((l) => l.status === "active");

  return (
    <Panel title="Language">
      <select
        value={active?.language ?? "en_US"}
        disabled={busy === "language" || list.length === 0}
        onChange={(e) =>
          void act("language", async () => {
            const msg = await api.wpSetLanguage(domain, e.target.value);
            await reload();
            return msg;
          })
        }
        className={field}
      >
        {list.length === 0 ? (
          <option>Loading…</option>
        ) : (
          list.map((l) => (
            <option key={l.language} value={l.language}>
              {l.english_name} · {l.language}
            </option>
          ))
        )}
      </select>
      <p className="mt-2 text-[11px] leading-relaxed text-gray-500">
        Core translations only — plugins and themes fetch their own packs.
      </p>
    </Panel>
  );
}

// -------------------------------------------------------------------- core

function Core({
  domain,
  busy,
  act,
}: {
  domain: string;
  busy: string | null;
  act: Act;
}) {
  const { data: version, reload } = useAsync(
    () => api.wpCoreVersion(domain),
    [domain],
    `wp-core-version:${domain}`,
  );
  const [target, setTarget] = useState("");
  const [confirmSwitch, setConfirmSwitch] = useState(false);
  const [available, setAvailable] = useState<string[]>([]);

  // The same wordpress.org list the New Site dialog uses.
  useEffect(() => {
    let cancelled = false;
    void fetch("https://api.wordpress.org/core/stable-check/1.0/")
      .then((r) => r.json())
      .then((all: Record<string, string>) => {
        if (cancelled) return;
        const cmp = (a: string, b: string) => {
          const x = a.split(".").map(Number);
          const y = b.split(".").map(Number);
          for (let i = 0; i < 3; i++)
            if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
          return 0;
        };
        const newest = new Map<string, string>();
        for (const v of Object.keys(all)) {
          const line = v.split(".").slice(0, 2).join(".");
          const held = newest.get(line);
          if (!held || cmp(v, held) < 0) newest.set(line, v);
        }
        setAvailable([...newest.values()].sort(cmp).slice(0, 8));
      })
      .catch(() => {
        /* offline: the picker stays empty and the other buttons still work */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Panel title="Core">
      <div className="space-y-3">
        <button
          disabled={busy === "core-update"}
          onClick={() =>
            void act("core-update", async () => {
              const msg = await api.wpCoreUpdate(domain, null);
              await reload();
              return msg;
            })
          }
          className={clsx(btn, "inline-flex items-center justify-center gap-1.5")}
        >
          <ArrowPathIcon className="h-4 w-4" />
          {busy === "core-update" ? "Updating…" : "Update core"}
        </button>

        <button
          disabled={busy === "core-reinstall"}
          onClick={() =>
            void act("core-reinstall", () => api.wpCoreReinstall(domain))
          }
          className={btn}
        >
          {busy === "core-reinstall" ? "Re-installing…" : "Re-install core"}
        </button>

        <button
          disabled={busy === "checksums"}
          onClick={() =>
            void act("checksums", () => api.wpVerifyChecksums(domain))
          }
          className={clsx(btn, "inline-flex items-center justify-center gap-1.5")}
        >
          <ShieldCheckIcon className="h-4 w-4" />
          {busy === "checksums" ? "Verifying…" : "Verify core checksums"}
        </button>

        <div className="border-t border-gray-100 pt-3">
          <p className="mb-2 text-xs text-gray-500">
            Core version ·{" "}
            <span className="font-mono text-gray-900">{version ?? "…"}</span>
          </p>

          <div className="flex flex-wrap items-center gap-2">
            <select
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              className={clsx(field, "min-w-0 flex-1")}
            >
              <option value="">Pick a version…</option>
              {available.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
            <button
              disabled={busy === "export-db"}
              onClick={() =>
                void act("export-db", async () => {
                  const path = await api.wpExportDatabase(domain);
                  return `Database exported to ${path}`;
                })
              }
              className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50"
            >
              Export DB first
            </button>
            <button
              disabled={!target || busy === "switch"}
              onClick={() => setConfirmSwitch(true)}
              className="rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Switch version
            </button>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={confirmSwitch}
        title={`Switch core to ${target}?`}
        body={
          <>
            Core files are replaced with {target}. Going backwards from{" "}
            {version} is a downgrade — WordPress does not migrate a database
            back, so export it first if this site has data you care about.
          </>
        }
        confirmLabel="Switch"
        destructive={false}
        busy={busy === "switch"}
        onCancel={() => setConfirmSwitch(false)}
        onConfirm={() => {
          setConfirmSwitch(false);
          void act("switch", async () => {
            const msg = await api.wpCoreUpdate(domain, target);
            await reload();
            return msg;
          });
        }}
      />
    </Panel>
  );
}

// ------------------------------------------------------------- site options

const OPTION_FIELDS: {
  key: string;
  label: string;
  /** "timezone" is a slot marker: that field is two options, not one. */
  kind: "text" | "select" | "timezone";
  choices?: [string, string][];
}[] = [
  { key: "blogname", label: "Site title", kind: "text" },
  { key: "blogdescription", label: "Tagline", kind: "text" },
  { key: "admin_email", label: "Admin email", kind: "text" },
  { key: "timezone_string", label: "Timezone", kind: "timezone" },
  { key: "date_format", label: "Date format", kind: "text" },
  { key: "time_format", label: "Time format", kind: "text" },
  {
    key: "start_of_week",
    label: "Week starts on",
    kind: "select",
    choices: [
      ["0", "Sunday"],
      ["1", "Monday"],
      ["2", "Tuesday"],
      ["3", "Wednesday"],
      ["4", "Thursday"],
      ["5", "Friday"],
      ["6", "Saturday"],
    ],
  },
  { key: "posts_per_page", label: "Posts per page", kind: "text" },
  {
    key: "default_role",
    label: "New user default role",
    kind: "select",
    choices: [
      ["subscriber", "Subscriber"],
      ["contributor", "Contributor"],
      ["author", "Author"],
      ["editor", "Editor"],
      ["administrator", "Administrator"],
    ],
  },
  {
    key: "users_can_register",
    label: "Anyone can register",
    kind: "select",
    choices: [
      ["0", "No"],
      ["1", "Yes"],
    ],
  },
  {
    key: "blog_public",
    label: "Visible to search engines",
    kind: "select",
    choices: [
      ["1", "Yes"],
      ["0", "No"],
    ],
  },
];

/**
 * WordPress keeps the timezone in one of two options, never both:
 * `timezone_string` for a city ("Asia/Dhaka"), or `gmt_offset` for a fixed
 * UTC offset. Reading only the first shows an empty box on the very common
 * default, where the string is unset and the offset is 0.
 *
 * Saving mirrors what wp-admin does: whichever one you pick is written and the
 * other is cleared, so they can never disagree.
 */
function TimezoneField({ domain }: { domain: string }) {
  const [value, setValue] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const [zone, offset] = await Promise.all([
        api.wpOptionGet(domain, "timezone_string"),
        api.wpOptionGet(domain, "gmt_offset"),
      ]);
      setValue(zone.trim() ? zone.trim() : `UTC${formatOffset(offset)}`);
    } catch {
      setValue("UTC+0");
    }
  }, [domain]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (next: string) => {
    setSaving(true);
    setValue(next);
    try {
      if (next.startsWith("UTC")) {
        const offset = next.slice(3);
        await api.wpOptionSet(domain, "gmt_offset", offset === "+0" ? "0" : offset);
        await api.wpOptionSet(domain, "timezone_string", "");
      } else {
        await api.wpOptionSet(domain, "timezone_string", next);
        await api.wpOptionSet(domain, "gmt_offset", "");
      }
    } catch (e) {
      alert(errorText(e));
      await load();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex items-center gap-3">
      <label className="w-36 flex-shrink-0 text-xs text-gray-600">Timezone</label>
      <select
        value={value ?? ""}
        disabled={saving || value === null}
        onChange={(e) => void save(e.target.value)}
        className={clsx(field, "min-w-0 flex-1")}
      >
        {value === null && <option value="">Loading…</option>}
        {/* A zone the machine's Intl does not know about still has to be
            selectable, or opening this panel would silently change it. */}
        {value !== null && !value.startsWith("UTC") && !ZONES.includes(value) && (
          <option value={value}>{value}</option>
        )}
        <optgroup label="UTC offset">
          {UTC_OFFSETS.map((o) => (
            <option key={o} value={`UTC${o}`}>
              {o === "+0" ? "None (UTC offset)" : `UTC${o}`}
            </option>
          ))}
        </optgroup>
        <optgroup label="City">
          {ZONES.map((z) => (
            <option key={z} value={z}>
              {z.replace(/_/g, " ")}
            </option>
          ))}
        </optgroup>
      </select>
    </div>
  );
}

/** "0" and "6" and "5.75" all have to come back as WordPress writes them. */
function formatOffset(raw: string): string {
  const n = Number(raw);
  if (!Number.isFinite(n)) return "+0";
  return n >= 0 ? `+${n}` : `${n}`;
}

/**
 * The offsets wp-admin offers: half-hour steps, plus the four quarter-hour
 * zones that actually exist (Nepal, Chatham, and the Pacific pair).
 */
const UTC_OFFSETS: string[] = (() => {
  const out: number[] = [];
  for (let n = -12; n <= 14; n += 0.5) out.push(n);
  out.push(5.75, 8.75, 12.75, 13.75);
  return [...new Set(out)]
    .sort((a, b) => a - b)
    .map((n) => (n >= 0 ? `+${n}` : `${n}`));
})();

/**
 * IANA zone names from the platform. `supportedValuesOf` is the same list PHP
 * builds wp-admin's dropdown from; the fallback keeps the control usable on a
 * runtime that lacks it rather than rendering an empty menu.
 */
const ZONES: string[] = (() => {
  try {
    const intl = Intl as typeof Intl & {
      supportedValuesOf?: (key: string) => string[];
    };
    const list = intl.supportedValuesOf?.("timeZone");
    if (list?.length) return list;
  } catch {
    /* fall through */
  }
  return [
    "UTC",
    "America/New_York",
    "America/Chicago",
    "America/Denver",
    "America/Los_Angeles",
    "America/Sao_Paulo",
    "Europe/London",
    "Europe/Berlin",
    "Europe/Paris",
    "Europe/Moscow",
    "Africa/Cairo",
    "Africa/Lagos",
    "Asia/Dhaka",
    "Asia/Kolkata",
    "Asia/Dubai",
    "Asia/Shanghai",
    "Asia/Tokyo",
    "Asia/Singapore",
    "Australia/Sydney",
    "Pacific/Auckland",
  ];
})();

function SiteOptions({ domain }: { domain: string }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      OPTION_FIELDS.filter((f) => f.kind !== "timezone").map(async (f) => {
        try {
          return [f.key, await api.wpOptionGet(domain, f.key)] as const;
        } catch {
          return [f.key, ""] as const;
        }
      }),
    ).then((entries) => {
      if (!cancelled) setValues(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [domain]);

  const save = async (key: string, value: string) => {
    setSaving(key);
    setNote(null);
    try {
      await api.wpOptionSet(domain, key, value);
      setNote(`${key} saved.`);
    } catch (e) {
      setNote(errorText(e));
    } finally {
      setSaving(null);
    }
  };

  return (
    <Panel title="Site options">
      <div className="grid gap-x-6 gap-y-3 pane-sm:grid-cols-2">
        {OPTION_FIELDS.map((f) =>
          f.kind === "timezone" ? (
            <TimezoneField key={f.key} domain={domain} />
          ) : (
          <div key={f.key} className="flex items-center gap-3">
            <label className="w-36 flex-shrink-0 text-xs text-gray-600">
              {f.label}
            </label>
            {f.kind === "select" ? (
              <select
                value={values[f.key] ?? ""}
                disabled={saving === f.key}
                onChange={(e) => {
                  setValues((v) => ({ ...v, [f.key]: e.target.value }));
                  void save(f.key, e.target.value);
                }}
                className={clsx(field, "min-w-0 flex-1")}
              >
                {f.choices?.map(([v, label]) => (
                  <option key={v} value={v}>
                    {label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                value={values[f.key] ?? ""}
                disabled={saving === f.key}
                onChange={(e) =>
                  setValues((v) => ({ ...v, [f.key]: e.target.value }))
                }
                // Saved on blur, not per keystroke: each save is a WP-CLI
                // process, and one per character would be absurd.
                onBlur={(e) => void save(f.key, e.target.value)}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                className={clsx(field, "min-w-0 flex-1")}
              />
            )}
          </div>
          ),
        )}
      </div>

      <p className="mt-3 text-[11px] leading-relaxed text-gray-500">
        Only this curated, known-safe set is editable — site URLs, plugin/theme
        state and serialized options can't be changed here. Text fields save
        when you click away; there is no undo.
      </p>

      {note && <p className="mt-2 text-[11px] text-gray-600">{note}</p>}
    </Panel>
  );
}

// -------------------------------------------------------------------- cron

/** A site's scheduled events, filling the preview pane. */
export function SiteCron({ domain }: { domain: string }) {
  return (
    <div className="h-full overflow-y-auto bg-white p-4">
      <Cron domain={domain} flat />
    </div>
  );
}

function Cron({ domain, flat }: { domain: string; flat?: boolean }) {
  const { data, error, loading, reload } = useAsync(
    () => api.wpCronEvents(domain),
    [domain],
    `wp-cron:${domain}`,
  );
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const events: CronEvent[] = data ?? [];
  const shown = query.trim()
    ? events.filter((e) =>
        e.hook.toLowerCase().includes(query.trim().toLowerCase()),
      )
    : events;

  const run = async (hook: string | null) => {
    setBusy(hook ?? "due");
    try {
      const msg = await api.wpCronRun(domain, hook);
      await reload();
      if (msg) alert(msg);
    } catch (e) {
      alert(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Panel title="Cron" flat={flat}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-gray-500">
          {/* Overdue events are the normal state here, and saying so stops
              them reading as a fault. */}
          {events.length} scheduled event{events.length === 1 ? "" : "s"} —
          local dev has no visitors, so overdue events are normal; run them on
          demand.
        </p>
        <button
          disabled={busy !== null}
          onClick={() => void run(null)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-2 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50"
        >
          <ArrowPathIcon
            className={clsx("h-4 w-4", busy === "due" && "animate-spin")}
          />
          Run due now
        </button>
      </div>

      <div className="relative mb-3">
        <MagnifyingGlassIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search hooks…"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          className={clsx(field, "w-64 pl-9")}
        />
      </div>

      {/* A real table, not a grid per row: the header and the rows have to
          share column widths, and separate grid containers cannot -- the
          `auto` column collapsed to nothing in the header and to the button's
          width in each row, so no column lined up. */}
      <div className="overflow-x-auto rounded-lg border border-gray-200">
        <table className="w-full min-w-[36rem] border-collapse text-left">
          <thead>
            <tr className="border-b border-gray-200 bg-gray-50">
              <th className="px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                Hook
              </th>
              <th className="px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                Arguments
              </th>
              <th className="px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                Next run
              </th>
              <th className="px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                Recurrence
              </th>
              <th className="w-px px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-xs text-gray-500">
                  Loading…
                </td>
              </tr>
            ) : error ? (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-xs text-red-700">
                  {error}
                </td>
              </tr>
            ) : shown.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-xs text-gray-500">
                  {events.length === 0 ? "Nothing scheduled." : "No hook matches."}
                </td>
              </tr>
            ) : (
              shown.map((e, i) => (
                <tr
                  key={`${e.hook}-${i}`}
                  className="border-t border-gray-100 align-middle"
                >
                  <td className="px-3 py-2 font-mono text-xs text-gray-900">
                    {e.hook}
                  </td>
                  <td className="px-3 py-2 font-mono text-[11px] text-gray-400">
                    {e.args || "—"}
                  </td>
                  <td
                    className={clsx(
                      "whitespace-nowrap px-3 py-2 text-[11px]",
                      e.next_run_relative === "now"
                        ? "font-medium text-amber-600"
                        : "text-gray-500",
                    )}
                  >
                    {e.next_run_relative}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-[11px] text-gray-500">
                    {e.recurrence}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      disabled={busy !== null}
                      onClick={() => void run(e.hook)}
                      className="rounded-md border border-gray-300 bg-white px-2.5 py-1 text-[11px] font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50"
                    >
                      {busy === e.hook ? "…" : "Run"}
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
