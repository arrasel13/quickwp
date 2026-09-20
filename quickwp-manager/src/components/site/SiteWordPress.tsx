import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowPathIcon,
  PlayCircleIcon,
  ArrowRightEndOnRectangleIcon,
  ArrowUpCircleIcon,
  CommandLineIcon,
  KeyIcon,
  LockClosedIcon,
  FolderOpenIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  TrashIcon,
  UserPlusIcon,
} from "@heroicons/react/24/outline";
import clsx from "clsx";
import { api, errorText, Site, WpItem } from "../../lib/api";
import { peekCache, useAsync } from "../../lib/useAsync";
import ConfirmDialog from "../ui/ConfirmDialog";
import SiteManage from "./SiteManage";
import AddItemDialog from "./AddItemDialog";
import AddUserDialog from "./AddUserDialog";

type Section = "plugins" | "themes" | "users";
type Kind = "plugin" | "theme";

/**
 * WP-CLI reports more than two states, and treating everything that is not
 * "active" as a plain inactive item is what made the switch lie.
 *
 * Plugins: active | inactive | must-use | dropin | active-network.
 * Themes:  active | inactive | parent.
 */
function isActive(item: WpItem): boolean {
  return item.status === "active" || item.status === "active-network";
}

/**
 * Whether this item can be switched off at all.
 *
 * A must-use or drop-in plugin is loaded by the filesystem, not by an option,
 * so there is nothing to deactivate. A theme has no "deactivate" at all --
 * `wp theme deactivate` is not a WP-CLI subcommand, because a site always has
 * exactly one theme; you switch by activating another.
 */
function canToggleOff(item: WpItem, kind: Kind): boolean {
  return kind === "plugin" && (item.status === "active" || item.status === "inactive");
}

/**
 * Everything WordPress about one site: what is installed, what is out of
 * date, and who can log in.
 *
 * Read through WP-CLI against the real install, so a site edited outside
 * Nexora still reports the truth.
 */
export default function SiteWordPress({
  domain,
  docroot,
  site,
  onDeleted,
}: {
  domain: string;
  docroot: string;
  /** For Manage (export, delete), shown when the site is not WordPress. */
  site: Site;
  onDeleted?: () => void;
}) {
  const { data: status, error: statusError, loading } = useAsync(
    () => api.wpStatus(domain),
    [domain],
    `wp-status:${domain}`,
  );
  const [section, setSection] = useState<Section>("plugins");

  const plugins = useItems(domain, "plugin");
  const themes = useItems(domain, "theme");
  const users = useAsync(() => api.wpUsers(domain), [domain], `wp-users:${domain}`);

  const [auto, setAuto] = useState(true);
  const [spinning, setSpinning] = useState(false);
  const reloadAll = useCallback(async () => {
    await Promise.all([plugins.reload(), themes.reload(), users.reload()]);
  }, [plugins.reload, themes.reload, users.reload]);

  /**
   * One refresh path for the button, the timer, the window coming back and
   * the preview.
   *
   * The spinner is held for a beat: WP-CLI often answers faster than the eye
   * can catch, and a spinner that never appears looks like a dead button.
   */
  const refreshAll = useCallback(async () => {
    setSpinning(true);
    const started = Date.now();
    try {
      await reloadAll();
    } finally {
      const held = Date.now() - started;
      if (held < 400) await new Promise((r) => setTimeout(r, 400 - held));
      setSpinning(false);
    }
  }, [reloadAll]);

  // Refresh on a timer, when the window comes back, and -- the one that
  // matters most here -- whenever the preview loads a page. Activating a
  // plugin in wp-admin beside this list is a change made outside Nexora, and
  // the preview is a separate webview, so the window never loses focus and
  // nothing else would tell this list it is stale.
  //
  // The timer is deliberately slow: every tick spawns WP-CLI, which boots PHP
  // and loads all of WordPress to answer.
  useEffect(() => {
    if (!auto) return;
    let settle: number | undefined;
    const tick = () => {
      if (document.hidden) return;
      void reloadAll();
    };
    // A page load fires as the admin page arrives; the write behind it has
    // already happened, so a short wait is only to let several settle.
    const soon = () => {
      window.clearTimeout(settle);
      settle = window.setTimeout(tick, 600);
    };

    const timer = window.setInterval(tick, 5 * 60 * 1000);
    window.addEventListener("focus", tick);
    const off = api.onPreviewPage((p) => {
      if (p.domain === domain && !p.loading) soon();
    });
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(settle);
      window.removeEventListener("focus", tick);
      void off.then((f) => f());
    };
  }, [auto, domain, reloadAll]);

  if (loading) {
    return <p className="p-4 text-xs text-gray-500">Reading the install…</p>;
  }

  if (statusError) {
    return <p className="p-4 text-xs text-red-700">{statusError}</p>;
  }

  if (!status?.is_wordpress) {
    return (
      <div className="p-4">
        <div className="rounded-xl border border-gray-200 bg-white p-6 text-center shadow-sm">
          <h3 className="text-sm font-semibold text-gray-900">
            Not a WordPress site
          </h3>
          <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-gray-500">
            There is no WordPress install in this site's docroot.
          </p>
        </div>
        {/* There is no Tools section without WordPress, so Manage lives
            here -- a site of any kind has to be exportable and deletable. */}
        <div className="mt-4">
          <SiteManage site={site} onDeleted={onDeleted} />
        </div>
      </div>
    );
  }

  const waiting = (items?: WpItem[]) =>
    (items ?? []).filter((i) => i.update && i.update !== "none").length;
  const sections: { id: Section; label: string; count?: number; updates?: number }[] = [
    { id: "plugins", label: "Plugins", count: plugins.data?.length, updates: waiting(plugins.data ?? undefined) },
    { id: "themes", label: "Themes", count: themes.data?.length, updates: waiting(themes.data ?? undefined) },
    { id: "users", label: "Users", count: users.data?.length },
  ];

  return (
    <div className="space-y-4 p-4">
      <div className="-mt-1 flex flex-wrap items-center justify-between gap-x-3 border-b border-gray-200">
        <nav className="flex flex-wrap gap-4">
          {sections.map((s) => (
            <button
              key={s.id}
              onClick={() => setSection(s.id)}
              aria-current={section === s.id ? "page" : undefined}
              className={clsx(
                "relative whitespace-nowrap py-2.5 text-[13px] font-medium transition-colors focus:outline-none",
                section === s.id ? "text-gray-900" : "text-gray-500 hover:text-gray-900",
              )}
            >
              {s.label}
              {s.count !== undefined && (
                <span className="ml-1.5 text-xs font-normal text-gray-400">{s.count}</span>
              )}
              {s.updates ? (
                <span
                  title={`${s.updates} update${s.updates === 1 ? "" : "s"} waiting`}
                  className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-amber-500 align-middle"
                />
              ) : null}
              {section === s.id && (
                <span className="absolute inset-x-0 -bottom-px h-0.5 bg-gray-900" />
              )}
            </button>
          ))}
        </nav>
        <AutoRefresh auto={auto} setAuto={setAuto} spinning={spinning} refresh={refreshAll} />
      </div>

      {section === "plugins" && (
        <ItemSection domain={domain} docroot={docroot} kind="plugin" state={plugins} />
      )}
      {section === "themes" && (
        <ItemSection domain={domain} docroot={docroot} kind="theme" state={themes} />
      )}
      {section === "users" && <Users domain={domain} state={users} />}
    </div>
  );
}

/**
 * Carry update info already known onto a list fetched without it, for items
 * whose version has not changed -- so badges do not blink off while the
 * update check reruns.
 */
export function withKnownUpdates(fresh: WpItem[], known: WpItem[] | undefined): WpItem[] {
  if (!known) return fresh;
  const byName = new Map(known.map((i) => [i.name, i]));
  return fresh.map((i) => {
    const k = byName.get(i.name);
    return k && k.version === i.version && i.update === "none"
      ? { ...i, update: k.update, update_version: k.update_version }
      : i;
  });
}

/**
 * A plugin or theme list that shows at once and fills in update badges after.
 *
 * Finding updates is a round trip to wordpress.org -- a second for plugins
 * and more for themes -- so the list comes first without it and a second
 * request adds it, on first load and on every reload.
 */
function useItems(domain: string, kind: Kind) {
  const key = `wp-items:${kind}:${domain}`;
  const state = useAsync(
    async () => withKnownUpdates(await api.wpItems(domain, kind, false), peekCache<WpItem[]>(key)),
    [domain, kind],
    key,
  );
  const { setData, reload: reloadFast } = state;
  const [round, setRound] = useState(0);

  useEffect(() => {
    let live = true;
    void api
      .wpItems(domain, kind, true)
      .then((full) => {
        if (live) setData(full);
      })
      .catch(() => {
        /* the list without update badges is still right */
      });
    return () => {
      live = false;
    };
  }, [domain, kind, round, setData]);

  const reload = useCallback(async () => {
    await reloadFast();
    setRound((r) => r + 1);
  }, [reloadFast]);

  return { ...state, reload };
}

// ---------------------------------------------------------------- plugins

type AsyncState<T> = {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => Promise<void>;
};

function ItemSection({
  domain,
  docroot,
  kind,
  state,
}: {
  domain: string;
  docroot: string;
  kind: Kind;
  state: AsyncState<WpItem[]>;
}) {
  const { data, error, loading, reload } = state;
  const items = useMemo(() => data ?? [], [data]);

  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "active" | "updates">("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [pending, setPending] = useState<WpItem | null>(null);
  const [pendingBulk, setPendingBulk] = useState(false);
  const busyRef = useRef<string | null>(null);
  busyRef.current = busy;

  const hasUpdate = (i: WpItem) => Boolean(i.update) && i.update !== "none";
  const counts = {
    all: items.length,
    active: items.filter(isActive).length,
    updates: items.filter(hasUpdate).length,
  };

  const shown = items.filter((i) => {
    if (filter === "active" && !isActive(i)) return false;
    if (filter === "updates" && !hasUpdate(i)) return false;
    if (!query.trim()) return true;
    const q = query.toLowerCase();
    return (
      i.name.toLowerCase().includes(q) || i.title.toLowerCase().includes(q)
    );
  });

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await fn();
      await reload();
    } catch (e) {
      alert(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  // Bulk work runs one item at a time: WP-CLI is a process per call, and a
  // burst of them is how you get a half-applied change with no error.
  const bulk = async (fn: (name: string) => Promise<unknown>, only?: string[]) => {
    const names = only ?? [...selected];
    if (!names.length) return;
    setBusy("bulk");
    try {
      for (const n of names) await fn(n);
      setSelected(new Set());
      await reload();
    } catch (e) {
      alert(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  /** Of what is ticked, the ones an update is waiting for. */
  const withUpdates = [...selected].filter((n) =>
    items.some((i) => i.name === n && hasUpdate(i)),
  );
  const selectedUpdates = withUpdates.length;

  const toggleAll = () =>
    setSelected((prev) =>
      prev.size === shown.length
        ? new Set()
        : new Set(shown.map((i) => i.name)),
    );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        {kind === "plugin" && (
          <div className="relative min-w-0 flex-1">
            <MagnifyingGlassIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search plugins…"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              className="w-full rounded-lg border border-gray-300 py-2 pl-9 pr-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/30"
            />
          </div>
        )}
        {kind === "theme" && (
          <p className="text-xs text-gray-500">
            {items.length} theme{items.length === 1 ? "" : "s"} · {counts.active} active
          </p>
        )}
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="ml-auto inline-flex flex-shrink-0 items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-blue-700"
        >
          <PlusIcon className="h-4 w-4" strokeWidth={2.5} />
          {kind === "plugin" ? "Add plugin" : "Add theme"}
        </button>
      </div>

      <AddItemDialog
        open={adding}
        kind={kind}
        domain={domain}
        onClose={() => setAdding(false)}
        onInstalled={reload}
      />

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {kind === "plugin" && (
          <nav className="flex items-center gap-4 border-b border-gray-200">
            {(["all", "active", "updates"] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                aria-current={filter === f ? "page" : undefined}
                className={clsx(
                  "relative whitespace-nowrap py-2 text-[13px] font-medium capitalize transition-colors focus:outline-none",
                  filter === f ? "text-gray-900" : "text-gray-500 hover:text-gray-900",
                )}
              >
                {f}
                <span className="ml-1.5 text-xs font-normal text-gray-400">{counts[f]}</span>
                {filter === f && (
                  <span className="absolute inset-x-0 -bottom-px h-0.5 bg-gray-900" />
                )}
              </button>
            ))}
          </nav>
        )}

      </div>

      {/* What to do with what is ticked, over the table it applies to. */}
      {selected.size > 0 && (
        <div className="rounded-xl border border-blue-200 bg-blue-50/60 px-3 py-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-medium text-gray-700">
              {selected.size} selected
            </span>
            <button
              onClick={() => setSelected(new Set())}
              className="text-xs text-gray-500 transition-colors hover:text-gray-900"
            >
              Clear
            </button>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-2">
          {kind === "plugin" && (
            <>
              <button
                disabled={busy === "bulk"}
                onClick={() => void bulk((n) => api.wpSetItemState(domain, kind, n, true))}
                className={BULK_BUTTON}
              >
                Activate
              </button>
              {/* Themes have no deactivate: one is always active, and you
                  change it by activating another. */}
              <button
                disabled={busy === "bulk"}
                onClick={() => void bulk((n) => api.wpSetItemState(domain, kind, n, false))}
                className={BULK_BUTTON}
              >
                Deactivate
              </button>
            </>
          )}
          <button
            disabled={busy === "bulk" || selectedUpdates === 0}
            title={
              selectedUpdates === 0
                ? "None of these has an update"
                : `Update ${selectedUpdates} of them, one after another`
            }
            onClick={() => void bulk((n) => api.wpUpdateItem(domain, kind, n), withUpdates)}
            className={BULK_BUTTON}
          >
            {busy === "bulk" ? "Working…" : `Update${selectedUpdates ? ` ${selectedUpdates}` : ""}`}
          </button>
          {/* The icon alone, so the four fit on one line. */}
          <button
            disabled={busy === "bulk"}
            onClick={() => setPendingBulk(true)}
            title={`Delete ${selected.size} ${kind}${selected.size === 1 ? "" : "s"}`}
            aria-label={`Delete ${selected.size} ${kind}${selected.size === 1 ? "" : "s"}`}
            className="rounded-md border border-red-300 bg-white p-1.5 text-red-600 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <TrashIcon className="h-4 w-4" />
          </button>
          </div>
        </div>
      )}

      {kind === "theme" ? (
        <ThemeGrid
          domain={domain}
          docroot={docroot}
          items={shown}
          total={items.length}
          loading={loading}
          error={error}
          busy={busy}
          onActivate={(name) =>
            void act(name, () => api.wpSetItemState(domain, kind, name, true))
          }
          onUpdate={(name) =>
            void act(name, async () => {
              const msg = await api.wpUpdateItem(domain, kind, name);
              if (msg) alert(msg);
            })
          }
          onDelete={(item) => setPending(item)}
        />
      ) : (
      <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
        <div className={clsx(ROW_GRID, "border-b border-gray-200 px-4 py-2.5")}>
          <div className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={shown.length > 0 && selected.size === shown.length}
              onChange={toggleAll}
              className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-2 focus:ring-blue-500/30"
            />
            <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">
              {kind} name
            </span>
          </div>
          <span className="text-right text-[11px] font-semibold uppercase tracking-wider text-gray-400">
            Action
          </span>
        </div>

        {loading ? (
          <p className="px-4 py-8 text-center text-xs text-gray-500">Loading…</p>
        ) : error ? (
          <p className="px-4 py-8 text-center text-xs text-red-700">{error}</p>
        ) : shown.length === 0 ? (
          <p className="px-4 py-8 text-center text-xs text-gray-500">
            {items.length === 0 ? "None installed." : "Nothing matches."}
          </p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {shown.map((item) => (
              <Row
                key={item.name}
                docroot={docroot}
                kind={kind}
                item={item}
                busy={busy === item.name}
                checked={selected.has(item.name)}
                onCheck={() =>
                  setSelected((prev) => {
                    const next = new Set(prev);
                    if (next.has(item.name)) next.delete(item.name);
                    else next.add(item.name);
                    return next;
                  })
                }
                onToggle={() =>
                  void act(item.name, () =>
                    api.wpSetItemState(domain, kind, item.name, !isActive(item)),
                  )
                }
                onDelete={() => setPending(item)}
                onUpdate={() =>
                  void act(item.name, async () => {
                    const msg = await api.wpUpdateItem(domain, kind, item.name);
                    if (msg) alert(msg);
                  })
                }
                onTerminal={() =>
                  void api
                    .siteTerminalAt(
                      domain,
                      `${docroot}/wp-content/${kind}s/${item.name}`,
                    )
                    .catch((e) => alert(errorText(e)))
                }
              />
            ))}
          </ul>
        )}
      </div>
      )}

      <ConfirmDialog
        open={pendingBulk}
        title={`Delete ${selected.size} ${kind}${selected.size === 1 ? "" : "s"}?`}
        body="Each folder is removed from wp-content. This cannot be undone."
        busy={busy === "bulk"}
        onCancel={() => setPendingBulk(false)}
        onConfirm={() => {
          setPendingBulk(false);
          void bulk((n) => api.wpDeleteItem(domain, kind, n));
        }}
      />

      <ConfirmDialog
        open={pending !== null}
        title={`Delete this ${kind}?`}
        body={
          <>
            <span className="font-medium text-gray-900">
              {pending?.title || pending?.name}
            </span>{" "}
            and its folder are removed from wp-content. This cannot be undone.
          </>
        }
        busy={busy === pending?.name}
        onCancel={() => setPending(null)}
        onConfirm={() => {
          const target = pending;
          if (!target) return;
          setPending(null);
          void act(target.name, () =>
            api.wpDeleteItem(domain, kind, target.name),
          );
        }}
      />
    </div>
  );
}

const BULK_BUTTON =
  "rounded-md border border-gray-300 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50";

/**
 * A user's picture: their Gravatar, as wp-admin shows, and their initial
 * when there is none.
 *
 * The address is hashed here and only the hash is asked for, and `d=404`
 * means an address with no Gravatar answers 404 rather than a placeholder --
 * so the initial shows instead. Offline, the request fails and the initial
 * shows too.
 */
function Avatar({ name, email }: { name: string; email: string }) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setSrc(null);
    const address = email.trim().toLowerCase();
    if (!address || !crypto.subtle) return;
    void crypto.subtle
      .digest("SHA-256", new TextEncoder().encode(address))
      .then((buf) => {
        const hash = [...new Uint8Array(buf)]
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
        if (live) setSrc(`https://gravatar.com/avatar/${hash}?s=96&d=404`);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [email]);

  if (!src) {
    return (
      <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-blue-50 text-xs font-semibold uppercase text-blue-700">
        {name.charAt(0)}
      </div>
    );
  }
  return (
    <img
      src={src}
      alt=""
      onError={() => setSrc(null)}
      className="h-7 w-7 flex-shrink-0 rounded-full bg-gray-100 object-cover"
    />
  );
}

/** Follow the list, and read it again now. */
function AutoRefresh({
  auto,
  setAuto,
  spinning,
  refresh,
}: {
  auto: boolean;
  setAuto: (v: boolean) => void;
  spinning: boolean;
  refresh: () => Promise<void> | void;
}) {
  return (
    <div className="flex flex-shrink-0 items-center gap-2">
      <label
        className="flex items-center gap-1.5 text-[11px] text-gray-600"
        title="Re-read the list every 5 minutes, and whenever this window comes to the front"
      >
        <input
          type="checkbox"
          checked={auto}
          onChange={(e) => setAuto(e.target.checked)}
          className="h-3.5 w-3.5 rounded border-gray-300 text-blue-600 focus:ring-2 focus:ring-blue-500/30"
        />
        Auto
      </label>
      <button
        onClick={() => void refresh()}
        disabled={spinning}
        title="Reload now"
        className="rounded-lg border border-gray-300 bg-white p-1.5 text-gray-500 transition-colors hover:bg-gray-50 disabled:opacity-60"
      >
        <ArrowPathIcon className={clsx("h-3.5 w-3.5", spinning && "animate-spin")} />
      </button>
    </div>
  );
}

/** The three columns, shared by the header and every row. */
const ROW_GRID = "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3";

/** Said over a must-use plugin's switch and its delete button. */
const KEEP_WARNING = "Keep this one — WordPress loads it on every request, and removing it can break the site.";

/** WP-CLI's status word, as something to read. */
function statusLook(item: WpItem): string {
  switch (item.status) {
    case "active":
    case "active-network":
      return "Active";
    case "must-use":
      return "Must-use";
    case "dropin":
      return "Drop-in";
    case "parent":
      return "Parent theme";
    default:
      return "Inactive";
  }
}

/** An action: the icon alone, no border or padding around it. */
function RowAction({
  title,
  onClick,
  disabled,
  tone,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  tone?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className={clsx(
        "rounded transition-colors disabled:cursor-not-allowed disabled:opacity-40",
        tone ?? "text-gray-400 hover:text-gray-900",
      )}
    >
      {children}
    </button>
  );
}

function Row({
  docroot,
  kind,
  item,
  busy,
  checked,
  onCheck,
  onToggle,
  onDelete,
  onUpdate,
  onTerminal,
}: {
  docroot: string;
  kind: Kind;
  item: WpItem;
  busy: boolean;
  checked: boolean;
  onCheck: () => void;
  onToggle: () => void;
  onDelete: () => void;
  onUpdate: () => void;
  onTerminal: () => void;
}) {
  const active = isActive(item);
  const toggleable = canToggleOff(item, kind);
  const [iconFailed, setIconFailed] = useState(false);
  const hasUpdate = Boolean(item.update) && item.update !== "none";
  const statusLabel = statusLook(item);
  // Loaded by the filesystem rather than by an option: on, with nothing to
  // switch and nothing to activate.
  const alwaysOn = item.status === "must-use" || item.status === "dropin";

  return (
    <li className={clsx(ROW_GRID, "px-4 py-3")}>
      {/* The plugin: its icon, its name under it. */}
      <div className="flex min-w-0 items-center gap-3">
        <input
          type="checkbox"
          checked={checked}
          onChange={onCheck}
          className="h-4 w-4 flex-shrink-0 rounded border-gray-300 text-blue-600 focus:ring-2 focus:ring-blue-500/30"
        />
        <div className="flex min-w-0 flex-col items-start gap-1.5">
          {/* Icons come from wordpress.org by slug. A plugin developed
              locally has none there, so the letter tile is the normal case,
              not an error. */}
          {iconFailed ? (
            <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-gray-100 text-sm font-semibold uppercase text-gray-500">
              {(item.title || item.name).charAt(0)}
            </div>
          ) : (
            <img
              src={`https://ps.w.org/${item.name}/assets/icon-128x128.png`}
              alt=""
              onError={() => setIconFailed(true)}
              className="h-10 w-10 flex-shrink-0 rounded-lg object-cover"
            />
          )}
          <div className="min-w-0 max-w-full text-left">
            <p className="truncate text-[13px] font-medium text-gray-900" title={item.title || item.name}>
              {item.title || item.name}
            </p>
            <p className="truncate font-mono text-[10px] text-gray-400">
              v{item.version}
              {hasUpdate && ` → ${item.update_version || "newer"}`}
            </p>
          </div>
        </div>
      </div>

      {/* Everything that can be done, icons only. */}
      <div className="flex items-center justify-end gap-2.5">
        {toggleable ? (
          <button
            role="switch"
            aria-checked={active}
            title={active ? "Deactivate" : "Activate"}
            aria-label={active ? "Deactivate" : "Activate"}
            disabled={busy}
            onClick={onToggle}
            className={clsx(
              "relative h-4 w-7 flex-shrink-0 rounded-full transition-colors disabled:opacity-50",
              active ? "bg-blue-600" : "bg-gray-300",
            )}
          >
            {/* left-0.5 is load-bearing. With no horizontal anchor an
                absolutely positioned child falls at its static position --
                and a button centres its content -- so the knob started
                mid-track and the translate pushed it off the end. */}
            <span
              className={clsx(
                "absolute left-0.5 top-0.5 h-3 w-3 rounded-full bg-white shadow transition-transform",
                active ? "translate-x-3" : "translate-x-0",
              )}
            />
          </button>
        ) : alwaysOn ? (
          // Loaded from the filesystem: there is no switch to throw, and
          // taking it away is what breaks a site.
          <span
            title={KEEP_WARNING}
            className="flex h-4 w-7 flex-shrink-0 items-center justify-center rounded-full bg-indigo-100 text-indigo-600"
          >
            <LockClosedIcon className="h-3 w-3" aria-hidden />
            <span className="sr-only">{statusLabel}</span>
          </span>
        ) : active ? (
          // The active theme: nothing to switch off.
          <span
            title={`${statusLabel} — always on`}
            className="h-4 w-7 flex-shrink-0 rounded-full bg-green-200"
          />
        ) : (
          <RowAction title="Activate" disabled={busy} onClick={onToggle}>
            <PlayCircleIcon className="h-5 w-5" />
          </RowAction>
        )}

        {hasUpdate && (
          <RowAction
            title={`Update to ${item.update_version || "the latest"}`}
            disabled={busy}
            onClick={onUpdate}
            tone="text-amber-600 hover:text-amber-700"
          >
            <ArrowUpCircleIcon className="h-5 w-5" />
          </RowAction>
        )}

        <RowAction title="Open a shell in this folder" onClick={onTerminal}>
          <CommandLineIcon className="h-4 w-4" />
        </RowAction>

        <RowAction
          title="Reveal folder in Finder"
          onClick={() =>
            void api
              .pathOpen(`${docroot}/wp-content/${kind}s/${item.name}`)
              .catch((e) => alert(errorText(e)))
          }
        >
          <FolderOpenIcon className="h-4 w-4" />
        </RowAction>

        <RowAction
          title={
            alwaysOn
              ? KEEP_WARNING
              : kind === "theme" && active
                ? "The active theme cannot be deleted"
                : "Delete"
          }
          disabled={busy || (kind === "theme" && active)}
          onClick={onDelete}
          tone="text-gray-400 hover:text-red-600"
        >
          <TrashIcon className="h-4 w-4" />
        </RowAction>
      </div>
    </li>
  );
}

// ----------------------------------------------------------------- themes

/**
 * Screenshots are read once per theme and kept for the session.
 *
 * They arrive as data URIs a few hundred KB each, and the list re-renders on
 * every auto refresh -- refetching them each time would move megabytes for a
 * picture that has not changed.
 */
const screenshotCache = new Map<string, string | null>();

function ThemeShot({
  domain,
  name,
  title,
}: {
  domain: string;
  name: string;
  title: string;
}) {
  const key = `${domain}/${name}`;
  const [src, setSrc] = useState<string | null | undefined>(
    screenshotCache.get(key),
  );

  useEffect(() => {
    if (screenshotCache.has(key)) {
      setSrc(screenshotCache.get(key));
      return;
    }
    let cancelled = false;
    void api
      .wpItemScreenshot(domain, "theme", name)
      .then((data) => {
        screenshotCache.set(key, data);
        if (!cancelled) setSrc(data);
      })
      .catch(() => {
        screenshotCache.set(key, null);
        if (!cancelled) setSrc(null);
      });
    return () => {
      cancelled = true;
    };
  }, [key, domain, name]);

  if (src === undefined) {
    return <div className="aspect-[4/3] w-full animate-pulse bg-gray-100" />;
  }
  if (src === null) {
    // A theme with no screenshot.png is normal, not an error.
    return (
      <div className="flex aspect-[4/3] w-full items-center justify-center bg-gray-100 text-3xl font-semibold uppercase text-gray-300">
        {(title || name).charAt(0)}
      </div>
    );
  }
  return (
    <img
      src={src}
      alt={`${title || name} screenshot`}
      className="aspect-[4/3] w-full bg-gray-100 object-cover"
    />
  );
}

function ThemeGrid({
  domain,
  docroot,
  items,
  total,
  loading,
  error,
  busy,
  onActivate,
  onUpdate,
  onDelete,
}: {
  domain: string;
  docroot: string;
  items: WpItem[];
  total: number;
  loading: boolean;
  error: string | null;
  busy: string | null;
  onActivate: (name: string) => void;
  onUpdate: (name: string) => void;
  onDelete: (item: WpItem) => void;
}) {
  if (loading) {
    return <p className="py-8 text-center text-xs text-gray-500">Loading…</p>;
  }
  if (error) {
    return <p className="py-8 text-center text-xs text-red-700">{error}</p>;
  }

  return (
    <>
      {items.length === 0 ? (
        <p className="py-8 text-center text-xs text-gray-500">
          {total === 0 ? "None installed." : "Nothing matches."}
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-4 pane-sm:grid-cols-2 pane-xl:grid-cols-3">
          {items.map((item) => {
            const active = isActive(item);
            const hasUpdate = Boolean(item.update) && item.update !== "none";
            const working = busy === item.name;

            return (
              <div
                key={item.name}
                className={clsx(
                  "overflow-hidden rounded-xl border bg-white shadow-sm transition-colors",
                  active ? "border-blue-300" : "border-gray-200",
                )}
              >
                <ThemeShot
                  domain={domain}
                  name={item.name}
                  title={item.title}
                />

                <div className="p-3">
                  <div className="flex items-start justify-between gap-2">
                    <h4 className="min-w-0 truncate text-sm font-semibold text-gray-900">
                      {item.title || item.name}
                    </h4>
                    {hasUpdate && (
                      <span className="flex-shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
                        update
                      </span>
                    )}
                  </div>

                  <div className="mt-1 truncate font-mono text-[11px] text-gray-400">
                    {item.name} · v{item.version}
                    {hasUpdate && item.update_version && (
                      <span className="text-amber-600">
                        {" → "}
                        {item.update_version}
                      </span>
                    )}
                  </div>

                  <div className="mt-3 flex items-center gap-2">
                    {active ? (
                      <span className="flex-1 rounded-lg bg-blue-50 px-3 py-1.5 text-center text-xs font-medium text-blue-700">
                        Active
                      </span>
                    ) : (
                      <button
                        disabled={working}
                        onClick={() => onActivate(item.name)}
                        className="flex-1 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50"
                      >
                        {working ? "…" : "Activate"}
                      </button>
                    )}

                    {hasUpdate && (
                      <button
                        title={`Update to ${item.update_version || "the latest"}`}
                        disabled={working}
                        onClick={() => onUpdate(item.name)}
                        className="flex-shrink-0 rounded-lg border border-amber-300 bg-amber-50 p-1.5 text-amber-700 transition-colors hover:bg-amber-100 disabled:opacity-50"
                      >
                        <ArrowUpCircleIcon className="h-3.5 w-3.5" />
                      </button>
                    )}

                    <button
                      title="Reveal folder in Finder"
                      onClick={() =>
                        void api
                          .pathOpen(`${docroot}/wp-content/themes/${item.name}`)
                          .catch((e) => alert(errorText(e)))
                      }
                      className="flex-shrink-0 rounded-lg border border-gray-300 p-1.5 text-gray-500 transition-colors hover:bg-gray-50"
                    >
                      <FolderOpenIcon className="h-3.5 w-3.5" />
                    </button>

                    <button
                      title={
                        active ? "The active theme cannot be deleted" : "Delete"
                      }
                      disabled={working || active}
                      onClick={() => onDelete(item)}
                      className="flex-shrink-0 rounded-lg border border-gray-300 p-1.5 text-gray-500 transition-colors hover:border-red-300 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                    >
                      <TrashIcon className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

function Users({
  domain,
  state,
}: {
  domain: string;
  state: AsyncState<import("../../lib/api").WpUser[]>;
}) {
  const { data, error, loading, reload } = state;
  const { data: roles } = useAsync(() => api.wpRoles(domain), [domain], `wp-roles:${domain}`);

  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [resetting, setResetting] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [pendingDelete, setPendingDelete] = useState<
    import("../../lib/api").WpUser | null
  >(null);

  const roleOptions = roles?.length
    ? roles
    : ["subscriber", "contributor", "author", "editor", "administrator"];

  const field =
    "rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/30";

  /** How many administrators the site has, for the one that cannot go. */
  const admins = (data ?? []).filter((u) =>
    u.roles.split(",").some((r) => r.trim() === "administrator"),
  ).length;

  /** WP-CLI reports roles comma-separated; the picker sets exactly one. */
  const currentRole = (roles: string) => roles.split(",")[0]?.trim() ?? "";

  const changeRole = async (userLogin: string, next: string) => {
    setBusy(userLogin);
    try {
      const msg = await api.wpSetUserRole(domain, userLogin, next);
      await reload();
      if (msg) alert(msg);
    } catch (e) {
      alert(errorText(e));
      // The select is controlled by the fetched data, so a failed change is
      // undone by simply re-reading rather than tracking a local value.
      await reload();
    } finally {
      setBusy(null);
    }
  };

  const savePassword = async (userLogin: string) => {
    setBusy(userLogin);
    try {
      const msg = await api.wpSetUserPassword(domain, userLogin, newPassword);
      setResetting(null);
      setNewPassword("");
      if (msg) alert(msg);
    } catch (e) {
      alert(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-gray-500">
          {(data ?? []).length} user{(data ?? []).length === 1 ? "" : "s"}
        </p>
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-blue-700"
        >
          <UserPlusIcon className="h-4 w-4" />
          Add user
        </button>
      </div>

      <AddUserDialog
        open={adding}
        domain={domain}
        roles={roleOptions}
        onClose={() => setAdding(false)}
        onAdded={reload}
      />

      {/* The users */}
      <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-gray-200 px-4 py-2.5">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">
            User
          </span>
          <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">
            Role
          </span>
        </div>

        {loading ? (
          <p className="px-4 py-8 text-center text-xs text-gray-500">Loading…</p>
        ) : error ? (
          <p className="px-4 py-8 text-center text-xs text-red-700">{error}</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {(data ?? []).map((u) => {
              const admin = u.roles.includes("administrator");
              const working = busy === u.login;
              // Deleting the only administrator leaves a site nobody can
              // manage, so it is not offered.
              const lastAdmin = admin && admins === 1;
              return (
                <li key={u.id} className="px-4 py-3">
                  <div className="flex items-center gap-2.5">
                    <Avatar name={u.display_name || u.login} email={u.email} />

                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm text-gray-900">
                        {u.display_name || u.login}
                      </div>
                      {/* Username and email side by side: the login is what
                          every other command here takes, so it has to be
                          readable, and the display name can differ from it. */}
                      <div className="mt-0.5 flex min-w-0 items-center gap-1.5 font-mono text-[11px] text-gray-400">
                        <span className="truncate">{u.login}</span>
                        <span aria-hidden>·</span>
                        <span className="truncate">{u.email}</span>
                      </div>
                    </div>

                    {/* The options are the roles this install actually has,
                        read from `wp role list` -- a plugin can add or remove
                        them, so a fixed list would offer roles that do not
                        exist here. */}
                    <div className="flex min-w-0 flex-shrink items-center gap-1.5">
                      {admin && (
                        <LockClosedIcon
                          className="h-3.5 w-3.5 text-blue-600"
                          title="An administrator can do everything, including remove the others"
                        />
                      )}
                      <select
                        value={currentRole(u.roles)}
                        disabled={working}
                        onChange={(e) =>
                          void changeRole(u.login, e.target.value)
                        }
                        // Wide enough for the longest role this install has,
                        // so none of them reads half-cut.
                        className={clsx(
                          // pr-6 leaves the arrow its own space; without it the
                          // role name runs under it in a narrow pane.
                          "min-w-0 rounded-lg border py-1 pl-2 pr-6 text-xs capitalize focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/30 disabled:opacity-50",
                          admin
                            ? "border-blue-200 bg-blue-50 text-blue-800"
                            : "border-gray-300 bg-white text-gray-700",
                        )}
                      >
                        {/* A user with no role at all is a real state, and it
                            is not one of the options -- so show it rather than
                            silently displaying someone else's role. */}
                        {!currentRole(u.roles) && <option value="">none</option>}
                        {roleOptions.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </select>
                    </div>

                    {/* Icons alone, as the plugin rows have. */}
                    <div className="flex flex-shrink-0 items-center gap-2.5">
                      <RowAction
                        title="Set a new password"
                        onClick={() => {
                          setResetting(resetting === u.login ? null : u.login);
                          setNewPassword("");
                        }}
                      >
                        <KeyIcon className="h-4 w-4" />
                      </RowAction>

                      <RowAction
                        title={`Open wp-admin signed in as ${u.login}`}
                        onClick={() =>
                          void api
                            .wpMagicLogin(domain, u.login)
                            .catch((e) => alert(errorText(e)))
                        }
                      >
                        <ArrowRightEndOnRectangleIcon className="h-4 w-4" />
                      </RowAction>

                      <RowAction
                        title={
                          lastAdmin
                            ? "The only administrator cannot be deleted"
                            : "Delete this user"
                        }
                        disabled={working || lastAdmin}
                        onClick={() => setPendingDelete(u)}
                        tone="text-gray-400 hover:text-red-600"
                      >
                        <TrashIcon className="h-4 w-4" />
                      </RowAction>
                    </div>
                  </div>

                  {resetting === u.login && (
                    <div className="mt-3 flex items-center gap-2 rounded-lg bg-gray-50 p-2">
                      <input
                        value={newPassword}
                        onChange={(e) => setNewPassword(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && newPassword)
                            void savePassword(u.login);
                        }}
                        placeholder={`New password for ${u.login}`}
                        type="text"
                        autoComplete="new-password"
                        autoCorrect="off"
                        autoCapitalize="off"
                        spellCheck={false}
                        className={clsx(field, "min-w-0 flex-1 font-mono text-xs")}
                      />
                      <button
                        disabled={working || !newPassword}
                        onClick={() => void savePassword(u.login)}
                        className="rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
                      >
                        {working ? "Saving…" : "Save"}
                      </button>
                      <button
                        onClick={() => setResetting(null)}
                        className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50"
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete this user?"
        body={
          <>
            <span className="font-medium text-gray-900">
              {pendingDelete?.display_name || pendingDelete?.login}
            </span>{" "}
            is removed from WordPress, and anything they authored goes with
            them. This cannot be undone.
          </>
        }
        busy={busy === pendingDelete?.login}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          const target = pendingDelete;
          if (!target) return;
          setPendingDelete(null);
          setBusy(target.login);
          void api
            .wpDeleteUser(domain, target.login, null)
            .then(async (msg) => {
              await reload();
              if (msg) alert(msg);
            })
            .catch((e) => alert(errorText(e)))
            .finally(() => setBusy(null));
        }}
      />
    </div>
  );
}
