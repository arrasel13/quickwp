import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowPathIcon,
  ExclamationTriangleIcon,
  MagnifyingGlassIcon,
  SparklesIcon,
  TrashIcon,
  ShieldCheckIcon,
} from "@heroicons/react/24/outline";
import clsx from "clsx";
import { api, errorText, CronEvent, WpLanguage } from "../../lib/api";
import { useAsync } from "../../lib/useAsync";
import { useCoreUpdate, useSettingsSnapshot, type Snapshot } from "../../lib/wpSettings";
import ConfirmDialog from "../ui/ConfirmDialog";
import { Action } from "./SiteManage";

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

/** Maintenance, shown in Overview under Manage. */
export function MaintenanceSection({ domain }: { domain: string }) {
  const { note, busy, act } = useAct();
  return (
    <div className="space-y-3">
      <Maintenance domain={domain} busy={busy} act={act} flat />
      <Note text={note} />
    </div>
  );
}

export default function SiteTools({ domain }: { domain: string }) {
  const { note, busy, act } = useAct();
  const snapshot = useSettingsSnapshot(domain);
  const { data } = snapshot;

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
        <SearchReplace domain={domain} bare />
        <Rule />
        <Permalinks domain={domain} busy={busy} act={act} snapshot={snapshot} bare />
        <Rule />
        <Language domain={domain} busy={busy} act={act} locale={data?.locale} bare />
        <Rule />
        <Core domain={domain} busy={busy} act={act} bare />
        <Rule />
        <SiteOptions domain={domain} snapshot={snapshot} bare />
      </section>

      <Note text={note} />
    </div>
  );
}

/** What separates the parts of one panel. */
function Rule() {
  return <div className="my-4 h-px bg-gray-100" />;
}

type Act = (key: string, fn: () => Promise<string>) => Promise<void>;

/** Where the update notice at the top of Settings scrolls to. */
export const CORE_SECTION_ID = "settings-core";

export function Panel({
  title,
  flat,
  bare,
  id,
  children,
}: {
  title: string;
  /** For linking to this part of the page. */
  id?: string;
  /** A heading over the rows, as Manage has, rather than a card. */
  flat?: boolean;
  /** One part of a card that holds several, headed like the others. */
  bare?: boolean;
  children: React.ReactNode;
}) {
  if (bare)
    return (
      <div id={id}>
        <h4 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
          {title}
        </h4>
        {children}
      </div>
    );
  if (flat)
    return (
      <section id={id}>
        <h2 className="mb-3 text-sm font-semibold text-gray-900">{title}</h2>
        {children}
      </section>
    );
  return (
    <section id={id} className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <h4 className="mb-3 text-sm font-semibold text-gray-900">{title}</h4>
      {children}
    </section>
  );
}

const btn =
  "w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50";
const field =
  "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/30";
/** Site options: many controls in a grid, so they are filled rather than outlined. */
const optionField =
  "min-w-0 flex-1 rounded-lg border border-transparent bg-gray-100 px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/30 disabled:opacity-60";

export function Toggle({
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

function SearchReplace({ domain, bare }: { domain: string; bare?: boolean }) {
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
    <Panel title="Search & replace" bare={bare}>
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
      <div className="grid grid-cols-1 gap-2.5">
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
  snapshot,
  bare,
}: {
  domain: string;
  busy: string | null;
  act: Act;
  snapshot: Snapshot;
  bare?: boolean;
}) {
  const structure = snapshot.data ? (snapshot.data.options.permalink_structure ?? "") : null;
  const load = snapshot.reload;

  const known = PERMALINK_STRUCTURES.find(([v]) => v === structure);

  return (
    <Panel title="Permalinks" bare={bare}>
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
  locale,
  bare,
}: {
  domain: string;
  busy: string | null;
  act: Act;
  /** The site's locale from the snapshot, shown until the list arrives. */
  locale?: string;
  bare?: boolean;
}) {
  const { data: languages, reload } = useAsync(
    () => api.wpLanguages(domain),
    [domain],
    `wp-languages:${domain}`,
  );

  const list: WpLanguage[] = languages ?? [];
  const active = list.find((l) => l.status === "active");

  return (
    <Panel title="Language" bare={bare}>
      <select
        value={active?.language ?? (locale || "en_US")}
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
          <option value={locale || "en_US"}>{locale || "Loading…"}</option>
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
  bare,
}: {
  domain: string;
  busy: string | null;
  act: Act;
  bare?: boolean;
}) {
  const { data: version, reload } = useAsync(
    () => api.wpCoreVersion(domain),
    [domain],
    `wp-core-version:${domain}`,
  );
  const { data: update, reload: recheck } = useCoreUpdate(domain);
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
    <Panel title="Core" bare={bare} id={CORE_SECTION_ID}>
      {/* What is installed, and whether WordPress has anything newer. */}
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-gray-100 pb-3">
        <span className="text-xs text-gray-600">Installed version</span>
        <span className="flex items-center gap-2">
          {update && (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-900">
              {update.version} available
            </span>
          )}
          <span className="font-mono text-xs text-gray-900">
            {version ? `WordPress ${version}` : "…"}
          </span>
        </span>
      </div>

      <div className="grid grid-cols-1 gap-3 pane-sm:grid-cols-2">
        <button
          // Nothing to do when the site is already on the newest release.
          disabled={busy === "core-update" || !update}
          title={update ? `Update to WordPress ${update.version}` : "WordPress is up to date"}
          onClick={() =>
            void act("core-update", async () => {
              const msg = await api.wpCoreUpdate(domain, null);
              await Promise.all([reload(), recheck()]);
              return msg;
            })
          }
          className={clsx(
            "inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50",
            update
              ? "bg-blue-600 text-white hover:bg-blue-700"
              : "border border-gray-300 bg-white text-gray-700",
          )}
        >
          <ArrowPathIcon className={clsx("h-4 w-4", busy === "core-update" && "animate-spin")} />
          {busy === "core-update"
            ? "Updating…"
            : update
              ? `Update to ${update.version}`
              : "Up to date"}
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

        <div className="border-t border-gray-100 pt-3 pane-sm:col-span-2">
          <label
            htmlFor={`core-version-${domain}`}
            className="mb-1.5 block text-xs font-medium text-gray-700"
          >
            Install a different version
          </label>
          <select
            id={`core-version-${domain}`}
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            className={clsx(field, "w-full")}
          >
            <option value="">
              {available.length ? "Choose a WordPress version…" : "Version list unavailable"}
            </option>
            {available.map((v) => (
              <option key={v} value={v}>
                WordPress {v}
                {version && v === version ? " (installed)" : ""}
              </option>
            ))}
          </select>
          <p className="mt-1.5 text-[11px] leading-relaxed text-gray-500">
            Core files are replaced. Going back to an older version is a downgrade — WordPress
            does not migrate a database backwards, so export it first.
          </p>

          <div className="mt-2.5 flex flex-wrap items-center gap-2">
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
              {busy === "export-db" ? "Exporting…" : "Export database first"}
            </button>
            <button
              disabled={!target || target === version || busy === "switch"}
              onClick={() => setConfirmSwitch(true)}
              className="rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy === "switch"
                ? "Installing…"
                : target
                  ? `Install ${target}`
                  : "Install version"}
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
            await Promise.all([reload(), recheck()]);
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
 * Saving mirrors what wp-admin does: whichever one is picked is written and
 * the other cleared, so they can never disagree.
 */
function timezoneOf(options: Record<string, string>): string {
  return (options.timezone_string ?? "").trim() || `UTC${formatOffset(options.gmt_offset ?? "0")}`;
}

/** "0" and "6" and "5.75" all have to come back as WordPress writes them. */
function formatOffset(raw: string): string {
  const n = Number(raw);
  if (!Number.isFinite(n)) return "+0";
  return n >= 0 ? `+${n}` : `${n}`;
}

/**
 * The offsets wp-admin offers, as [value, label]: half-hour steps plus the
 * four quarter-hour zones that actually exist (Nepal, Chatham, and the
 * Pacific pair).
 *
 * The value is what WordPress stores ("UTC+5.5"); the label is what wp-admin
 * shows for it ("UTC+5:30"), so the two screens agree.
 */
const UTC_OFFSETS: [string, string][] = (() => {
  const out: number[] = [];
  for (let n = -12; n <= 14; n += 0.5) out.push(n);
  out.push(5.75, 8.75, 12.75, 13.75);
  return [...new Set(out)]
    .sort((a, b) => a - b)
    .map((n) => {
      const value = n >= 0 ? `+${n}` : `${n}`;
      const label = value.replace(".25", ":15").replace(".5", ":30").replace(".75", ":45");
      return [`UTC${value}`, `UTC${label}`];
    });
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

function SiteOptions({
  domain,
  snapshot,
  bare,
}: {
  domain: string;
  snapshot: Snapshot;
  bare?: boolean;
}) {
  const read = snapshot.data?.options;
  /** What the site has, as the fields show it. */
  const saved = useMemo(() => {
    const out: Record<string, string> = {};
    if (!read) return out;
    for (const f of OPTION_FIELDS) {
      out[f.key] = f.kind === "timezone" ? timezoneOf(read) : (read[f.key] ?? "");
    }
    return out;
  }, [read]);

  const [draft, setDraft] = useState<Record<string, string>>(saved);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const edited = useRef(false);

  // Filled from the site as it is read -- at once when it was read ahead.
  // What is being edited is never overwritten by a refresh landing behind it.
  useEffect(() => {
    if (!edited.current) setDraft(saved);
  }, [saved]);

  useEffect(() => {
    edited.current = false;
    setNote(null);
  }, [domain]);

  const changed = OPTION_FIELDS.filter((f) => (draft[f.key] ?? "") !== (saved[f.key] ?? ""));
  const loaded = read !== undefined;

  const set = (key: string, value: string) => {
    edited.current = true;
    setDraft((v) => ({ ...v, [key]: value }));
  };

  const reset = () => {
    edited.current = false;
    setDraft(saved);
    setNote(null);
  };

  const save = async () => {
    setBusy(true);
    setNote(null);
    const patch: Record<string, string> = {};
    try {
      for (const f of changed) {
        const value = draft[f.key] ?? "";
        if (f.kind === "timezone") {
          // One of the pair holds the answer and the other is emptied.
          if (value.startsWith("UTC")) {
            // As WordPress writes it: a plain number, so "UTC+5:30" is 5.5.
            const gmt = value.slice(3).replace(/^\+/, "") || "0";
            await api.wpOptionSet(domain, "gmt_offset", gmt);
            await api.wpOptionSet(domain, "timezone_string", "");
            Object.assign(patch, { gmt_offset: gmt, timezone_string: "" });
          } else {
            await api.wpOptionSet(domain, "timezone_string", value);
            await api.wpOptionSet(domain, "gmt_offset", "");
            Object.assign(patch, { timezone_string: value, gmt_offset: "" });
          }
        } else {
          await api.wpOptionSet(domain, f.key, value);
          patch[f.key] = value;
        }
      }
      snapshot.patch(patch);
      edited.current = false;
      setNote({ ok: true, text: `${changed.length} ${changed.length === 1 ? "option" : "options"} saved.` });
    } catch (e) {
      // Whatever did save is in the site now: read it all back rather than
      // leaving the form claiming otherwise.
      snapshot.patch(patch);
      await snapshot.reload();
      setNote({ ok: false, text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="Site options" bare={bare}>
      <div className="grid grid-cols-1 gap-x-6 gap-y-3 pane-sm:grid-cols-2">
        {OPTION_FIELDS.map((f) => (
          <div key={f.key} className="flex items-center gap-3">
            <label
              htmlFor={`opt-${f.key}-${domain}`}
              className="w-32 flex-shrink-0 text-xs text-gray-600"
            >
              {f.label}
            </label>
            {f.kind === "text" ? (
              <input
                id={`opt-${f.key}-${domain}`}
                value={draft[f.key] ?? ""}
                disabled={busy || !loaded}
                onChange={(e) => set(f.key, e.target.value)}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                className={clsx(optionField, "font-mono")}
              />
            ) : (
              <select
                id={`opt-${f.key}-${domain}`}
                value={draft[f.key] ?? ""}
                disabled={busy || !loaded}
                onChange={(e) => set(f.key, e.target.value)}
                className={optionField}
              >
                {!loaded && <option value="">Loading…</option>}
                {f.kind === "timezone" ? <TimezoneOptions value={draft[f.key] ?? ""} /> : null}
                {f.choices?.map(([v, label]) => (
                  <option key={v} value={v}>
                    {label}
                  </option>
                ))}
              </select>
            )}
          </div>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
        {/* Nothing is written until Save, so there is always a way back. */}
        <div className="flex items-center gap-2">
          {changed.length > 0 && (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => void save()}
                className="rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? "Saving…" : `Save ${changed.length} change${changed.length === 1 ? "" : "s"}`}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={reset}
                className="rounded-lg px-3 py-2 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-100 hover:text-gray-900 disabled:opacity-50"
              >
                Cancel
              </button>
            </>
          )}
        </div>

        <p className="max-w-[30rem] text-[11px] leading-relaxed text-gray-500">
          Only this curated, known-safe set is editable — site URLs, plugin/theme state and
          serialized options can't be changed here.
        </p>
      </div>

      {note && (
        <p
          role={note.ok ? "status" : "alert"}
          className={clsx("mt-2 text-[11px]", note.ok ? "text-green-700" : "text-red-700")}
        >
          {note.text}
        </p>
      )}
    </Panel>
  );
}

/** The zones and offsets wp-admin offers, plus whatever the site is set to. */
function TimezoneOptions({ value }: { value: string }) {
  return (
    <>
      {/* A zone the machine's Intl does not know about still has to be
          selectable, or opening this panel would silently change it. */}
      {value && !value.startsWith("UTC") && !ZONES.includes(value) && (
        <option value={value}>{value}</option>
      )}
      <optgroup label="City">
        {ZONES.map((z) => (
          <option key={z} value={z}>
            {z.replace(/_/g, " ")}
          </option>
        ))}
      </optgroup>
      <optgroup label="UTC offset">
        {UTC_OFFSETS.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </optgroup>
    </>
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
