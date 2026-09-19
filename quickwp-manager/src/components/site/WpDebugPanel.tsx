import { BugAntIcon, ExclamationTriangleIcon } from "@heroicons/react/24/outline";
import clsx from "clsx";
import { useDebugState } from "../../lib/wpSettings";

/**
 * Whether this site writes a debug log, over its log. Read only: the switches
 * and the site's own debug code are the Debugging tab's, so wp-config.php is
 * written from one place.
 */
export default function WpDebugPanel({
  domain,
  size,
  path,
  actions,
}: {
  domain: string;
  /** The debug log's size, when it exists. */
  size?: string | null;
  /** Where the debug log is, shown on hover. */
  path?: string;
  /** The log's own actions -- refresh, download, open, clear -- so this tab
   *  has one bar rather than a panel under a toolbar. */
  actions?: React.ReactNode;
}) {
  const { data: debug, error } = useDebugState(domain);
  const logging = Boolean(debug?.logging);

  return (
    <section className="flex-shrink-0 border-b border-gray-200 bg-gradient-to-b from-gray-50/80 to-white px-4 py-3.5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="flex min-w-0 items-center gap-3">
          <span
            className={clsx(
              "grid h-9 w-9 flex-shrink-0 place-items-center rounded-xl ring-1 ring-inset transition-colors",
              logging ? "bg-emerald-50 text-emerald-600 ring-emerald-100" : "bg-white text-gray-400 ring-gray-200",
            )}
          >
            <BugAntIcon className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-sm font-semibold text-gray-900" title={path || undefined}>
              Debug logging
              {debug && (
                <span
                  className={clsx(
                    "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
                    logging ? "bg-emerald-50 text-emerald-700" : "bg-gray-100 text-gray-500",
                  )}
                >
                  <span className={clsx("h-1.5 w-1.5 rounded-full", logging ? "bg-emerald-500" : "bg-gray-400")} />
                  {logging ? "On" : "Off"}
                </span>
              )}
              {size && <span className="text-[11px] font-normal text-gray-400">debug.log · {size}</span>}
            </p>
            <p className="mt-0.5 text-xs text-gray-500">
              {!debug
                ? "Reading wp-config.php…"
                : logging
                  ? "WordPress writes PHP notices, warnings and errors to wp-content/debug.log."
                  : "Turn it on under Debugging to record PHP notices, warnings and errors here."}
            </p>
          </div>
        </div>

        {actions && <div className="ml-auto flex items-center gap-0.5">{actions}</div>}
      </div>

      {error && (
        <p role="alert" className="mt-3 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs leading-relaxed text-red-700">
          <ExclamationTriangleIcon className="mt-px h-4 w-4 flex-shrink-0" />
          <span className="break-words">{error}</span>
        </p>
      )}
    </section>
  );
}
