import { Fragment, useEffect, useState } from "react";
import { Dialog, Transition } from "@headlessui/react";
import {
  ArrowPathIcon,
  EyeIcon,
  EyeSlashIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import clsx from "clsx";
import { api, errorText } from "../../lib/api";
import { unlessWindowDrag } from "../../lib/windowDrag";

/** A password like the one wp-admin offers: long, mixed, no lookalikes. */
function generatePassword(length = 20): string {
  const chars = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%^&*()-_=+";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

/**
 * Adding a user to one site, as wp-admin's Users › Add New does: a username,
 * an email, a password it can make up, whether WordPress emails them, and a
 * role.
 */
export default function AddUserDialog({
  open,
  domain,
  roles,
  onClose,
  onAdded,
}: {
  open: boolean;
  domain: string;
  roles: string[];
  onClose: () => void;
  /** The list behind the dialog re-reads the site. */
  onAdded: () => Promise<void> | void;
}) {
  const [login, setLogin] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState(() => generatePassword());
  const [shown, setShown] = useState(false);
  const [notify, setNotify] = useState(true);
  const [role, setRole] = useState("subscriber");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A fresh form, and a fresh password, each time it opens.
  useEffect(() => {
    if (!open) return;
    setLogin("");
    setEmail("");
    setPassword(generatePassword());
    setShown(false);
    setNotify(true);
    setRole("subscriber");
    setError(null);
  }, [open]);

  const ready = login.trim() !== "" && email.trim() !== "" && password !== "";

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.wpCreateUser(domain, login.trim(), email.trim(), password, role, notify);
      await onAdded();
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const field =
    "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/30 disabled:opacity-60";
  const label = "mb-1.5 block text-xs font-medium text-gray-700";

  return (
    <Transition appear show={open} as={Fragment}>
      <Dialog as="div" className="relative z-[60]" onClose={busy ? () => {} : unlessWindowDrag(onClose)}>
        <Transition.Child
          as={Fragment}
          enter="ease-out duration-150"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave="ease-in duration-100"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <div className="fixed inset-0 bg-gray-900/40" />
        </Transition.Child>

        <div className="fixed inset-0 overflow-y-auto">
          <div className="flex min-h-full items-center justify-center p-4">
            <Transition.Child
              as={Fragment}
              enter="ease-out duration-150"
              enterFrom="opacity-0 scale-95"
              enterTo="opacity-100 scale-100"
              leave="ease-in duration-100"
              leaveFrom="opacity-100 scale-100"
              leaveTo="opacity-0 scale-95"
            >
              <Dialog.Panel className="w-full max-w-md overflow-hidden rounded-2xl bg-white shadow-xl">
                <div className="flex items-center gap-3 border-b border-gray-200 px-4 py-3">
                  <Dialog.Title className="text-sm font-semibold text-gray-900">
                    Add user
                  </Dialog.Title>
                  <span className="truncate text-xs text-gray-500">{domain}</span>
                  <button
                    type="button"
                    onClick={onClose}
                    aria-label="Close"
                    className="ml-auto rounded-md p-1 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700"
                  >
                    <XMarkIcon className="h-4 w-4" />
                  </button>
                </div>

                <div className="space-y-3 p-4">
                  <div>
                    <label htmlFor="new-user-login" className={label}>
                      Username
                    </label>
                    <input
                      id="new-user-login"
                      value={login}
                      onChange={(e) => setLogin(e.target.value)}
                      placeholder="editor"
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="off"
                      spellCheck={false}
                      autoFocus
                      disabled={busy}
                      className={field}
                    />
                  </div>

                  <div>
                    <label htmlFor="new-user-email" className={label}>
                      Email
                    </label>
                    <input
                      id="new-user-email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      type="email"
                      placeholder={`someone@${domain}`}
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="off"
                      spellCheck={false}
                      disabled={busy}
                      className={field}
                    />
                  </div>

                  <div>
                    <label htmlFor="new-user-password" className={label}>
                      Password
                    </label>
                    <div className="flex items-center gap-2">
                      <div className="relative min-w-0 flex-1">
                        <input
                          id="new-user-password"
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                          type={shown ? "text" : "password"}
                          autoComplete="new-password"
                          autoCorrect="off"
                          autoCapitalize="off"
                          spellCheck={false}
                          disabled={busy}
                          className={clsx(field, "pr-9 font-mono text-xs")}
                        />
                        <button
                          type="button"
                          onClick={() => setShown((v) => !v)}
                          title={shown ? "Hide password" : "Show password"}
                          aria-label={shown ? "Hide password" : "Show password"}
                          className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 transition-colors hover:text-gray-600"
                        >
                          {shown ? (
                            <EyeSlashIcon className="h-4 w-4" />
                          ) : (
                            <EyeIcon className="h-4 w-4" />
                          )}
                        </button>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setPassword(generatePassword());
                          setShown(true);
                        }}
                        disabled={busy}
                        className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-2 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50"
                      >
                        <ArrowPathIcon className="h-4 w-4" />
                        Generate
                      </button>
                    </div>
                  </div>

                  <label className="flex items-start gap-2 text-xs text-gray-700">
                    <input
                      type="checkbox"
                      checked={notify}
                      onChange={(e) => setNotify(e.target.checked)}
                      disabled={busy}
                      className="mt-0.5 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-2 focus:ring-blue-500/30"
                    />
                    <span>
                      Send user notification
                      <span className="block text-[11px] text-gray-500">
                        WordPress emails the new user about their account. Locally that lands in
                        the Mail tab.
                      </span>
                    </span>
                  </label>

                  <div>
                    <label htmlFor="new-user-role" className={label}>
                      Role
                    </label>
                    <select
                      id="new-user-role"
                      value={role}
                      onChange={(e) => setRole(e.target.value)}
                      disabled={busy}
                      className={clsx(field, "capitalize")}
                    >
                      {roles.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                  </div>

                  {error && (
                    <p role="alert" className="break-words text-xs text-red-700">
                      {error}
                    </p>
                  )}
                </div>

                <div className="flex items-center justify-end gap-2 border-t border-gray-200 px-4 py-3">
                  <button
                    type="button"
                    onClick={onClose}
                    disabled={busy}
                    className="rounded-lg px-3 py-2 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-100 hover:text-gray-900 disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => void add()}
                    disabled={!ready || busy}
                    className="rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {busy ? "Adding…" : "Add user"}
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
