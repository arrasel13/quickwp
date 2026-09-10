import { useState } from "react";
import {
  ArrowPathIcon,
  PlayIcon,
  StopIcon,
  ArrowTopRightOnSquareIcon,
  EnvelopeIcon,
} from "@heroicons/react/24/outline";
import clsx from "clsx";
import { api, errorText, hasBackend } from "../../lib/api";
import { useAsync } from "../../lib/useAsync";

export default function MailTab() {
  const { data: st, error, loading, reload } = useAsync(() => api.mailStatus(), [], "mail-status");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setNotice(null);
    try {
      const r = await fn();
      if (typeof r === "string") setNotice(r);
      await reload();
    } catch (e) {
      setNotice(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  if (!hasBackend) {
    return (
      <div className="max-w-6xl mx-auto p-6">
        <div className="border border-amber-200 bg-amber-50 rounded-lg p-5 max-w-xl">
          <h2 className="text-sm font-semibold text-amber-900 mb-1">No backend behind this window</h2>
          <p className="text-xs text-amber-800">
            Run <code className="bg-amber-100 px-1 rounded">npm run tauri dev</code>.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto p-4 space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Mail</h1>
          <p className="text-xs text-gray-600">
            Every message your sites send is caught here. None are delivered.
          </p>
        </div>
        <button
          onClick={() => void reload()}
          disabled={loading}
          className="inline-flex items-center px-3 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50"
        >
          <ArrowPathIcon className={clsx("h-4 w-4 mr-2", loading && "animate-spin")} />
          Refresh
        </button>
      </div>

      {notice && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-xs text-blue-900 whitespace-pre-wrap">
          {notice}
        </div>
      )}
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-900">{error}</div>
      )}

      <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-start gap-3">
            <EnvelopeIcon className={clsx("h-5 w-5 mt-0.5", st?.running ? "text-green-600" : "text-gray-400")} />
            <div>
              <h2 className="text-sm font-semibold text-gray-900">
                Mailpit {st?.running ? "is running" : st?.installed ? "is stopped" : "is not installed"}
              </h2>
              <p className="text-xs text-gray-600 tabular-nums">
                SMTP on {st?.smtp_port} · web UI on {st?.ui_port}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {!st?.installed ? (
              <button
                onClick={() => void act(api.mailInstall)}
                disabled={busy}
                className="px-4 py-2 text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50"
              >
                {busy ? "Installing…" : "Install Mailpit"}
              </button>
            ) : (
              <>
                <button
                  onClick={() => void act(st.running ? api.mailStop : api.mailStart)}
                  disabled={busy}
                  className={clsx(
                    "inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-md text-white disabled:opacity-50",
                    st.running ? "bg-gray-700 hover:bg-gray-800" : "bg-blue-600 hover:bg-blue-700",
                  )}
                >
                  {st.running ? <StopIcon className="h-4 w-4" /> : <PlayIcon className="h-4 w-4" />}
                  {st.running ? "Stop" : "Start"}
                </button>
                {st.running && (
                  <button
                    onClick={() => void api.mailOpen()}
                    className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-md border border-gray-300 text-gray-700 bg-white hover:bg-gray-50"
                  >
                    <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5" />
                    Open inbox
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-gray-900">Catch all outgoing mail</h2>
            <p className="text-xs text-gray-600 max-w-prose">
              On, every site's mail goes to Mailpit instead of the internet — even a site
              configured for a real SMTP provider.{" "}
              <strong>Turn it off only to test a live provider on purpose.</strong>
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={!!st?.catch_all}
            disabled={busy}
            onClick={() => void act(() => api.mailSetCatchAll(!st?.catch_all))}
            className={clsx(
              "relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none focus:ring-2 focus:ring-blue-600 focus:ring-offset-2 disabled:opacity-50",
              st?.catch_all ? "bg-blue-600" : "bg-gray-200",
            )}
          >
            <span
              aria-hidden="true"
              className={clsx(
                "pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow transition",
                st?.catch_all ? "translate-x-4" : "translate-x-0",
              )}
            />
          </button>
        </div>

        <div className="mt-4 border-t border-gray-100 pt-3">
          <h3 className="text-[10px] font-semibold uppercase tracking-wider text-gray-500 mb-2">
            Three ways mail escapes, all three covered
          </h3>
          <dl className="space-y-2 text-xs">
            {[
              ["PHP's own mail()", "The pool's sendmail_path — this is what catches a plain WordPress site."],
              [
                "An SMTP plugin",
                "WP Mail SMTP, FluentSMTP and every plugin of that shape call isSMTP(), after which PHPMailer opens its own socket. A mu-plugin hooks the same filter last and points it back.",
              ],
              [
                "Laravel",
                "Ignores php.ini entirely. The pool carries MAIL_* in its environment, which outranks the project's .env.",
              ],
            ].map(([k, v]) => (
              <div key={k} className="border border-gray-200 rounded-lg px-3 py-2">
                <dt className="font-semibold text-gray-900">{k}</dt>
                <dd className="text-gray-600 leading-relaxed">{v}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-[11px] leading-relaxed text-gray-500">
            Not everything can be caught: a Laravel app that has run{" "}
            <code className="bg-gray-100 px-1 rounded">php artisan config:cache</code> reads its
            baked config, a plugin that mails through a provider's HTTP API never touches PHP's
            mailer, and commands you run in your own terminal are outside QuickWP.
          </p>
        </div>
      </div>
    </div>
  );
}
