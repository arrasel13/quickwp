import { useState } from "react";
import { open as pickFile } from "@tauri-apps/plugin-dialog";
import clsx from "clsx";
import { api, errorText, type Site } from "../../lib/api";
import { useSites } from "../../lib/sites";
import ConfirmDialog from "../ui/ConfirmDialog";
import {
  DatabaseTableIcon,
  DeleteIcon,
  DuplicateIcon,
  ExportIcon,
  ImportIcon,
} from "../ui/WpIcons";

type Busy = "duplicate" | "import" | "export-all" | "export-db";

/**
 * What is done to a site as a whole: copy it, load a database into it, export
 * it, delete it. In Overview, and at the top of WordPress › Tools.
 */
export default function SiteManage({ site, onDeleted }: { site: Site; onDeleted?: () => void }) {
  const { reload, select } = useSites();
  const [busy, setBusy] = useState<Busy | null>(null);
  /** What the last action did. An export names the file it wrote. */
  const [note, setNote] = useState<{ ok: boolean; text: string; file?: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  /** A dump picked for Import, waiting on "this replaces the database". */
  const [importFile, setImportFile] = useState<string | null>(null);
  const isWordPress = site.kind === "wordpress";
  const hasDb = Boolean(site.db_name && site.db_engine);

  const run = async (key: Busy, fn: () => Promise<{ text: string; file?: string }>) => {
    setBusy(key);
    setNote(null);
    try {
      setNote({ ok: true, ...(await fn()) });
    } catch (e) {
      setNote({ ok: false, text: errorText(e) });
    } finally {
      setBusy(null);
    }
  };

  // The copy opens once it is made: it is what was asked for.
  const duplicate = () =>
    void run("duplicate", async () => {
      const copy = await api.siteDuplicate(site.domain);
      await reload();
      select(String(copy.id));
      return { text: `Duplicated as ${copy.domain}.` };
    });

  const chooseImport = async () => {
    const picked = await pickFile({
      multiple: false,
      directory: false,
      filters: [{ name: "Database dump", extensions: ["sql"] }],
    }).catch(() => null);
    if (typeof picked === "string") setImportFile(picked);
  };

  const importNow = (file: string) => {
    setImportFile(null);
    void run("import", async () => {
      // Through WP-CLI for WordPress, so its own import handling applies;
      // straight into MySQL for anything else with a database.
      if (isWordPress) return { text: await api.wpImportDatabase(site.domain, file) };
      await api.dbImport(site.db_engine!, site.db_name!, file);
      return { text: `Imported ${file}.` };
    });
  };

  const exportAll = () =>
    void run("export-all", async () => {
      const file = await api.siteExportAll(site.domain);
      return { text: `Site exported to ${file}`, file };
    });

  const exportDb = () =>
    void run("export-db", async () => {
      const file = isWordPress
        ? await api.wpExportDatabase(site.domain)
        : await api.dbExport(site.db_engine!, site.db_name!);
      return { text: `Database exported to ${file}`, file };
    });

  const label = (key: Busy, idle: string, working: string) => (busy === key ? working : idle);

  return (
    <section>
      <h2 className="mb-3 text-sm font-semibold text-gray-900">Manage</h2>
      <div className="grid grid-cols-1 gap-2.5">
        <Action
          icon={DuplicateIcon}
          label={label("duplicate", "Duplicate", "Duplicating…")}
          busy={busy === "duplicate"}
          disabled={busy !== null}
          onClick={duplicate}
        />
        <Action
          icon={ImportIcon}
          label={label("import", "Import", "Importing…")}
          busy={busy === "import"}
          disabled={busy !== null || !hasDb}
          title={hasDb ? "Load a .sql dump into this site's database" : "This site has no database"}
          onClick={() => void chooseImport()}
        />
        <Action
          icon={ExportIcon}
          label={label("export-all", "Export entire site", "Exporting…")}
          busy={busy === "export-all"}
          disabled={busy !== null}
          onClick={exportAll}
        />
        <Action
          icon={DatabaseTableIcon}
          label={label("export-db", "Export database", "Exporting…")}
          busy={busy === "export-db"}
          disabled={busy !== null || !hasDb}
          title={hasDb ? undefined : "This site has no database"}
          onClick={exportDb}
        />
        <Action
          icon={DeleteIcon}
          label="Delete"
          destructive
          disabled={busy !== null}
          onClick={() => setConfirmDelete(true)}
        />
      </div>

      {note && (
        <div
          role={note.ok ? "status" : "alert"}
          className={clsx(
            "mt-3 rounded-lg border px-3 py-2 text-[12px] leading-relaxed",
            note.ok ? "border-green-200 bg-green-50 text-green-900" : "border-red-200 bg-red-50 text-red-900",
          )}
        >
          <p className="break-all">{note.text}</p>
          {note.file && (
            <button
              type="button"
              onClick={() => void api.pathOpen(note.file!).catch(() => {})}
              className="mt-1 font-medium underline underline-offset-2 hover:no-underline"
            >
              Show in Finder
            </button>
          )}
        </div>
      )}

      <ConfirmDialog
        open={importFile !== null}
        title={`Import into ${site.domain}?`}
        confirmLabel="Import"
        body={
          <span>
            <code className="font-mono text-[11px]">{importFile}</code> replaces the tables of{" "}
            <code className="font-mono text-[11px]">{site.db_name}</code>. What the site has now
            is gone unless you export it first.
          </span>
        }
        onCancel={() => setImportFile(null)}
        onConfirm={() => importFile && importNow(importFile)}
      />

      <ConfirmDialog
        open={confirmDelete}
        title={`Delete ${site.domain}?`}
        busy={deleting}
        confirmLabel="Delete site"
        body={
          <span>
            {site.is_linked ? (
              <>
                This removes the site from Nexora. Its folder at{" "}
                <code className="font-mono text-[11px]">{site.docroot}</code> is linked, so it stays
                where it is
              </>
            ) : (
              <>
                This removes the site, its folder at{" "}
                <code className="font-mono text-[11px]">{site.docroot}</code>
              </>
            )}
            {site.db_name ? (
              <>
                , its database <code className="font-mono text-[11px]">{site.db_name}</code>
              </>
            ) : null}{" "}
            and its certificate. It cannot be undone — export it first if you might want it back.
          </span>
        }
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => {
          setDeleting(true);
          void api
            .siteDelete(site.domain)
            .then(async () => {
              setConfirmDelete(false);
              await reload();
              onDeleted?.();
            })
            .catch((e) => setNote({ ok: false, text: errorText(e) }))
            .finally(() => setDeleting(false));
        }}
      />
    </section>
  );
}

/** One row of Manage, Maintenance or Backup & restore. */
export function Action({
  icon: Icon,
  label,
  onClick,
  destructive,
  disabled,
  busy,
  title,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
  destructive?: boolean;
  disabled?: boolean;
  busy?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-busy={busy || undefined}
      className={clsx(
        "flex items-center gap-3 rounded-md border border-gray-300 bg-white px-3.5 py-2.5 text-left text-[13px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        destructive ? "text-red-900 hover:bg-red-50" : "text-gray-900 hover:bg-gray-50",
      )}
    >
      {busy ? (
        <span
          aria-hidden
          className="h-4 w-4 flex-shrink-0 animate-spin rounded-full border-2 border-gray-200 border-t-gray-500"
        />
      ) : (
        <Icon className={clsx("h-5 w-5 flex-shrink-0", destructive ? "text-red-900" : "text-gray-800")} />
      )}
      <span className="truncate">{label}</span>
    </button>
  );
}
