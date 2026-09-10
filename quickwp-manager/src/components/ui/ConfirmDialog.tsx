import { Fragment } from "react";
import { Dialog, Transition } from "@headlessui/react";
import { ExclamationTriangleIcon } from "@heroicons/react/24/outline";

/**
 * An in-app confirmation.
 *
 * `window.confirm` is not reliable inside the webview -- it can return without
 * ever blocking, which turns "are you sure?" into a delete that just happens.
 * This is a real dialog: nothing runs until a button is pressed.
 */
export default function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel = "Delete",
  destructive = true,
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body: React.ReactNode;
  confirmLabel?: string;
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Transition appear show={open} as={Fragment}>
      <Dialog
        as="div"
        className="relative z-[60]"
        onClose={busy ? () => {} : onCancel}
      >
        <Transition.Child
          as={Fragment}
          enter="ease-out duration-200"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave="ease-in duration-150"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <div className="fixed inset-0 bg-gray-900/40" />
        </Transition.Child>

        <div className="fixed inset-0 overflow-y-auto">
          <div className="flex min-h-full items-center justify-center p-4">
            <Transition.Child
              as={Fragment}
              enter="ease-out duration-200"
              enterFrom="opacity-0 scale-95"
              enterTo="opacity-100 scale-100"
              leave="ease-in duration-150"
              leaveFrom="opacity-100 scale-100"
              leaveTo="opacity-0 scale-95"
            >
              <Dialog.Panel className="w-full max-w-md overflow-hidden rounded-2xl bg-white p-5 shadow-2xl">
                <div className="flex gap-3">
                  {destructive && (
                    <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-red-100">
                      <ExclamationTriangleIcon className="h-5 w-5 text-red-600" />
                    </div>
                  )}
                  <div className="min-w-0">
                    <Dialog.Title
                      as="h3"
                      className="text-sm font-semibold text-gray-900"
                    >
                      {title}
                    </Dialog.Title>
                    <div className="mt-1 text-xs leading-relaxed text-gray-600">
                      {body}
                    </div>
                  </div>
                </div>

                <div className="mt-5 flex justify-end gap-2">
                  <button
                    onClick={onCancel}
                    disabled={busy}
                    className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={onConfirm}
                    disabled={busy}
                    className={
                      destructive
                        ? "rounded-lg bg-red-600 px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-red-700 disabled:opacity-50"
                        : "rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
                    }
                  >
                    {busy ? "Working…" : confirmLabel}
                  </button>
                </div>
              </Dialog.Panel>
            </Transition.Child>
          </div>
        </div>
      </Dialog>
    </Transition>
  );
}
