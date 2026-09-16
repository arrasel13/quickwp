import { useCallback, useEffect, useState } from "react";
import {
  DocumentDuplicateIcon,
  FolderOpenIcon,
  LockClosedIcon,
  LockOpenIcon,
  PlusIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import clsx from "clsx";
import { open } from "@tauri-apps/plugin-dialog";
import { api, CertInfo, errorText, NodeVersion, Site, SiteInfo } from "../../lib/api";
import { useAsync } from "../../lib/useAsync";
import ConfirmDialog from "../ui/ConfirmDialog";

/**
 * What this site is, what it answers on, and where its files live.
 *
 * The three operations that touch real things -- renaming the domain, moving
 * the folder, re-issuing the certificate -- each say what they will do before
 * they do it, because none of them is undone by clicking again.
 */
/** What the Environment panel shows and changes; owned by the Sites screen. */
export interface EnvironmentProps {
  httpsReady: boolean;
  phpVersions: string[];
  nodeInstalls: NodeVersion[];
  nodeSelected: string;
  onPhpChange: (v: string) => void;
  onNodeChange: (v: string) => void;
}

export default function SiteSettings({
  site,
  onChanged,
  environment,
}: {
  site: Site;
  /** Re-reads the site list; the domain and docroot here can both change. */
  onChanged: () => Promise<void> | void;
  environment: EnvironmentProps;
}) {
  const [note, setNote] = useState<string | null>(null);

  return (
    <div className="space-y-4 p-4">
      <div className="grid gap-4 pane-lg:grid-cols-2">
        <div className="space-y-4">
          <SiteName site={site} onChanged={onChanged} setNote={setNote} />
          <DomainPanel site={site} onChanged={onChanged} setNote={setNote} />
          <FolderPanel site={site} onChanged={onChanged} setNote={setNote} />
        </div>

        <div className="space-y-4">
          <EnvironmentPanel site={site} {...environment} />
          <InfoPanel site={site} />
          <CertPanel site={site} setNote={setNote} />
          <XdebugPanel site={site} onChanged={onChanged} setNote={setNote} />
        </div>
      </div>

      <DomainsPanel site={site} onChanged={onChanged} setNote={setNote} />
      <EnvPanel site={site} setNote={setNote} />

      {note && (
        <pre className="whitespace-pre-wrap rounded-xl border border-gray-200 bg-white p-3 font-mono text-[11px] leading-relaxed text-gray-700 shadow-sm">
          {note}
        </pre>
      )}
    </div>
  );
}

type SetNote = (v: string | null) => void;

function Panel({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <h4 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
        {title}
      </h4>
      {children}
    </section>
  );
}

const field =
  "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/30";
const ghost =
  "rounded-lg border border-gray-300 bg-white px-3 py-2 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50";
const hint = "mt-2 text-[11px] leading-relaxed text-gray-500";

function CopyButton({ value, title }: { value: string; title?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      title={done ? "Copied" : (title ?? "Copy")}
      onClick={() => {
        void navigator.clipboard
          .writeText(value)
          .then(() => {
            setDone(true);
            setTimeout(() => setDone(false), 1200);
          })
          .catch(() => {
            /* the value is on screen either way */
          });
      }}
      className="flex-shrink-0 rounded-md p-1 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700"
    >
      <DocumentDuplicateIcon className="h-3.5 w-3.5" />
    </button>
  );
}

// ------------------------------------------------------------ environment

/** What serves this site. Configuration, so it lives here rather than on
 *  Overview. The folder is not repeated: the Site folder panel has it. */
function EnvironmentPanel({
  site,
  httpsReady,
  phpVersions,
  nodeInstalls,
  nodeSelected,
  onPhpChange,
  onNodeChange,
}: { site: Site } & EnvironmentProps) {
  // pr-8 leaves room for the arrow the forms plugin draws; with px-2 alone
  // it lands on top of the value.
  const select =
    "rounded-lg border border-gray-300 bg-white py-1 pl-2 pr-8 text-xs focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/30 disabled:opacity-50";
  return (
    <Panel title="Environment">
      <dl className="divide-y divide-gray-100 text-xs">
        <EnvRow label="PHP">
          <select
            value={site.php_minor}
            onChange={(e) => onPhpChange(e.target.value)}
            className={select}
          >
            {phpVersions.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </EnvRow>

        {/* Not a picker. Nexora serves sites from its own edge rather than
            shipping nginx and Caddy, so there is nothing to choose between
            and a dropdown would imply one. */}
        <EnvRow label="Web server">
          <span className="text-gray-900">Nexora edge</span>
          <span className="text-[11px] text-gray-400">built in</span>
        </EnvRow>

        <EnvRow label="SSL">
          {httpsReady ? (
            <LockClosedIcon className="h-3.5 w-3.5 text-green-600" />
          ) : (
            <LockOpenIcon className="h-3.5 w-3.5 text-gray-400" />
          )}
          <span className={clsx("font-medium", httpsReady ? "text-gray-900" : "text-gray-500")}>
            {httpsReady ? "Trusted" : "Not enabled"}
          </span>
        </EnvRow>

        {/* Node is a build-tool concern; a WordPress site has none. */}
        {site.kind !== "wordpress" && (
          <EnvRow label="Node">
            <select
              value={nodeSelected}
              onChange={(e) => onNodeChange(e.target.value)}
              disabled={nodeInstalls.length === 0}
              className={select}
            >
              {nodeInstalls.length === 0 ? (
                <option>none found</option>
              ) : (
                nodeInstalls.map((n) => (
                  <option key={n.path} value={n.version}>
                    {n.version} · {n.source}
                  </option>
                ))
              )}
            </select>
          </EnvRow>
        )}
      </dl>
    </Panel>
  );
}

function EnvRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0">
      <dt className="font-medium text-gray-600">{label}</dt>
      <dd className="flex min-w-0 items-center gap-1.5">{children}</dd>
    </div>
  );
}

// -------------------------------------------------------------- site name

function SiteName({
  site,
  onChanged,
  setNote,
}: {
  site: Site;
  onChanged: () => Promise<void> | void;
  setNote: SetNote;
}) {
  const [name, setName] = useState(site.name);
  const [busy, setBusy] = useState(false);

  useEffect(() => setName(site.name), [site.name]);
  const dirty = name.trim() !== site.name && name.trim() !== "";

  return (
    <Panel title="Site name">
      <div className="flex items-center gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && dirty) void save();
          }}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          className={clsx(field, "min-w-0 flex-1")}
        />
        <button
          disabled={!dirty || busy}
          onClick={() => void save()}
          className="rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
      <p className={hint}>
        Display name only — the domain, folder and database are unchanged.
      </p>
    </Panel>
  );

  async function save() {
    setBusy(true);
    setNote(null);
    try {
      setNote(await api.siteSetName(site.domain, name.trim()));
      await onChanged();
    } catch (e) {
      setNote(errorText(e));
    } finally {
      setBusy(false);
    }
  }
}

// ----------------------------------------------------------------- domain

function DomainPanel({
  site,
  onChanged,
  setNote,
}: {
  site: Site;
  onChanged: () => Promise<void> | void;
  setNote: SetNote;
}) {
  const [editing, setEditing] = useState(false);
  const [next, setNext] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  return (
    <Panel title="Domain">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-sm text-gray-900">{site.domain}</p>
          <p className={hint}>
            Changing the domain rewrites every URL in the database. A backup is
            exported to Downloads first.
          </p>
        </div>
        <button
          onClick={() => {
            setNext(site.domain);
            setEditing((v) => !v);
          }}
          className={clsx(ghost, "flex-shrink-0")}
        >
          Change domain…
        </button>
      </div>

      {editing && (
        <div className="mt-3 flex items-center gap-2">
          <input
            value={next}
            onChange={(e) => setNext(e.target.value)}
            placeholder="new-name.test"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            className={clsx(field, "min-w-0 flex-1 font-mono text-xs")}
          />
          <button
            disabled={!next.trim() || next.trim() === site.domain || busy}
            onClick={() => setConfirming(true)}
            className="rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "Working…" : "Change"}
          </button>
        </div>
      )}

      <ConfirmDialog
        open={confirming}
        title={`Move ${site.domain} to ${next.trim()}?`}
        body={
          <>
            The database is exported to Downloads, every URL inside it is
            rewritten from <span className="font-mono">{site.domain}</span> to{" "}
            <span className="font-mono">{next.trim()}</span>, and the
            certificate is re-issued. The search-replace has no undo — the
            export is your way back.
          </>
        }
        confirmLabel="Change domain"
        busy={busy}
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          void (async () => {
            setBusy(true);
            setNote(null);
            try {
              setNote(await api.siteChangeDomain(site.domain, next.trim()));
              setEditing(false);
              await onChanged();
            } catch (e) {
              setNote(errorText(e));
            } finally {
              setBusy(false);
            }
          })();
        }}
      />
    </Panel>
  );
}

// ------------------------------------------------------------ site folder

function FolderPanel({
  site,
  onChanged,
  setNote,
}: {
  site: Site;
  onChanged: () => Promise<void> | void;
  setNote: SetNote;
}) {
  const [target, setTarget] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const pick = async () => {
    try {
      const picked = await open({ directory: true, multiple: false });
      if (typeof picked !== "string") return;
      // The chosen folder is the new parent; the site keeps its own folder
      // name inside it, which is what "move" means everywhere else.
      const leaf = site.docroot.split("/").filter(Boolean).pop() ?? site.domain;
      setTarget(`${picked.replace(/\/$/, "")}/${leaf}`);
    } catch (e) {
      setNote(errorText(e));
    }
  };

  return (
    <Panel title="Site folder">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-mono text-xs text-gray-900" title={site.docroot}>
            {site.docroot}
          </p>
          <p className={hint}>
            Move the site's files to another folder — domain, database and
            certificate stay the same.
          </p>
        </div>
        <div className="flex flex-shrink-0 items-center gap-1">
          <CopyButton value={site.docroot} title="Copy path" />
          <button
            title="Reveal in Finder"
            onClick={() =>
              void api.pathOpen(site.docroot).catch((e) => setNote(errorText(e)))
            }
            className="rounded-md p-1 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700"
          >
            <FolderOpenIcon className="h-3.5 w-3.5" />
          </button>
          <button onClick={() => void pick()} className={ghost}>
            Move…
          </button>
        </div>
      </div>

      <ConfirmDialog
        open={target !== null}
        title="Move this site's files?"
        body={
          <>
            <span className="break-all font-mono text-[11px]">
              {site.docroot}
            </span>
            <br />→<br />
            <span className="break-all font-mono text-[11px]">{target}</span>
            <br />
            <br />
            Only the files move. If the two locations are on different disks
            this is refused rather than half-copied.
          </>
        }
        confirmLabel="Move"
        destructive={false}
        busy={busy}
        onCancel={() => setTarget(null)}
        onConfirm={() => {
          const to = target;
          setTarget(null);
          if (!to) return;
          void (async () => {
            setBusy(true);
            setNote(null);
            try {
              setNote(await api.siteMove(site.domain, to));
              await onChanged();
            } catch (e) {
              setNote(errorText(e));
            } finally {
              setBusy(false);
            }
          })();
        }}
      />
    </Panel>
  );
}

// -------------------------------------------------------------- site info

function InfoPanel({ site }: { site: Site }) {
  const { data } = useAsync(() => api.siteInfo(site.domain), [site.domain], `site-info:${site.domain}`);
  const info: SiteInfo | null = data;

  return (
    <Panel title="Site info">
      <dl className="space-y-2.5">
        <Row label="Type">
          <span className="capitalize">{info?.kind ?? site.kind}</span>
        </Row>
        <Row label="Database name">
          {info?.db_name ? (
            <span className="flex items-center gap-1">
              <span className="font-mono">{info.db_name}</span>
              <CopyButton value={info.db_name} />
            </span>
          ) : (
            <span className="text-gray-400">—</span>
          )}
        </Row>
        <Row label="Database engine">
          {info?.db_engine ? (
            <span className="font-mono">
              {info.db_engine} {info.db_host ?? ""}
            </span>
          ) : (
            <span className="text-gray-400">—</span>
          )}
        </Row>
        <Row label="Multisite">
          <span className={info?.multisite ? "" : "text-gray-400"}>
            {info?.multisite ? "Yes" : "—"}
          </span>
        </Row>
      </dl>
    </Panel>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="flex-shrink-0 text-xs text-gray-600">{label}</dt>
      <dd className="min-w-0 truncate text-right text-xs text-gray-900">
        {children}
      </dd>
    </div>
  );
}

// ------------------------------------------------------------------- cert

/** Whole days from now, so "expired" and "today" are not the same thing. */
function daysUntil(iso: string): number | null {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  return Math.round((then - Date.now()) / 86_400_000);
}

function formatDate(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function CertPanel({ site, setNote }: { site: Site; setNote: SetNote }) {
  const { data, reload } = useAsync(
    () => api.siteCertInfo(site.domain),
    [site.domain],
    `site-cert:${site.domain}`,
  );
  const cert: CertInfo | null = data;
  const [busy, setBusy] = useState(false);
  const left = cert?.expires_at ? daysUntil(cert.expires_at) : null;

  return (
    <Panel title="HTTPS certificate">
      {!cert?.exists && !cert?.issued_at ? (
        <p className="text-xs text-gray-500">
          No certificate yet — turn on HTTPS in Nexora Settings › General and one
          is issued for this site.
        </p>
      ) : (
        <>
          <dl className="space-y-2.5">
            <Row label="Issued">
              {cert?.issued_at ? formatDate(cert.issued_at) : "—"}
            </Row>
            <Row label="Expires">
              {cert?.expires_at ? (
                <span>
                  {formatDate(cert.expires_at)}{" "}
                  <span
                    className={clsx(
                      "text-[11px]",
                      left !== null && left < 14
                        ? "text-amber-600"
                        : "text-gray-400",
                    )}
                  >
                    {left === null
                      ? ""
                      : left < 0
                        ? "expired"
                        : `in ${left} days`}
                  </span>
                </span>
              ) : (
                "—"
              )}
            </Row>
            <Row label="Domains">
              <span className="font-mono">{cert?.names.join(", ")}</span>
            </Row>
          </dl>

          <div className="mt-3">
            <div className="mb-1.5 text-xs text-gray-600">Certificate folder</div>
            <div className="flex items-center gap-1 rounded-lg bg-gray-50 py-1.5 pl-3 pr-1.5">
              <span
                className="min-w-0 flex-1 truncate font-mono text-[11px] text-gray-700"
                title={cert?.path}
              >
                {cert?.path}
              </span>
              <CopyButton value={cert?.path ?? ""} />
              <button
                title="Reveal in Finder"
                onClick={() =>
                  void api
                    .pathOpen(cert?.path ?? "")
                    .catch((e) => setNote(errorText(e)))
                }
                className="flex-shrink-0 rounded-md p-1 text-gray-400 transition-colors hover:bg-gray-200 hover:text-gray-700"
              >
                <FolderOpenIcon className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </>
      )}

      <div className="mt-4 flex items-end justify-between gap-3 border-t border-gray-100 pt-3">
        <p className="text-[11px] leading-relaxed text-gray-500">
          Re-issue from the local CA — for a cert nearing expiry, a corrupted
          file, or after the CA was re-created. Briefly reloads the edge.
        </p>
        <button
          disabled={busy}
          onClick={() =>
            void (async () => {
              setBusy(true);
              setNote(null);
              try {
                setNote(await api.siteRegenerateCert(site.domain));
                await reload();
              } catch (e) {
                setNote(errorText(e));
              } finally {
                setBusy(false);
              }
            })()
          }
          className={clsx(ghost, "flex-shrink-0")}
        >
          {busy ? "Working…" : "Regenerate"}
        </button>
      </div>
    </Panel>
  );
}

// ----------------------------------------------------------------- xdebug

function XdebugPanel({
  site,
  onChanged,
  setNote,
}: {
  site: Site;
  onChanged: () => Promise<void> | void;
  setNote: SetNote;
}) {
  const [busy, setBusy] = useState(false);

  return (
    <Panel title="Xdebug">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs leading-relaxed text-gray-700">
          Enable step debugging for this site only — its PHP moves to a
          separate debug pool with Xdebug loaded; every other site stays on the
          shared pool at full speed.
        </p>
        <button
          role="switch"
          aria-checked={site.xdebug}
          disabled={busy}
          onClick={() =>
            void (async () => {
              setBusy(true);
              setNote(null);
              try {
                setNote(await api.siteSetXdebug(site.domain, !site.xdebug));
                await onChanged();
              } catch (e) {
                setNote(errorText(e));
              } finally {
                setBusy(false);
              }
            })()
          }
          className={clsx(
            "relative h-6 w-11 flex-shrink-0 rounded-full transition-colors disabled:opacity-50",
            site.xdebug ? "bg-blue-600" : "bg-gray-300",
          )}
        >
          <span
            className={clsx(
              "absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform",
              site.xdebug ? "translate-x-5" : "translate-x-0",
            )}
          />
        </button>
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------- domains

function DomainsPanel({
  site,
  onChanged,
  setNote,
}: {
  site: Site;
  onChanged: () => Promise<void> | void;
  setNote: SetNote;
}) {
  const [alias, setAlias] = useState("");
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);

  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    setNote(null);
    try {
      setNote(await fn());
      await onChanged();
    } catch (e) {
      setNote(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="Domains">
      <ul className="space-y-1.5">
        <li className="flex items-center gap-2">
          <span className="font-mono text-sm text-gray-900">{site.domain}</span>
          <span className="text-[10px] text-gray-400">primary</span>
        </li>
        {site.aliases.map((a) => (
          <li key={a} className="flex items-center gap-2">
            <span className="font-mono text-sm text-gray-700">{a}</span>
            <button
              title={`Remove ${a}`}
              disabled={busy}
              onClick={() => setRemoving(a)}
              className="rounded-md p-1 text-gray-400 transition-colors hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
            >
              <TrashIcon className="h-3.5 w-3.5" />
            </button>
          </li>
        ))}
      </ul>

      <div className="mt-3 flex items-center gap-2 border-t border-gray-100 pt-3">
        <input
          value={alias}
          onChange={(e) => setAlias(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && alias.trim())
              void run(async () => {
                const added = alias.trim();
                await api.siteAddDomain(site.domain, added);
                setAlias("");
                return `${added} added.`;
              });
          }}
          placeholder="another.test"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          className={clsx(field, "w-56 font-mono text-xs")}
        />
        <button
          disabled={busy || !alias.trim()}
          onClick={() =>
            void run(async () => {
              await api.siteAddDomain(site.domain, alias.trim());
              const added = alias.trim();
              setAlias("");
              return `${added} added.`;
            })
          }
          className={ghost}
        >
          Add domain
        </button>
      </div>

      <p className={hint}>
        The site answers on every name listed here — same files, same database.
        Adding one re-issues the certificate to cover it and reloads the web
        server.
      </p>

      <ConfirmDialog
        open={removing !== null}
        title={`Remove ${removing}?`}
        body="The site stops answering on that name. Its files and database are untouched."
        confirmLabel="Remove"
        busy={busy}
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          const a = removing;
          setRemoving(null);
          if (a) void run(() => api.siteRemoveDomain(site.domain, a));
        }}
      />
    </Panel>
  );
}

// ---------------------------------------------------- environment variables

function EnvPanel({ site, setNote }: { site: Site; setNote: SetNote }) {
  const [rows, setRows] = useState<[string, string][]>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setRows(await api.siteEnvGet(site.domain));
      setDirty(false);
    } catch {
      setRows([]);
    }
  }, [site.domain]);

  useEffect(() => {
    void load();
  }, [load]);

  const update = (i: number, which: 0 | 1, value: string) => {
    setRows((prev) => {
      const next = prev.map((r) => [...r] as [string, string]);
      next[i][which] = value;
      return next;
    });
    setDirty(true);
  };

  return (
    <Panel title="Environment variables">
      {rows.length === 0 ? (
        <p className="text-xs text-gray-600">
          No variables set. They're injected per request — the shared PHP pools
          are untouched.
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map(([k, v], i) => (
            <li key={i} className="flex items-center gap-2">
              <input
                value={k}
                onChange={(e) => update(i, 0, e.target.value)}
                placeholder="NAME"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                className={clsx(field, "w-56 font-mono text-xs")}
              />
              <span className="text-gray-400">=</span>
              <input
                value={v}
                onChange={(e) => update(i, 1, e.target.value)}
                placeholder="value"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                className={clsx(field, "min-w-0 flex-1 font-mono text-xs")}
              />
              <button
                title="Remove"
                onClick={() => {
                  setRows((prev) => prev.filter((_, j) => j !== i));
                  setDirty(true);
                }}
                className="rounded-md p-1 text-gray-400 transition-colors hover:bg-red-50 hover:text-red-600"
              >
                <TrashIcon className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 flex items-center justify-between gap-2">
        <button
          onClick={() => {
            setRows((prev) => [...prev, ["", ""]]);
            setDirty(true);
          }}
          className={clsx(ghost, "inline-flex items-center gap-1.5")}
        >
          <PlusIcon className="h-4 w-4" />
          Add variable
        </button>

        <button
          disabled={!dirty || busy}
          onClick={() =>
            void (async () => {
              setBusy(true);
              setNote(null);
              try {
                // Blank names are dropped rather than saved as an empty key.
                const clean = rows.filter(([k]) => k.trim() !== "");
                setNote(await api.siteEnvSet(site.domain, clean));
                await load();
              } catch (e) {
                setNote(errorText(e));
              } finally {
                setBusy(false);
              }
            })()
          }
          className="rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save"}
        </button>
      </div>

      <p className={hint}>
        Available to PHP via getenv() and $_SERVER. Stored as plain text in
        Nexora's database; not for secrets.
      </p>
    </Panel>
  );
}
