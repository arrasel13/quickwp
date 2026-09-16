import { useState } from "react";
import { ArrowUpTrayIcon, TableCellsIcon, TrashIcon } from "@heroicons/react/24/outline";
import clsx from "clsx";
import { api, errorText, Site } from "../../lib/api";
import ConfirmDialog from "../ui/ConfirmDialog";

/**
 * Export and delete: the things done to a site as a whole. Shown at the top of
 * WordPress › Tools, and beneath "Not a WordPress site" for other kinds -- a
 * site without WordPress still has to be deletable.
 */
export default function SiteManage({ site, onDeleted }: { site: Site; onDeleted?: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const isWordPress = site.kind === "wordpress";

  const run = async (key: string, fn: () => Promise<string>) => {
    setBusy(key);
    setNote(null);
    try {
      setNote({ ok: true, text: await fn() });
    } catch (e) {
      setNote({ ok: false, text: errorText(e) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <h4 className="mb-3 text-sm font-semibold text-gray-900">Manage</h4>
      <div className="grid gap-3 pane-sm:grid-cols-3">
        <Action
          icon={ArrowUpTrayIcon}
          label={busy === "export-all" ? "Exporting…" : "Export entire site"}
          disabled={busy !== null}
          onClick={() =>
            void run("export-all", async () => `Exported to ${await api.siteExportAll(site.domain)}`)
          }
        />
        {/* Through WP-CLI, so only for WordPress; the Database tab exports
            any site's database. */}
        {isWordPress && (
          <Action
            icon={TableCellsIcon}
            label={busy === "export-db" ? "Exporting…" : "Export database"}
            disabled={busy !== null}
            onClick={() =>
              void run(
                "export-db",
                async () => `Database exported to ${await api.wpExportDatabase(site.domain)}`,
              )
            }
          />
        )}
        <Action
          icon={TrashIcon}
          label="Delete"
          destructive
          disabled={busy !== null}
          onClick={() => setConfirmDelete(true)}
        />
      </div>

      {note && (
        <p
          className={clsx(
            "mt-3 break-all rounded-lg border px-3 py-2 font-mono text-[11px]",
            note.ok
              ? "border-green-200 bg-green-50 text-green-900"
              : "border-red-200 bg-red-50 text-red-900",
          )}
        >
          {note.text}
        </p>
      )}

      <ConfirmDialog
        open={confirmDelete}
        title={`Delete ${site.domain}?`}
        busy={deleting}
        confirmLabel="Delete site"
        body={
          <span>
            This removes the site record, its folder at{" "}
            <code className="font-mono text-[11px]">{site.docroot}</code>
            {site.db_name ? (
              <>
                , its database <code className="font-mono text-[11px]">{site.db_name}</code>
              </>
            ) : null}{" "}
            and its certificate. It cannot be undone — export it first if you
            might want it back.
          </span>
        }
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => {
          setDeleting(true);
          void api
            .siteDelete(site.domain)
            .then(() => {
              setConfirmDelete(false);
              onDeleted?.();
            })
            .catch((e) => setNote({ ok: false, text: errorText(e) }))
            .finally(() => setDeleting(false));
        }}
      />
    </section>
  );
}

function Action({
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
        "flex items-center gap-2.5 rounded-lg border border-gray-200 bg-white px-3.5 py-3 text-left text-sm font-medium transition-colors disabled:opacity-50",
        destructive ? "text-red-700 hover:bg-red-50" : "text-gray-800 hover:bg-gray-50",
      )}
    >
      <Icon className={clsx("h-4 w-4 flex-shrink-0", destructive ? "text-red-600" : "text-gray-400")} />
      <span className="truncate">{label}</span>
    </button>
  );
}
