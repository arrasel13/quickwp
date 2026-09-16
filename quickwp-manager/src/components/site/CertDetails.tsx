import { useState } from "react";
import {
  DocumentDuplicateIcon,
  FolderOpenIcon,
  LockClosedIcon,
  LockOpenIcon,
} from "@heroicons/react/24/outline";
import clsx from "clsx";
import { api, errorText, type CertInfo } from "../../lib/api";
import { useAsync } from "../../lib/useAsync";

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

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="flex-shrink-0 text-xs text-gray-600">{label}</dt>
      <dd className="min-w-0 truncate text-right text-xs text-gray-900">{children}</dd>
    </div>
  );
}

/**
 * A site's SSL state and its certificate: whether it is served over trusted
 * HTTPS, the certificate's dates, names and file, and re-issuing it.
 *
 * Drawn in the preview's lock menu, in the overlay above the site preview.
 */
export default function CertDetails({ domain, active }: { domain: string; active: boolean }) {
  const { data: cert, reload } = useAsync<CertInfo>(
    () => api.siteCertInfo(domain),
    [domain],
    `site-cert:${domain}`,
  );
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const left = cert?.expires_at ? daysUntil(cert.expires_at) : null;

  const regenerate = async () => {
    setBusy(true);
    setNote(null);
    try {
      setNote({ ok: true, text: await api.siteRegenerateCert(domain) });
      await reload();
    } catch (e) {
      setNote({ ok: false, text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="w-[380px] max-w-[calc(100vw-16px)] p-2">
      <div className="flex items-center justify-between gap-3 px-1 pb-3 pt-1">
        <span className="text-xs text-gray-600">SSL certificate</span>
        <span className="flex items-center gap-1.5 text-xs font-medium">
          {active ? (
            <LockClosedIcon className="h-3.5 w-3.5 text-green-600" />
          ) : (
            <LockOpenIcon className="h-3.5 w-3.5 text-gray-400" />
          )}
          <span className={active ? "text-gray-900" : "text-gray-500"}>
            {active ? "Trusted" : "Not enabled"}
          </span>
        </span>
      </div>

      <section className="rounded-xl border border-gray-200 bg-white p-3.5">
        <h4 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
          HTTPS certificate
        </h4>

        {cert === null ? (
          <p className="text-xs text-gray-500">Reading the certificate…</p>
        ) : !cert.exists && !cert.issued_at ? (
          <p className="text-xs leading-relaxed text-gray-500">
            No certificate yet — turn on HTTPS in Nexora Settings › General and one is issued for
            this site.
          </p>
        ) : (
          <>
            <dl className="space-y-2.5">
              <Row label="Issued">{cert.issued_at ? formatDate(cert.issued_at) : "—"}</Row>
              <Row label="Expires">
                {cert.expires_at ? (
                  <span>
                    {formatDate(cert.expires_at)}{" "}
                    <span
                      className={clsx(
                        "text-[11px]",
                        left !== null && left < 14 ? "text-amber-600" : "text-gray-400",
                      )}
                    >
                      {left === null ? "" : left < 0 ? "expired" : `in ${left} days`}
                    </span>
                  </span>
                ) : (
                  "—"
                )}
              </Row>
              <Row label="Domains">
                <span className="font-mono">{cert.names.join(", ")}</span>
              </Row>
            </dl>

            <div className="mt-3">
              <div className="mb-1.5 text-xs text-gray-600">Certificate folder</div>
              <div className="flex items-center gap-1 rounded-lg bg-gray-50 py-1.5 pl-3 pr-1.5">
                <span
                  className="min-w-0 flex-1 truncate font-mono text-[11px] text-gray-700"
                  title={cert.path}
                >
                  {cert.path}
                </span>
                <button
                  type="button"
                  title={copied ? "Copied" : "Copy"}
                  onClick={() =>
                    void navigator.clipboard
                      .writeText(cert.path)
                      .then(() => {
                        setCopied(true);
                        setTimeout(() => setCopied(false), 1200);
                      })
                      .catch(() => {})
                  }
                  className="flex-shrink-0 rounded-md p-1 text-gray-400 transition-colors hover:bg-gray-200 hover:text-gray-700"
                >
                  <DocumentDuplicateIcon className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  title="Reveal in Finder"
                  onClick={() =>
                    void api
                      .pathOpen(cert.path)
                      .catch((e) => setNote({ ok: false, text: errorText(e) }))
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
            Re-issue from the local CA — for a cert nearing expiry, a corrupted file, or after the
            CA was re-created. Briefly reloads the edge.
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void regenerate()}
            className="flex-shrink-0 rounded-lg border border-gray-300 bg-white px-3 py-2 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "Working…" : "Regenerate"}
          </button>
        </div>

        {note && (
          <p
            role={note.ok ? "status" : "alert"}
            className={clsx(
              "mt-3 break-words rounded-lg px-2.5 py-1.5 text-[11px]",
              note.ok ? "bg-green-50 text-green-900" : "bg-red-50 text-red-900",
            )}
          >
            {note.text}
          </p>
        )}
      </section>
    </div>
  );
}
