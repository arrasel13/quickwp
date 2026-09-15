import { useEffect, useState } from "react";
import { CheckIcon, ExclamationTriangleIcon } from "@heroicons/react/24/outline";
import clsx from "clsx";
import { api, errorText, hasBackend, UpdateOffer } from "../lib/api";
import markUrl from "../assets/nexora-mark.svg";

/**
 * Asked when a newer Nexora installer is opened while this one runs. Finder
 * cannot copy over a running app, so the update is installed from here:
 * "Close and Reopen" swaps the new Nexora in and opens it again, with the
 * sites kept running throughout.
 */
export default function UpdateOverlay() {
  const [offer, setOffer] = useState<UpdateOffer | null>(null);
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!hasBackend) return;
    const offs: Array<() => void> = [];
    const show = (o: UpdateOffer) => {
      setError(null);
      setClosing(false);
      setOffer(o);
    };
    void api.onUpdateAvailable(show).then((off) => offs.push(off));
    void api
      .onUpdateWithdrawn(() => {
        setOffer(null);
        setClosing(false);
      })
      .then((off) => offs.push(off));
    // Announced before this window was listening -- right after launch.
    void api
      .appUpdatePending()
      .then((o) => o && show(o))
      .catch(() => {});
    return () => offs.forEach((off) => off());
  }, []);

  if (!offer) return null;

  const restart = async () => {
    setClosing(true);
    setError(null);
    try {
      await api.appUpdateRestart();
      // Nexora closes now; the new one opens in a moment.
    } catch (e) {
      setError(errorText(e));
      setClosing(false);
    }
  };

  const later = () => {
    setOffer(null);
    void api.appUpdateLater().catch(() => {});
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="update-title"
      className="fixed inset-0 z-[90] flex items-center justify-center bg-gray-950/50 p-6 backdrop-blur-[2px]"
    >
      <div className="w-full max-w-[380px] overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-black/5">
        <div className="px-7 pb-6 pt-7 text-center">
          <div className="relative mx-auto grid h-16 w-16 place-items-center rounded-2xl bg-gray-50 ring-1 ring-inset ring-gray-200">
            <img src={markUrl} alt="" aria-hidden draggable={false} className="h-8 w-8" />
            {closing && (
              <span
                aria-hidden
                className="absolute -inset-1 animate-spin rounded-[20px] border-2 border-transparent border-t-wp-blue"
              />
            )}
          </div>
          <h2 id="update-title" className="mt-5 text-[17px] font-semibold text-gray-900">
            {closing ? "Updating Nexora…" : "Nexora update ready"}
          </h2>
          <p className="mx-auto mt-1.5 max-w-[300px] text-sm leading-relaxed text-gray-500">
            {closing
              ? "Nexora is closing to install the new version. It opens again in a few seconds."
              : "A new version of Nexora is ready to install. Restart the app to finish updating."}
          </p>

          <ul className="mx-auto mt-4 inline-flex flex-col gap-1.5 text-left text-xs text-gray-600">
            <li className="flex items-center gap-2">
              <CheckIcon className="h-3.5 w-3.5 flex-shrink-0 text-emerald-600" />
              Your sites keep running while it updates
            </li>
            <li className="flex items-center gap-2">
              <CheckIcon className="h-3.5 w-3.5 flex-shrink-0 text-emerald-600" />
              No need to drag Nexora into Applications
            </li>
          </ul>

          {error && (
            <p
              role="alert"
              className="mt-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-left text-xs leading-relaxed text-red-700"
            >
              <ExclamationTriangleIcon className="mt-px h-4 w-4 flex-shrink-0" />
              <span className="break-words">{error}</span>
            </p>
          )}
        </div>

        <div className="flex gap-2.5 border-t border-gray-100 bg-gray-50/80 px-6 py-4">
          <button
            type="button"
            onClick={later}
            disabled={closing}
            className="flex-1 rounded-lg bg-white px-4 py-2 text-sm font-medium text-gray-700 ring-1 ring-inset ring-gray-300 transition-colors hover:bg-gray-50 disabled:opacity-50"
          >
            Later
          </button>
          <button
            type="button"
            onClick={() => void restart()}
            disabled={closing}
            className={clsx(
              "inline-flex flex-1 items-center justify-center gap-2 rounded-lg bg-wp-blue px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-wp-blue-dark",
              closing && "cursor-wait opacity-80",
            )}
          >
            {closing && (
              <span aria-hidden className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" />
            )}
            {closing ? "Closing…" : "Close and Reopen"}
          </button>
        </div>
      </div>
    </div>
  );
}
