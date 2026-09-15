import { useEffect, useState } from "react";
import { ExclamationTriangleIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { api } from "../lib/api";
import markUrl from "../assets/nexora-mark.svg";

/**
 * What the window shows when a newer Nexora is opened while this one runs:
 * a moment's notice that it is about to close and come back updated, or why
 * it could not.
 */
export default function UpdateOverlay() {
  const [installing, setInstalling] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    const offs: Array<() => void> = [];
    void api.onUpdateInstalling(() => {
      setFailure(null);
      setInstalling(true);
    }).then((off) => offs.push(off));
    void api.onUpdateFailed((message) => {
      setInstalling(false);
      setFailure(message);
    }).then((off) => offs.push(off));
    return () => offs.forEach((off) => off());
  }, []);

  if (installing) {
    return (
      <div
        role="alertdialog"
        aria-live="assertive"
        aria-label="Installing the new Nexora"
        className="fixed inset-0 z-[90] flex items-center justify-center bg-gray-950/60 p-6 backdrop-blur-sm"
      >
        <div className="w-full max-w-sm rounded-2xl bg-white p-7 text-center shadow-2xl">
          <div className="relative mx-auto h-16 w-16">
            <span className="absolute inset-0 animate-spin rounded-full border-[3px] border-gray-100 border-t-wp-blue" />
            <span className="absolute inset-0 grid place-items-center">
              <img src={markUrl} alt="" aria-hidden draggable={false} className="h-7 w-7" />
            </span>
          </div>
          <h2 className="mt-5 text-base font-semibold text-gray-900">Installing the new Nexora</h2>
          <p className="mt-1.5 text-sm leading-relaxed text-gray-500">
            Nexora closes, updates and opens again in a few seconds. Your sites keep running.
          </p>
          <div className="mt-5 h-1 overflow-hidden rounded-full bg-gray-100">
            <div className="h-full w-1/2 animate-pulse rounded-full bg-wp-blue" />
          </div>
        </div>
      </div>
    );
  }

  if (failure) {
    return (
      <div
        role="alert"
        className="fixed bottom-5 right-5 z-[90] flex max-w-md items-start gap-3 rounded-xl border border-amber-200 bg-white p-4 shadow-xl"
      >
        <ExclamationTriangleIcon className="mt-0.5 h-5 w-5 flex-shrink-0 text-amber-500" />
        <div className="min-w-0">
          <p className="text-sm font-semibold text-gray-900">The update was not installed</p>
          <p className="mt-0.5 break-words text-xs leading-relaxed text-gray-600">{failure}</p>
        </div>
        <button
          type="button"
          onClick={() => setFailure(null)}
          aria-label="Dismiss"
          className="rounded-md p-1 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700"
        >
          <XMarkIcon className="h-4 w-4" />
        </button>
      </div>
    );
  }

  return null;
}
