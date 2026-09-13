import { useCallback, useEffect, useState } from "react";
import {
  CircleStackIcon,
  CodeBracketIcon,
  CommandLineIcon,
  DocumentDuplicateIcon,
  DocumentTextIcon,
  FolderOpenIcon,
  PaintBrushIcon,
  PhotoIcon,
  PencilSquareIcon,
  RectangleGroupIcon,
  RectangleStackIcon,
  Squares2X2Icon,
} from "@heroicons/react/24/outline";
import clsx from "clsx";
import { api, errorText, hasBackend, Site } from "../../lib/api";
import { peekCache, putCache } from "../../lib/useAsync";
import { withKnownUpdates } from "./SiteWordPress";
import { usePreferredApps } from "../../lib/usePreferredApps";
import ConfirmDialog from "../ui/ConfirmDialog";

type WpStatus = Awaited<ReturnType<typeof api.wpStatus>>;
type WpItems = Awaited<ReturnType<typeof api.wpItems>>;
type WpUsers = Awaited<ReturnType<typeof api.wpUsers>>;

/** The administrator to show: the first with that role, else the first user. */
function pickAdmin(users: WpUsers) {
  const owner =
    users.find((u) => u.roles.split(",").some((r) => r.trim() === "administrator")) ?? users[0];
  return owner ? { login: owner.login, email: owner.email } : null;
}

function activeTheme(list: WpItems) {
  const active = list.find((t) => t.status === "active");
  return active ? { title: active.title || active.name, name: active.name } : null;
}

/**
 * The at-a-glance panel: what this site is, who you log in as, and the handful
 * of places you actually go from here.
 *
 * Two columns, because the two halves answer different questions -- the left
 * is facts about the site, the right is somewhere to go. Every value is read
 * from the backend; where Nexora has no answer the row is absent rather than
 * blank.
 *
 * Configuration lives elsewhere: the environment (PHP, SSL, Node) in the
 * Settings tab, and export and delete in WordPress › Tools.
 */
export default function SiteOverview({ site }: { site: Site }) {
  const isWordPress = site.kind === "wordpress";
  const preferred = usePreferredApps();

  const [wpVersion, setWpVersion] = useState<string | null>(null);
  const [theme, setTheme] = useState<{ title: string; name: string } | null>(null);
  const [thumb, setThumb] = useState<string | null>(null);
  const [disk, setDisk] = useState<number | null>(null);
  const [admin, setAdmin] = useState<{ login: string; email: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The admin password: the one saved in the login keychain at install, or
  // the one set from here. Only a site with none saved offers to set one.
  const [password, setPassword] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);

  // All requested at once -- the backend runs them in parallel -- and each
  // tolerated failing: a site whose WP-CLI cannot run should still show its
  // size and its shortcuts, not an empty tab.
  useEffect(() => {
    let live = true;
    const d = site.domain;
    // A password set for the last site is not this site's password.
    setPassword(null);

    // Paint what is already known -- from an earlier visit, or from the
    // WordPress tab, which shares these keys -- then refresh underneath.
    // Unknown values are cleared rather than left showing the last site's.
    const themes = peekCache<WpItems>(`wp-items:theme:${d}`);
    const theme = themes ? activeTheme(themes) : null;
    const users = peekCache<WpUsers>(`wp-users:${d}`);
    setDisk(peekCache<number>(`disk:${d}`) ?? null);
    setWpVersion(peekCache<WpStatus>(`wp-status:${d}`)?.version ?? null);
    setTheme(theme);
    setThumb(theme ? (peekCache<string | null>(`wp-thumb:${d}:${theme.name}`) ?? null) : null);
    setAdmin(users ? pickAdmin(users) : null);

    if (hasBackend) {
      void api
        .siteDiskUsage(d)
        .then((b) => {
          putCache(`disk:${d}`, b);
          if (live) setDisk(b);
        })
        .catch(() => {});

      if (isWordPress) {
        void api
          .wpStatus(d)
          .then((s) => {
            putCache(`wp-status:${d}`, s);
            if (live) setWpVersion(s.version);
          })
          .catch(() => {});

        // Without the update check: this only needs the active theme, and
        // skipping it is the difference between a third of a second and four.
        void api
          .wpItems(d, "theme", false)
          .then(async (list) => {
            const key = `wp-items:theme:${d}`;
            putCache(key, withKnownUpdates(list, peekCache<WpItems>(key)));
            const active = activeTheme(list);
            if (!live) return;
            setTheme(active);
            if (!active) return;
            const shot = await api.wpItemScreenshot(d, "theme", active.name).catch(() => null);
            putCache(`wp-thumb:${d}:${active.name}`, shot);
            if (live) setThumb(shot);
          })
          .catch(() => {});

        void api
          .wpUsers(d)
          .then(async (list) => {
            putCache(`wp-users:${d}`, list);
            const owner = pickAdmin(list);
            if (!live) return;
            setAdmin(owner);
            if (!owner) return;
            const saved = await api.wpSavedPassword(d, owner.login).catch(() => null);
            if (live && saved) setPassword(saved);
          })
          .catch(() => {});
      }
    }

    return () => {
      live = false;
    };
  }, [site.domain, isWordPress]);

  const run = useCallback(
    async (id: string, fn: () => Promise<unknown>, success?: (r: unknown) => string) => {
      setBusy(id);
      setNote(null);
      setError(null);
      try {
        const r = await fn();
        if (success) setNote(success(r));
      } catch (e) {
        setError(errorText(e));
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  // One wp-admin launch at a time: each one mints a login token, and a
  // double-clicked shortcut would otherwise open two tabs.
  const openAdmin = (path?: string) => {
    if (busy) return;
    void run(path ?? "admin", () => api.wpOpenAdmin(site.domain, path));
  };

  return (
    <div className="p-6">
      <div className="mx-auto grid max-w-6xl gap-x-10 gap-y-8 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
        {/* ---------------------------------------------- left: the facts */}
        <div className="space-y-8">
          <section>
            <h2 className="mb-3 text-sm font-semibold text-gray-900">About</h2>
            <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
              <div className="flex gap-4">
                <div className="h-[74px] w-[102px] flex-shrink-0 overflow-hidden rounded border border-gray-200 bg-gray-50">
                  {thumb ? (
                    <img
                      src={thumb}
                      alt=""
                      className="h-full w-full object-cover object-top"
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center">
                      <PhotoIcon className="h-5 w-5 text-gray-300" />
                    </div>
                  )}
                </div>
                <div className="min-w-0">
                  <p className="text-[11px] text-gray-500">
                    {isWordPress ? "Theme" : "Kind"}
                  </p>
                  <p className="truncate text-sm font-semibold text-gray-900">
                    {isWordPress ? (theme?.title ?? "—") : site.kind}
                  </p>
                  <p className="mt-1 text-[11px] text-gray-500">
                    {isWordPress && wpVersion ? `WP v${wpVersion} · ` : ""}
                    PHP v{site.php_minor}
                  </p>
                </div>
              </div>

              <div className="mt-4">
                <div className="flex items-baseline justify-between">
                  <span className="text-[11px] font-medium text-gray-600">Disk</span>
                  <span className="text-[11px] text-gray-900">
                    {disk === null ? "measuring…" : formatBytes(disk)}
                  </span>
                </div>
                <DiskBar bytes={disk} />
              </div>
            </div>
          </section>

          {isWordPress && (
            <section>
              <h2 className="mb-3 text-sm font-semibold text-gray-900">WP Admin</h2>
              <div className="space-y-5 rounded-md border border-gray-200 bg-white px-5 py-4">
                <CopyField label="Username" value={admin?.login ?? null} />
                {/* Masked. Copies the password saved when the site was made.
                    A site with none saved -- made before Nexora kept them, or
                    changed outside it -- is offered a new one instead, after
                    asking. */}
                <CopyField
                  label="Password"
                  value={admin ? "••••••••••••" : null}
                  onCopy={() => {
                    if (password) return password;
                    setConfirmReset(true);
                    return null;
                  }}
                />
                <CopyField label="Email" value={admin?.email ?? null} />
              </div>
            </section>
          )}
        </div>

        {/* --------------------------------------- right: somewhere to go */}
        <div className="space-y-8">
          {isWordPress && (
            <section>
              <h2 className="mb-3 text-sm font-semibold text-gray-900">Shortcuts</h2>
              <Grid>
                <Tile icon={PencilSquareIcon} label="Site Editor" onClick={() => openAdmin("site-editor.php")} />
                <Tile icon={PaintBrushIcon} label="Styles" onClick={() => openAdmin("site-editor.php?path=%2Fwp_global_styles")} />
                <Tile icon={Squares2X2Icon} label="Patterns" onClick={() => openAdmin("site-editor.php?path=%2Fpatterns")} />
                <Tile icon={RectangleGroupIcon} label="Navigation" onClick={() => openAdmin("site-editor.php?path=%2Fnavigation")} />
                <Tile icon={RectangleStackIcon} label="Templates" onClick={() => openAdmin("site-editor.php?path=%2Ftemplate")} />
                <Tile icon={DocumentTextIcon} label="Posts" onClick={() => openAdmin("edit.php")} />
                <Tile icon={DocumentDuplicateIcon} label="Pages" onClick={() => openAdmin("edit.php?post_type=page")} />
                <Tile icon={PhotoIcon} label="Media Library" onClick={() => openAdmin("upload.php")} />
              </Grid>
            </section>
          )}

          <section>
            <h2 className="mb-3 text-sm font-semibold text-gray-900">Open in…</h2>
            <Grid>
              <Tile
                icon={FolderOpenIcon}
                label="Finder"
                onClick={() => void run("finder", () => api.pathOpen(site.docroot))}
              />
              {/* Named for what it opens -- the editor and terminal chosen in
                  App settings. A bare "Editor" would also read as the Site
                  Editor two rows up. */}
              <Tile
                icon={CodeBracketIcon}
                label={preferred.editor ?? "Code editor"}
                onClick={() => void run("editor", () => api.pathOpenInEditor(site.docroot))}
              />
              <Tile
                icon={CommandLineIcon}
                label={preferred.terminal ?? "Terminal"}
                onClick={() => void run("terminal", () => api.siteTerminal(site.domain))}
              />
              {/* Adminer, not phpMyAdmin: it is the browser Nexora ships, and
                  the Database tab has the same thing embedded. */}
              <Tile
                icon={CircleStackIcon}
                label="Adminer"
                onClick={() => void run("adminer", () => api.siteAdminerOpen(site.domain))}
              />
            </Grid>
          </section>

          {note && (
            <p className="break-all rounded-lg border border-green-200 bg-green-50 px-4 py-3 font-mono text-[11px] text-green-900">
              {note}
            </p>
          )}
          {error && (
            <p className="break-words rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-900">
              {error}
            </p>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirmReset}
        title={`Set a new password for ${admin?.login ?? "the admin"}?`}
        busy={resetting}
        destructive={false}
        confirmLabel="Set and copy"
        body={
          <span>
            No password is saved for this site — it was set before Nexora kept
            them, or changed outside Nexora — so there is none to copy. This
            sets a new random password for{" "}
            <strong>{admin?.login}</strong> and copies it to the clipboard. The
            current password stops working.
          </span>
        }
        onCancel={() => setConfirmReset(false)}
        onConfirm={() => {
          if (!admin) return;
          const next = randomPassword();
          setResetting(true);
          void api
            .wpSetUserPassword(site.domain, admin.login, next)
            .then(() => navigator.clipboard.writeText(next).catch(() => {}))
            .then(() => {
              setPassword(next);
              setConfirmReset(false);
              setError(null);
              setNote(`A new password is set for ${admin.login} and copied to the clipboard.`);
            })
            .catch((e) => {
              setConfirmReset(false);
              setError(errorText(e));
            })
            .finally(() => setResetting(false));
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------- bits

function Grid({ children }: { children: React.ReactNode }) {
  return <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{children}</div>;
}

function Tile({
  icon: Icon,
  label,
  onClick,
  destructive,
  disabled,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
  destructive?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={clsx(
        "flex items-center gap-2.5 rounded-lg border border-gray-200 bg-white px-3.5 py-3 text-left text-sm font-medium shadow-sm transition-colors disabled:opacity-50",
        destructive
          ? "text-red-700 hover:bg-red-50"
          : "text-gray-800 hover:bg-gray-50",
      )}
    >
      <Icon className={clsx("h-4 w-4 flex-shrink-0", destructive ? "text-red-600" : "text-gray-400")} />
      <span className="truncate">{label}</span>
    </button>
  );
}

/**
 * A label, a value and a copy button. `onCopy` supplies the text when it is
 * not the value shown -- the masked password -- and returns null when it has
 * taken over (by asking first).
 */
function CopyField({
  label,
  value,
  onCopy,
}: {
  label: string;
  value: string | null;
  onCopy?: () => string | null;
}) {
  const [copied, setCopied] = useState(false);
  const copy = (text: string) =>
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => {
        /* a webview can refuse the clipboard; it is on screen anyway */
      });

  return (
    <div>
      <p className="text-xs text-gray-500">{label}</p>
      <div className="mt-1.5 flex items-center gap-2">
        <span className="truncate text-[13px] text-gray-900">{value ?? "—"}</span>
        {value && (
          <button
            onClick={() => {
              const text = onCopy ? onCopy() : value;
              if (text) copy(text);
            }}
            title={`Copy ${label.toLowerCase()}`}
            aria-label={`Copy ${label.toLowerCase()}`}
            className="flex-shrink-0 rounded p-0.5 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900"
          >
            <DocumentDuplicateIcon className="h-4 w-4" />
          </button>
        )}
        {copied && <span className="text-[11px] text-green-700">Copied</span>}
      </div>
    </div>
  );
}

/**
 * 20 characters from 64 with no look-alikes (0/O, 1/l/I), from the platform's
 * CSPRNG. 256 is a multiple of 64, so taking each byte modulo 64 is unbiased.
 * The symbols are ones no shell or WP-CLI argument treats specially.
 */
function randomPassword(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789-_.+=@%*";
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

/**
 * A size bar with no ceiling to measure against.
 *
 * A site has no quota, so a percentage would be invented. This shows the size
 * on a log scale against 1 GB purely as a sense of scale, and never fills.
 */
function DiskBar({ bytes }: { bytes: number | null }) {
  const pct =
    bytes === null || bytes <= 0
      ? 0
      : Math.min(95, (Math.log10(bytes) / Math.log10(1024 ** 3)) * 100);
  return (
    <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-gray-200">
      <div
        className="h-full rounded-full bg-amber-500 transition-[width] duration-500"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}
