import { Fragment, useEffect, useState } from "react";
import { Dialog, Transition } from "@headlessui/react";
import clsx from "clsx";
import { api, errorText } from "../lib/api";
import { useT } from "../lib/i18n";
import { unlessWindowDrag } from "../lib/windowDrag";
import WindowDragStrip from "./WindowDragStrip";

type Mode = "keep" | "restart" | "stop";
const MODES: Mode[] = ["keep", "restart", "stop"];

/**
 * Asked when Nexora quits with sites up and "When quitting" is "Ask every
 * time". The backend holds the quit until this answers; Cancel simply leaves
 * the app open.
 */
export default function QuitDialog() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("stop");
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void api
      .onQuitRequested(() => {
        setError(null);
        setBusy(false);
        setOpen(true);
      })
      .then((u) => (unlisten = u));
    return () => unlisten?.();
  }, []);

  const quit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.appQuit(mode, remember);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <Transition appear show={open} as={Fragment}>
      <Dialog as="div" className="relative z-[70]" onClose={busy ? () => {} : unlessWindowDrag(() => setOpen(false))}>
        <Transition.Child
          as={Fragment}
          enter="ease-out duration-150"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave="ease-in duration-100"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <div className="fixed inset-0 bg-black/40" />
        </Transition.Child>

        <div className="fixed inset-0 flex items-center justify-center p-4">
          <Transition.Child
            as={Fragment}
            enter="ease-out duration-150"
            enterFrom="opacity-0 scale-95"
            enterTo="opacity-100 scale-100"
            leave="ease-in duration-100"
            leaveFrom="opacity-100 scale-100"
            leaveTo="opacity-0 scale-95"
          >
            <Dialog.Panel className="w-full max-w-md rounded-md bg-white p-6 shadow-2xl">
              <Dialog.Title className="text-[15px] font-semibold text-gray-900">
                {t("quitTitle")}
              </Dialog.Title>
              <p className="mt-1 text-[13px] text-gray-600">{t("quitBody")}</p>

              <div role="radiogroup" className="mt-4 space-y-2">
                {MODES.map((m) => (
                  <label
                    key={m}
                    className={clsx(
                      "flex cursor-pointer items-start gap-3 rounded-sm border px-4 py-3 transition-colors",
                      mode === m ? "border-gray-900 bg-gray-50" : "border-gray-200 hover:bg-gray-50",
                    )}
                  >
                    <input
                      type="radio"
                      name="quit-mode"
                      checked={mode === m}
                      onChange={() => setMode(m)}
                      className="mt-0.5 h-4 w-4 border-gray-400 text-gray-900 focus:ring-gray-900"
                    />
                    <span>
                      <span className="block text-[13px] font-medium text-gray-900">
                        {t(`quit.${m}`)}
                      </span>
                      <span className="block text-xs leading-relaxed text-gray-500">
                        {t(`quit.${m}.desc`)}
                      </span>
                    </span>
                  </label>
                ))}
              </div>

              <label className="mt-4 flex items-center gap-2 text-[13px] text-gray-700">
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(e) => setRemember(e.target.checked)}
                  className="h-4 w-4 rounded-sm border-gray-400 text-gray-900 focus:ring-gray-900"
                />
                {t("remember")}
              </label>

              {error && <p className="mt-3 text-xs text-red-700">{error}</p>}

              <div className="mt-6 flex justify-end gap-2">
                <button
                  onClick={() => setOpen(false)}
                  disabled={busy}
                  className="h-9 rounded-sm border border-gray-300 bg-white px-4 text-[13px] font-medium text-gray-900 hover:bg-gray-50 disabled:opacity-50"
                >
                  {t("cancel")}
                </button>
                <button
                  onClick={() => void quit()}
                  disabled={busy}
                  className="h-9 rounded-sm bg-wp-blue px-4 text-[13px] font-medium text-white hover:bg-wp-blue-dark disabled:opacity-50"
                >
                  {t("quitButton")}
                </button>
              </div>
            </Dialog.Panel>
          </Transition.Child>
        </div>
        <WindowDragStrip />
      </Dialog>
    </Transition>
  );
}
