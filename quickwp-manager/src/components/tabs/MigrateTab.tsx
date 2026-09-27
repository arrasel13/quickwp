import { useEffect, useMemo, useState } from "react";
import {
  ArrowDownTrayIcon,
  ArrowPathIcon,
  CheckCircleIcon,
  CircleStackIcon,
  DocumentArrowUpIcon,
  ExclamationTriangleIcon,
  FolderOpenIcon,
  ShieldCheckIcon,
} from "@heroicons/react/24/outline";
import { open as pick } from "@tauri-apps/plugin-dialog";
import clsx from "clsx";
import {
  api,
  errorText,
  hasBackend,
  type ImportCandidate,
  type ImportProgress,
  type ImportRequest,
  type ImportResult,
} from "../../lib/api";
import { useAppData } from "../../lib/appData";

/** The tools Nexora imports from, in the order they are shown. */
const TOOLS = ["Herd", "Valet", "LocalWP", "rexenv"] as const;
const TOOL_NAMES: Record<string, string> = {
  Herd: "Laravel Herd",
  Valet: "Laravel Valet",
  LocalWP: "LocalWP",
  rexenv: "rexenv",
  Folder: "Folder",
};

const key = (s: ImportCandidate) => `${s.source}:${s.path}`;
const canCopyDb = (s: ImportCandidate) => Boolean(s.database?.supported && (s.database.running || !s.database.note));

/**
 * Bringing sites across from other local environments -- Laravel Herd and
 * Valet, LocalWP and rexenv -- with their databases, or from any folder and a
 * dump file.
 *
 * Files are copied into Nexora's sites folder and databases are read, so the
 * other tool keeps working exactly as before.
 */
export default function MigrateTab() {
  const { data: scan, error, loading, reload } = useAppData("import-scan");
  const [chosen, setChosen] = useState<Record<string, boolean>>({});
  const [withDb, setWithDb] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<Record<string, ImportProgress>>({});
  const [results, setResults] = useState<Record<string, ImportResult>>({});

  useEffect(() => {
    let off: (() => void) | undefined;
    void api.onImportProgress((p) => setProgress((all) => ({ ...all, [p.domain]: p }))).then((f) => {
      off = f as () => void;
    });
    return () => off?.();
  }, []);

  const sites = scan?.sites ?? [];
  const importable = sites.filter((s) => s.importable);
  const selected = importable.filter((s) => chosen[key(s)]);
  const groups = useMemo(
    () => TOOLS.map((t) => [t, sites.filter((s) => s.source === t)] as const).filter(([, list]) => list.length > 0),
    [sites],
  );

  const run = async (requests: ImportRequest[]) => {
    setBusy(true);
    setProgress({});
    setResults((r) => {
      const next = { ...r };
      requests.forEach((q) => delete next[q.domain]);
      return next;
    });
    try {
      const out = await api.importSites(requests);
      setResults((r) => ({ ...r, ...Object.fromEntries(out.map((o) => [o.domain, o])) }));
      setChosen({});
      await reload();
    } catch (e) {
      setResults((r) => ({
        ...r,
        ...Object.fromEntries(requests.map((q) => [q.domain, { domain: q.domain, ok: false, message: errorText(e), notes: [] }])),
      }));
    } finally {
      setBusy(false);
    }
  };

  const importSelected = () =>
    void run(
      selected.map((s) => ({
        source: s.source,
        path: s.path,
        name: s.name,
        domain: s.domain,
        php_minor: s.php_minor ?? "",
        include_database: canCopyDb(s) && withDb[key(s)] !== false,
        sql_file: null,
      })),
    );

  if (!hasBackend) {
    return <p className="p-6 text-sm text-gray-500">Importing needs the Nexora app behind this window.</p>;
  }

  return (
    <div className="space-y-4 p-5">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[17px] font-semibold text-gray-900">Import sites</h1>
          <p className="mt-0.5 text-[13px] text-gray-500">
            Bring sites and their databases across from Laravel Herd, Valet, LocalWP and rexenv — or
            from any folder.
          </p>
        </div>
        <button
          onClick={() => void reload()}
          disabled={loading || busy}
          className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          <ArrowPathIcon className={clsx("h-3.5 w-3.5", loading && "animate-spin")} />
          Scan again
        </button>
      </header>

      {/* Which tools are on this Mac. */}
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        {TOOLS.map((t) => {
          const count = sites.filter((s) => s.source === t).length;
          const present = scan?.tools.includes(t) ?? false;
          return (
            <div
              key={t}
              className={clsx(
                "rounded-md border px-3 py-2",
                present ? "border-gray-200 bg-white" : "border-dashed border-gray-200 bg-gray-50",
              )}
            >
              <p className={clsx("text-[13px] font-medium", present ? "text-gray-900" : "text-gray-400")}>
                {TOOL_NAMES[t]}
              </p>
              <p className="text-[11px] text-gray-500">
                {loading && !scan
                  ? "Looking…"
                  : present
                    ? `${count} site${count === 1 ? "" : "s"} found`
                    : "Not on this Mac"}
              </p>
            </div>
          );
        })}
      </div>

      <div className="flex items-start gap-2 rounded-md border border-green-200 bg-green-50 px-3 py-2.5">
        <ShieldCheckIcon className="mt-0.5 h-4 w-4 flex-shrink-0 text-green-700" />
        <p className="text-xs leading-relaxed text-green-900">
          <strong>The other app is never changed.</strong> Files are copied into ~/Nexora/Sites —
          cloned, so they take no extra space until they change — and databases are read, not moved.
          Only the copy is pointed at Nexora's MySQL, so the original keeps working where it is.
        </p>
      </div>

      {error && (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">{error}</p>
      )}

      {groups.length === 0 && !loading && (
        <div className="rounded-md border border-gray-200 bg-white px-4 py-6 text-center">
          <p className="text-sm font-medium text-gray-900">No sites found</p>
          <p className="mx-auto mt-1 max-w-md text-xs text-gray-500">
            None of Laravel Herd, Valet, LocalWP or rexenv has sites on this Mac. Import any site
            from its folder below.
          </p>
        </div>
      )}

      {groups.length > 0 && (
        <section className="overflow-hidden rounded-md border border-gray-200 bg-white">
          <div className="flex items-center justify-between gap-3 border-b border-gray-100 px-4 py-2.5">
            <p className="text-[13px] font-medium text-gray-900">
              {sites.length} site{sites.length === 1 ? "" : "s"} found
              <span className="ml-2 font-normal text-gray-500">Choose what to import</span>
            </p>
            <div className="flex items-center gap-3">
              {importable.length > 0 && (
                <button
                  onClick={() =>
                    setChosen(
                      selected.length === importable.length ? {} : Object.fromEntries(importable.map((s) => [key(s), true])),
                    )
                  }
                  disabled={busy}
                  className="text-xs font-medium text-wp-blue hover:text-wp-blue/80 disabled:opacity-50"
                >
                  {selected.length === importable.length ? "Select none" : "Select all"}
                </button>
              )}
              <button
                onClick={importSelected}
                disabled={busy || selected.length === 0}
                className="inline-flex items-center gap-1.5 rounded-md bg-wp-blue px-3 py-1.5 text-xs font-semibold text-white hover:bg-wp-blue/90 disabled:opacity-40"
              >
                <ArrowDownTrayIcon className="h-3.5 w-3.5" />
                {busy
                  ? "Importing…"
                  : `Import${selected.length ? ` ${selected.length} site${selected.length === 1 ? "" : "s"}` : ""}`}
              </button>
            </div>
          </div>

          {groups.map(([tool, list]) => (
            <div key={tool}>
              <p className="bg-gray-50 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                {TOOL_NAMES[tool]}
              </p>
              <ul className="divide-y divide-gray-100">
                {list.map((s) => (
                  <SiteRow
                    key={key(s)}
                    site={s}
                    checked={!!chosen[key(s)]}
                    onCheck={(v) => setChosen((c) => ({ ...c, [key(s)]: v }))}
                    includeDb={withDb[key(s)] !== false}
                    onIncludeDb={(v) => setWithDb((c) => ({ ...c, [key(s)]: v }))}
                    disabled={busy}
                    progress={progress[s.domain]}
                    result={results[s.domain]}
                  />
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}

      <FolderImport busy={busy} onImport={(r) => void run([r])} progress={progress} results={results} />
    </div>
  );
}

function SiteRow({
  site,
  checked,
  onCheck,
  includeDb,
  onIncludeDb,
  disabled,
  progress,
  result,
}: {
  site: ImportCandidate;
  checked: boolean;
  onCheck: (v: boolean) => void;
  includeDb: boolean;
  onIncludeDb: (v: boolean) => void;
  disabled: boolean;
  progress?: ImportProgress;
  result?: ImportResult;
}) {
  const db = site.database;
  const running = progress && !["Done", "Failed"].includes(progress.stage);
  return (
    <li className={clsx("flex items-start gap-3 px-4 py-3", !site.importable && !result && "opacity-60")}>
      <input
        type="checkbox"
        disabled={!site.importable || disabled}
        checked={checked}
        onChange={(e) => onCheck(e.target.checked)}
        className="mt-0.5 h-4 w-4 flex-shrink-0 rounded border-gray-300 text-wp-blue focus:ring-wp-blue"
        aria-label={`Import ${site.domain}`}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-[13px] font-semibold text-gray-900">{site.domain}</span>
          {site.source_domain && <span className="text-[11px] text-gray-400">was {site.source_domain}</span>}
          {site.is_wordpress && (
            <span className="rounded bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-700">WordPress</span>
          )}
          {site.php_minor && (
            <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-600">
              PHP {site.php_minor}
            </span>
          )}
        </div>
        <p className="mt-0.5 truncate font-mono text-[11px] text-gray-400" title={site.path}>
          {site.path}
        </p>

        {db ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
            <CircleStackIcon className="h-3.5 w-3.5 flex-shrink-0 text-gray-400" />
            <span className="font-mono text-gray-700">{db.name || "database"}</span>
            <span className="text-gray-400">·</span>
            <span className="text-gray-500">{db.location}</span>
            {db.supported && (
              <span
                className={clsx(
                  "rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                  db.running ? "bg-green-50 text-green-700" : "bg-gray-100 text-gray-500",
                )}
              >
                {db.running ? "Running" : "Stopped"}
              </span>
            )}
            {canCopyDb(site) && site.importable && (
              <label className="ml-auto inline-flex cursor-pointer items-center gap-1.5 text-gray-600">
                <input
                  type="checkbox"
                  checked={includeDb}
                  disabled={disabled}
                  onChange={(e) => onIncludeDb(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-gray-300 text-wp-blue focus:ring-wp-blue"
                />
                Import database
              </label>
            )}
          </div>
        ) : (
          <p className="mt-1.5 text-[11px] text-gray-400">No database found in its config — files only.</p>
        )}
        {db?.note && <p className="mt-1 text-[11px] text-amber-700">{db.note}</p>}
        {site.note && !result && <p className="mt-1 text-[11px] text-amber-700">{site.note}</p>}

        {running && !result && <Stage progress={progress!} />}
        {result && <Result result={result} />}
      </div>
    </li>
  );
}

function Stage({ progress }: { progress: ImportProgress }) {
  return (
    <p className="mt-2 flex items-center gap-2 text-xs text-gray-700">
      <span className="h-3 w-3 animate-spin rounded-full border-2 border-gray-200 border-t-wp-blue" />
      {progress.stage}
      {progress.bytes > 0 && <span className="tabular-nums text-gray-500">{(progress.bytes / 1048576).toFixed(0)} MB</span>}
    </p>
  );
}

function Result({ result }: { result: ImportResult }) {
  return (
    <div
      className={clsx(
        "mt-2 rounded-md px-2.5 py-2 text-xs leading-relaxed",
        result.ok ? "bg-green-50 text-green-900" : "bg-red-50 text-red-800",
      )}
    >
      <p className="flex items-start gap-1.5">
        {result.ok ? (
          <CheckCircleIcon className="mt-px h-4 w-4 flex-shrink-0 text-green-600" />
        ) : (
          <ExclamationTriangleIcon className="mt-px h-4 w-4 flex-shrink-0 text-red-500" />
        )}
        <span className="break-words">{result.message}</span>
      </p>
      {result.notes.map((n) => (
        <p key={n} className="mt-1 pl-5 text-amber-800">
          {n}
        </p>
      ))}
    </div>
  );
}

/** Any site, from its folder: a ReDock site, a copy from a server, anything. */
function FolderImport({
  busy,
  onImport,
  progress,
  results,
}: {
  busy: boolean;
  onImport: (r: ImportRequest) => void;
  progress: Record<string, ImportProgress>;
  results: Record<string, ImportResult>;
}) {
  const { data: settings } = useAppData("settings");
  const tld = settings?.tld ?? "test";
  const [folder, setFolder] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [dbMode, setDbMode] = useState<"config" | "file" | "none">("config");
  const [sqlFile, setSqlFile] = useState<string | null>(null);

  const label = name.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  const domain = label ? `${label}.${tld}` : "";
  const ready = Boolean(folder && label && (dbMode !== "file" || sqlFile));
  const p = domain ? progress[domain] : undefined;
  const r = domain ? results[domain] : undefined;

  const chooseFolder = async () => {
    const picked = await pick({ directory: true, multiple: false, title: "Choose the site's folder" });
    if (typeof picked === "string") {
      setFolder(picked);
      if (!name) setName(picked.split("/").filter(Boolean).pop()?.replace(/\.[a-z]+$/, "") ?? "");
    }
  };
  const chooseDump = async () => {
    const picked = await pick({
      multiple: false,
      title: "Choose a database dump",
      filters: [{ name: "SQL dump", extensions: ["sql", "gz"] }],
    });
    if (typeof picked === "string") setSqlFile(picked);
  };

  return (
    <section className="rounded-md border border-gray-200 bg-white px-4 py-3.5">
      <div className="flex items-center gap-2">
        <FolderOpenIcon className="h-4 w-4 text-gray-400" />
        <h2 className="text-[13px] font-semibold text-gray-900">Import from a folder</h2>
        <span className="text-xs text-gray-500">For ReDock or any other tool</span>
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <div>
          <p className="mb-1 text-[11px] font-medium text-gray-600">Site folder</p>
          <button
            onClick={() => void chooseFolder()}
            disabled={busy}
            className="flex w-full items-center gap-2 truncate rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-left text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            <FolderOpenIcon className="h-3.5 w-3.5 flex-shrink-0 text-gray-400" />
            <span className={clsx("truncate", !folder && "text-gray-400")}>{folder ?? "Choose a folder…"}</span>
          </button>
        </div>
        <div>
          <p className="mb-1 text-[11px] font-medium text-gray-600">Name</p>
          <div className="flex items-center rounded-md border border-gray-300 focus-within:border-wp-blue">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-site"
              disabled={busy}
              className="min-w-0 flex-1 rounded-md border-0 px-2.5 py-1.5 text-xs focus:ring-0"
            />
            <span className="pr-2.5 text-xs text-gray-400">.{tld}</span>
          </div>
        </div>
      </div>

      <div className="mt-3">
        <p className="mb-1 text-[11px] font-medium text-gray-600">Database</p>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-gray-700">
          {(
            [
              ["config", "Read it from wp-config.php or .env"],
              ["file", "Import a dump file (.sql or .sql.gz)"],
              ["none", "Files only"],
            ] as const
          ).map(([v, text]) => (
            <label key={v} className="inline-flex cursor-pointer items-center gap-1.5">
              <input
                type="radio"
                name="folder-db"
                checked={dbMode === v}
                onChange={() => setDbMode(v)}
                disabled={busy}
                className="h-3.5 w-3.5 border-gray-300 text-wp-blue focus:ring-wp-blue"
              />
              {text}
            </label>
          ))}
        </div>
        {dbMode === "file" && (
          <button
            onClick={() => void chooseDump()}
            disabled={busy}
            className="mt-2 flex w-full items-center gap-2 truncate rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-left text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-50 lg:w-1/2"
          >
            <DocumentArrowUpIcon className="h-3.5 w-3.5 flex-shrink-0 text-gray-400" />
            <span className={clsx("truncate", !sqlFile && "text-gray-400")}>{sqlFile ?? "Choose a dump file…"}</span>
          </button>
        )}
      </div>

      <div className="mt-3 flex items-center justify-end gap-3">
        {domain && <span className="text-xs text-gray-500">Will open at {domain}</span>}
        <button
          onClick={() =>
            folder &&
            onImport({
              source: "Folder",
              path: folder,
              name: name.trim() || label,
              domain,
              php_minor: "",
              include_database: dbMode !== "none",
              sql_file: dbMode === "file" ? sqlFile : null,
            })
          }
          disabled={busy || !ready}
          className="inline-flex items-center gap-1.5 rounded-md bg-wp-blue px-3 py-1.5 text-xs font-semibold text-white hover:bg-wp-blue/90 disabled:opacity-40"
        >
          <ArrowDownTrayIcon className="h-3.5 w-3.5" />
          Import
        </button>
      </div>
      {p && !r && !["Done", "Failed"].includes(p.stage) && <Stage progress={p} />}
      {r && <Result result={r} />}
    </section>
  );
}
