import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowPathIcon,
  ArrowUpTrayIcon,
  ArrowRightEndOnRectangleIcon,
  ArrowUpCircleIcon,
  CommandLineIcon,
  EyeIcon,
  EyeSlashIcon,
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
import { open } from "@tauri-apps/plugin-dialog";
import ConfirmDialog from "../ui/ConfirmDialog";
import SiteManage from "./SiteManage";

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

  const sections: { id: Section; label: string; count?: number }[] = [
    { id: "plugins", label: "Plugins", count: plugins.data?.length },
    { id: "themes", label: "Themes", count: themes.data?.length },
    { id: "users", label: "Users", count: users.data?.length },
  ];

  return (
    <div className="space-y-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav className="inline-flex flex-wrap gap-1 rounded-xl bg-gray-100 p-1">
          {sections.map((s) => (
            <button
              key={s.id}
              onClick={() => setSection(s.id)}
              className={clsx(
                "rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
                section === s.id
                  ? "bg-white text-blue-700 shadow-sm"
                  : "text-gray-600 hover:text-gray-900",
              )}
            >
              {s.label}
              {s.count !== undefined && (
                <span className="ml-1.5 text-xs font-normal text-gray-400">
                  {s.count}
                </span>
              )}
            </button>
          ))}
        </nav>
        <span className="font-mono text-[11px] text-gray-400">
          WordPress {status.version}
        </span>
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

  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "active" | "updates">("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [auto, setAuto] = useState(true);
  const [spinning, setSpinning] = useState(false);
  const [pending, setPending] = useState<WpItem | null>(null);
  const [pendingBulk, setPendingBulk] = useState(false);
  const busyRef = useRef<string | null>(null);
  busyRef.current = busy;

  /**
   * One refresh path for the button, the auto timer and the focus listener.
   *
   * The spinner is held for a beat: WP-CLI often answers faster than the eye
   * can catch, and a spinner that never appears looks like a dead button.
   */
  const refresh = async () => {
    setSpinning(true);
    const started = Date.now();
    try {
      await reload();
    } finally {
      const held = Date.now() - started;
      if (held < 400) await new Promise((r) => setTimeout(r, 400 - held));
      setSpinning(false);
    }
  };

  // Auto refresh, and again whenever the window comes back to the front --
  // the usual way this list goes stale is a change made outside Nexora.
  //
  // The timer is deliberately slow: every tick spawns WP-CLI, which boots PHP
  // and loads all of WordPress to answer, so on a site with a few hundred
  // plugins it is a real process each time. Coming back to the window is the
  // signal that actually matters, and that fires immediately regardless.
  useEffect(() => {
    if (!auto) return;

    const tick = () => {
      // Never refetch mid-mutation: the reply would race the write and the
      // row would flicker back to its old state.
      if (busyRef.current || document.hidden) return;
      void reload();
    };

    const timer = setInterval(tick, 5 * 60 * 1000);
    window.addEventListener("focus", tick);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", tick);
    };
  }, [auto, reload]);

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
  const bulk = async (fn: (name: string) => Promise<unknown>) => {
    const names = [...selected];
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

  const toggleAll = () =>
    setSelected((prev) =>
      prev.size === shown.length
        ? new Set()
        : new Set(shown.map((i) => i.name)),
    );

  return (
    <div className="space-y-3">
      <InstallBar domain={domain} kind={kind} onDone={reload} />

      <div className="flex flex-wrap items-center gap-3">
        {kind === "theme" && (
          <p className="text-xs text-gray-500">
            {items.length} theme{items.length === 1 ? "" : "s"} ·{" "}
            {counts.active} active
          </p>
        )}

        {kind === "plugin" && (
        <div className="relative">
          <MagnifyingGlassIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${kind}s…`}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            className="w-64 rounded-lg border border-gray-300 py-2 pl-9 pr-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/30"
          />
        </div>
        )}

        {kind === "plugin" && (
        <div className="inline-flex gap-1 rounded-xl bg-gray-100 p-1">
          {(["all", "active", "updates"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={clsx(
                "rounded-lg px-3 py-1.5 text-sm font-medium capitalize transition-colors",
                filter === f
                  ? "bg-white text-gray-900 shadow-sm"
                  : "text-gray-600 hover:text-gray-900",
              )}
            >
              {f}
              <span className="ml-1.5 text-xs font-normal text-gray-400">
                {counts[f]}
              </span>
            </button>
          ))}
        </div>
        )}

        {selected.size > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">{selected.size} selected</span>
            {kind === "plugin" && (
              <button
                disabled={busy === "bulk"}
                onClick={() =>
                  void bulk((n) => api.wpSetItemState(domain, kind, n, true))
                }
                className="rounded-md border border-gray-300 bg-white px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                Activate
              </button>
            )}
            {/* Themes have no deactivate: one is always active, and you
                change it by activating another. */}
            {kind === "plugin" && (
              <button
                disabled={busy === "bulk"}
                onClick={() =>
                  void bulk((n) => api.wpSetItemState(domain, kind, n, false))
                }
                className="rounded-md border border-gray-300 bg-white px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                Deactivate
              </button>
            )}
            <button
              disabled={busy === "bulk"}
              onClick={() => setPendingBulk(true)}
              className="rounded-md border border-red-300 bg-white px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
            >
              Delete
            </button>
          </div>
        )}

        <div className="ml-auto flex items-center gap-2">
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
            <ArrowPathIcon
              className={clsx(
                "h-3.5 w-3.5",
                (spinning || loading) && "animate-spin",
              )}
            />
          </button>
        </div>
      </div>

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
        <div className="flex items-center gap-3 border-b border-gray-200 px-4 py-2.5">
          <input
            type="checkbox"
            checked={shown.length > 0 && selected.size === shown.length}
            onChange={toggleAll}
            className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-2 focus:ring-blue-500/30"
          />
          <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">
            {kind}
          </span>
          <span className="ml-auto text-[11px] font-semibold uppercase tracking-wider text-gray-400">
            Status
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

  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <input
        type="checkbox"
        checked={checked}
        onChange={onCheck}
        className="h-4 w-4 flex-shrink-0 rounded border-gray-300 text-blue-600 focus:ring-2 focus:ring-blue-500/30"
      />

      {/* Icons come from wordpress.org by slug. A plugin developed locally has
          none there, so the letter tile is the normal case, not an error. */}
      {iconFailed ? (
        <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-gray-100 text-xs font-semibold uppercase text-gray-500">
          {(item.title || item.name).charAt(0)}
        </div>
      ) : (
        <img
          src={`https://ps.w.org/${item.name}/assets/icon-128x128.png`}
          alt=""
          onError={() => setIconFailed(true)}
          className="h-8 w-8 flex-shrink-0 rounded-lg object-cover"
        />
      )}

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm text-gray-900">
            {item.title || item.name}
          </span>
          {hasUpdate && (
            <span
              className="flex-shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700"
              title={`Update available: ${item.update_version || "newer version"}`}
            >
              update
            </span>
          )}
        </div>
        <div className="mt-0.5 truncate font-mono text-[11px] text-gray-400">
          {item.name} · v{item.version}
        </div>
      </div>

      <span
        className={clsx(
          "flex-shrink-0 text-xs capitalize",
          active ? "text-gray-900" : "text-gray-500",
        )}
      >
        {/* The real status, not a two-way guess: "must-use" and "parent" are
            things WP reports and neither is "inactive". */}
        {active ? "Active" : item.status || "unknown"}
      </span>

      {toggleable ? (
        <button
          role="switch"
          aria-checked={active}
          aria-label={active ? "Deactivate" : "Activate"}
          disabled={busy}
          onClick={onToggle}
          className={clsx(
            "relative h-6 w-11 flex-shrink-0 rounded-full transition-colors disabled:opacity-50",
            active ? "bg-blue-600" : "bg-gray-300",
          )}
        >
          {/* left-0.5 is load-bearing. With no horizontal anchor an absolutely
              positioned child falls at its static position -- and a button
              centres its content -- so the knob started mid-track and the
              translate pushed it off the end. */}
          <span
            className={clsx(
              "absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform",
              active ? "translate-x-5" : "translate-x-0",
            )}
          />
        </button>
      ) : active ? (
        // An active theme, or a must-use plugin: nothing to switch off.
        <span className="flex h-6 w-11 flex-shrink-0 items-center justify-center rounded-full bg-green-100 text-[10px] font-medium text-green-700">
          on
        </span>
      ) : (
        <button
          disabled={busy}
          onClick={onToggle}
          className="h-6 flex-shrink-0 rounded-full border border-gray-300 bg-white px-3 text-[11px] font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50"
        >
          {busy ? "…" : "Activate"}
        </button>
      )}

      {/* Only offered when there is something to update to. */}
      {hasUpdate && (
        <button
          title={`Update to ${item.update_version || "the latest"}`}
          disabled={busy}
          onClick={onUpdate}
          className="flex-shrink-0 rounded-lg border border-amber-300 bg-amber-50 p-1 text-amber-700 transition-colors hover:bg-amber-100 disabled:opacity-50"
        >
          <ArrowUpCircleIcon className="h-3.5 w-3.5" />
        </button>
      )}

      <button
        title="Open a shell in this folder"
        onClick={onTerminal}
        className="flex-shrink-0 rounded-lg border border-gray-300 p-1 text-gray-500 transition-colors hover:bg-gray-50"
      >
        <CommandLineIcon className="h-3.5 w-3.5" />
      </button>

      <button
        title="Reveal folder in Finder"
        onClick={() =>
          void api
            .pathOpen(`${docroot}/wp-content/${kind}s/${item.name}`)
            .catch((e) => alert(errorText(e)))
        }
        className="flex-shrink-0 rounded-lg border border-gray-300 p-1 text-gray-500 transition-colors hover:bg-gray-50"
      >
        <FolderOpenIcon className="h-3.5 w-3.5" />
      </button>

      <button
        title={
          kind === "theme" && active
            ? "The active theme cannot be deleted"
            : "Delete"
        }
        disabled={busy || (kind === "theme" && active)}
        onClick={onDelete}
        className="flex-shrink-0 rounded-lg border border-gray-300 p-1 text-gray-500 transition-colors hover:border-red-300 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
      >
        <TrashIcon className="h-3.5 w-3.5" />
      </button>
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
        <div className="grid gap-4 pane-sm:grid-cols-2 pane-xl:grid-cols-3">
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

// ---------------------------------------------------------------- install

function InstallBar({
  domain,
  kind,
  onDone,
}: {
  domain: string;
  kind: Kind;
  onDone: () => Promise<void>;
}) {
  const [source, setSource] = useState<"wporg" | "upload" | "git">("wporg");
  const [slug, setSlug] = useState("");
  const [zipPath, setZipPath] = useState<string | null>(null);
  const [gitUrl, setGitUrl] = useState("");
  const [activate, setActivate] = useState(true);
  const [busy, setBusy] = useState(false);
  const [clash, setClash] = useState<{ value: string; message: string } | null>(
    null,
  );

  const finish = async (work: () => Promise<string>) => {
    setBusy(true);
    try {
      const msg = await work();
      await onDone();
      if (msg) alert(msg);
    } catch (e) {
      alert(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  // WP-CLI takes a slug and a zip path through the same argument, so both of
  // these are one call; only the source of the string differs.
  const installSource = async (value: string, force: boolean): Promise<void> => {
    setBusy(true);
    try {
      const msg = await api.wpInstallItem(domain, kind, value, activate, force);
      setSlug("");
      setZipPath(null);
      await onDone();
      if (msg) alert(msg);
    } catch (e) {
      const text = errorText(e);
      // The backend names what is in the way, so offering to replace it is a
      // real choice rather than a guess. Held in state for the dialog, since
      // window.confirm does not reliably block here.
      if (!force && /already|exists/i.test(text)) {
        setClash({ value, message: text });
      } else {
        alert(text);
      }
    } finally {
      setBusy(false);
    }
  };

  const chooseZip = async () => {
    try {
      // The native panel, so what comes back is a real path WP-CLI can read.
      // A browser <input type="file"> hands over a File with no path at all.
      const picked = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "Zip archive", extensions: ["zip"] }],
      });
      if (typeof picked === "string") setZipPath(picked);
    } catch (e) {
      alert(errorText(e));
    }
  };

  const sources = [
    ["wporg", "WordPress.org"],
    ["upload", "Upload"],
    ["git", "From Git"],
  ] as const;

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-3 shadow-sm">
      <div className="mb-2 inline-flex gap-1 rounded-lg bg-gray-100 p-1">
        {sources.map(([id, label]) => (
          <button
            key={id}
            onClick={() => setSource(id)}
            className={clsx(
              "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
              source === id
                ? "bg-white text-gray-900 shadow-sm"
                : "text-gray-600 hover:text-gray-900",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {source === "wporg" && (
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && slug.trim())
                void installSource(slug.trim(), false);
            }}
            placeholder={`Enter a ${kind} slug, e.g. ${
              kind === "plugin" ? "wordpress-seo" : "twentytwentyfour"
            }`}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            disabled={busy}
            className="min-w-0 flex-1 rounded-lg border border-gray-300 px-3 py-2 font-mono text-xs focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/30"
          />
          <ActivateBox checked={activate} onChange={setActivate} />
          <InstallButton
            disabled={busy || !slug.trim()}
            busy={busy}
            onClick={() => void installSource(slug.trim(), false)}
          />
        </div>
      )}

      {source === "upload" && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => void chooseZip()}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-2 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50"
            >
              <ArrowUpTrayIcon className="h-4 w-4" />
              Choose .zip file…
            </button>
            {zipPath && (
              <span
                className="min-w-0 flex-1 truncate font-mono text-[11px] text-gray-600"
                title={zipPath}
              >
                {zipPath.split("/").pop()}
              </span>
            )}
            <ActivateBox checked={activate} onChange={setActivate} />
            <button
              disabled={busy || !zipPath}
              onClick={() => zipPath && void installSource(zipPath, false)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <ArrowUpTrayIcon className="h-4 w-4" />
              {busy ? "Installing…" : "Upload"}
            </button>
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-gray-500">
            Installs a {kind} from a .zip on this Mac — the same thing
            wp-admin's "Upload plugin" does, run through WP-CLI. The file is
            read where it sits; nothing is uploaded anywhere.
          </p>
        </>
      )}

      {source === "git" && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={gitUrl}
              onChange={(e) => setGitUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && gitUrl.trim()) {
                  void finish(async () => {
                    const m = await api.wpInstallFromGit(
                      domain,
                      kind,
                      gitUrl.trim(),
                    );
                    setGitUrl("");
                    return m;
                  });
                }
              }}
              placeholder="https://github.com/owner/repo  or  owner/repo"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              disabled={busy}
              className="min-w-0 flex-1 rounded-lg border border-gray-300 px-3 py-2 font-mono text-xs focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/30"
            />
            <button
              disabled={busy || !gitUrl.trim()}
              onClick={() =>
                void finish(async () => {
                  const m = await api.wpInstallFromGit(
                    domain,
                    kind,
                    gitUrl.trim(),
                  );
                  setGitUrl("");
                  return m;
                })
              }
              className="rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? "Fetching…" : "Fetch"}
            </button>
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-gray-500">
            <span className="font-mono">owner/repo</span> means github.com ·
            private repos use your own SSH keys · cloned shallow into
            wp-content/{kind}s, so it stays a checkout you can pull from.
            {" "}A repo that needs a build step still needs one.
          </p>
        </>
      )}
      <ConfirmDialog
        open={clash !== null}
        title="Already installed"
        body={
          <>
            {clash?.message}
            <br />
            <br />
            Replacing overwrites that folder with the new copy.
          </>
        }
        confirmLabel="Replace"
        busy={busy}
        onCancel={() => setClash(null)}
        onConfirm={() => {
          const again = clash;
          setClash(null);
          if (again) void installSource(again.value, true);
        }}
      />
    </div>
  );
}

function ActivateBox({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-gray-700">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-2 focus:ring-blue-500/30"
      />
      Activate
    </label>
  );
}

function InstallButton({
  disabled,
  busy,
  onClick,
}: {
  disabled: boolean;
  busy: boolean;
  onClick: () => void;
}) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
    >
      <PlusIcon className="h-4 w-4" />
      {busy ? "Installing…" : "Install"}
    </button>
  );
}

// ------------------------------------------------------------------ users

function Users({
  domain,
  state,
}: {
  domain: string;
  state: AsyncState<import("../../lib/api").WpUser[]>;
}) {
  const { data, error, loading, reload } = state;
  const { data: roles } = useAsync(() => api.wpRoles(domain), [domain], `wp-roles:${domain}`);

  const [login, setLogin] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("subscriber");
  const [showPassword, setShowPassword] = useState(false);
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

  const addUser = async () => {
    setBusy("add");
    try {
      const msg = await api.wpCreateUser(domain, login, email, password, role);
      setLogin("");
      setEmail("");
      setPassword("");
      await reload();
      if (msg) alert(msg);
    } catch (e) {
      alert(errorText(e));
    } finally {
      setBusy(null);
    }
  };

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
      {/* Create a user */}
      <div className="rounded-xl border border-gray-200 bg-white p-3 shadow-sm">
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={login}
            onChange={(e) => setLogin(e.target.value)}
            placeholder="username"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            disabled={busy === "add"}
            className={clsx(field, "w-40")}
          />
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={`email@${domain}`}
            type="email"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            disabled={busy === "add"}
            className={clsx(field, "min-w-0 flex-1")}
          />
          <div className="relative">
            <input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="password"
              type={showPassword ? "text" : "password"}
              autoComplete="new-password"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              disabled={busy === "add"}
              className={clsx(field, "w-44 pr-9")}
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              title={showPassword ? "Hide" : "Show"}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 transition-colors hover:text-gray-600"
            >
              {showPassword ? (
                <EyeSlashIcon className="h-4 w-4" />
              ) : (
                <EyeIcon className="h-4 w-4" />
              )}
            </button>
          </div>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value)}
            disabled={busy === "add"}
            className={clsx(field, "capitalize")}
          >
            {roleOptions.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <button
            disabled={busy === "add" || !login.trim() || !email.trim()}
            onClick={() => void addUser()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <UserPlusIcon className="h-4 w-4" />
            {busy === "add" ? "Adding…" : "Add user"}
          </button>
        </div>
        <p className="mt-2 text-[11px] text-gray-500">
          Leave the password blank and WordPress generates one and emails it —
          which on a local site means it goes to Mailpit.
        </p>
      </div>

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
              return (
                <li key={u.id} className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-blue-50 text-sm font-semibold uppercase text-blue-700">
                      {(u.display_name || u.login).charAt(0)}
                    </div>

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
                    <div className="flex flex-shrink-0 items-center gap-1.5">
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
                        className={clsx(
                          "rounded-lg border px-2 py-1 text-xs capitalize focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/30 disabled:opacity-50",
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

                    <button
                      title="Set a new password"
                      onClick={() => {
                        setResetting(resetting === u.login ? null : u.login);
                        setNewPassword("");
                      }}
                      className="flex-shrink-0 rounded-lg border border-gray-300 p-1.5 text-gray-500 transition-colors hover:bg-gray-50"
                    >
                      <KeyIcon className="h-3.5 w-3.5" />
                    </button>

                    <button
                      title={`Open wp-admin signed in as ${u.login}`}
                      onClick={() =>
                        void api
                          .wpMagicLogin(domain, u.login)
                          .catch((e) => alert(errorText(e)))
                      }
                      className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-lg border border-gray-300 px-2.5 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50"
                    >
                      <ArrowRightEndOnRectangleIcon className="h-3.5 w-3.5" />
                      Log in
                    </button>

                    <button
                      title="Delete this user"
                      disabled={working}
                      onClick={() => setPendingDelete(u)}
                      className="flex-shrink-0 rounded-lg border border-gray-300 p-1.5 text-gray-500 transition-colors hover:border-red-300 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                    >
                      <TrashIcon className="h-3.5 w-3.5" />
                    </button>
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
