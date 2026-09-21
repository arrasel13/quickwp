import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { Dialog, Transition } from "@headlessui/react";
import { FolderIcon, FolderOpenIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { open as pickFolder } from "@tauri-apps/plugin-dialog";
import clsx from "clsx";
import {
  api,
  errorText,
  hasBackend,
  notifySettingsChanged,
  onSettingsChanged,
  PhpVersion,
  QuitBehavior,
} from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { LANGUAGES, setLanguage, useT } from "../lib/i18n";
import PHPTab from "./tabs/PHPTab";
import NodeTab from "./tabs/NodeTab";
import ServicesTab from "./tabs/ServicesTab";
import ExposeTab from "./tabs/ExposeTab";
import AboutTab from "./tabs/AboutTab";
import GeneralTab from "./tabs/GeneralTab";
import MigrateTab from "./tabs/MigrateTab";

const BTN =
  "inline-flex items-center justify-center gap-2 h-10 px-4 text-[13px] font-medium rounded-sm border border-gray-900 text-gray-900 bg-white hover:bg-gray-50 disabled:opacity-40 disabled:border-gray-300 whitespace-nowrap";
const FIELD =
  "h-10 rounded-sm border border-gray-400 bg-white px-3 text-[13px] text-gray-900 focus:outline-none focus:ring-1 focus:ring-wp-blue focus:border-wp-blue disabled:opacity-50";
const SELECT = clsx(FIELD, "w-60 pr-8");

const QUIT_CHOICES: QuitBehavior[] = ["ask", "keep", "restart", "stop"];

type Section = "settings" | "services" | "storage" | "general" | "about";
const SECTIONS: { id: Section; label: string }[] = [
  { id: "settings", label: "tab.settings" },
  { id: "services", label: "nav.Services" },
  { id: "storage", label: "tab.storage" },
  { id: "general", label: "nav.General" },
  { id: "about", label: "nav.About" },
];

// The runtimes and services Nexora manages, moved here from the sidebar:
// they are set up once and revisited rarely, unlike sites.
const SERVICES = [
  { id: "php", label: "nav.PHP", component: PHPTab },
  { id: "node", label: "nav.Node", component: NodeTab },
  { id: "services", label: "nav.Services", component: ServicesTab },
  { id: "expose", label: "nav.Expose", component: ExposeTab },
] as const;

interface Props {
  open: boolean;
  onClose: () => void;
  sidebarCollapsed: boolean;
  onSidebarCollapsedChange: (collapsed: boolean) => void;
}

/** App-wide preferences, as a sheet over the whole window. */
export default function AppSettings({ open, onClose, sidebarCollapsed, onSidebarCollapsedChange }: Props) {
  const t = useT();
  const [section, setSection] = useState<Section>("settings");

  return (
    <Transition appear show={open} as={Fragment}>
      <Dialog as="div" className="relative z-50" onClose={onClose}>
        <Transition.Child
          as={Fragment}
          enter="ease-out duration-150"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave="ease-in duration-100"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <Dialog.Panel className="fixed inset-0 flex flex-col bg-[#fafafa]">
            <Dialog.Title className="sr-only">{t("appSettings")}</Dialog.Title>

            {/* The sheet covers the window's own drag strip, so it carries one. */}
            <div
              data-tauri-drag-region="deep"
              className="relative flex h-12 flex-shrink-0 items-stretch justify-center border-b border-gray-200 bg-white"
            >
              <div role="tablist" className="flex items-stretch">
                {SECTIONS.map((s) => (
                  <button
                    key={s.id}
                    role="tab"
                    aria-selected={section === s.id}
                    onClick={() => setSection(s.id)}
                    className={clsx(
                      "relative px-5 text-[13px] font-medium transition-colors",
                      section === s.id ? "text-gray-900" : "text-gray-500 hover:text-gray-900",
                    )}
                  >
                    {t(s.label)}
                    {/* An element, not a border: the global tab focus rule
                        strips borders, which would hide the marker on click. */}
                    {section === s.id && (
                      <span className="absolute inset-x-2 bottom-0 h-0.5 bg-gray-900" />
                    )}
                  </button>
                ))}
              </div>
              <button
                onClick={onClose}
                aria-label={t("closeSettings")}
                className="absolute right-3 top-1/2 -translate-y-1/2 rounded-sm p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-900"
              >
                <XMarkIcon className="h-5 w-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto">
              <div
                className={clsx(
                  "mx-auto space-y-5 px-6 py-6",
                  // Services and General are two-column pages and Storage
                  // carries the Herd importer; the rest are one column.
                  section === "services" || section === "general"
                    ? "max-w-6xl"
                    : section === "storage"
                      ? "max-w-4xl"
                      : "max-w-2xl",
                )}
              >
                {section === "about" ? (
                  <AboutTab />
                ) : section === "general" ? (
                  // The stack, HTTPS and diagnostics; it explains a missing
                  // backend itself.
                  <div className="rounded-md border border-gray-200 bg-white">
                    <GeneralTab />
                  </div>
                ) : section === "services" ? (
                  // Each screen explains a missing backend itself.
                  <ServicesSection />
                ) : !hasBackend ? (
                  <Card title={t("noBackend")}>
                    <p className="py-4 text-[13px] text-gray-600">
                      Run <code className="rounded bg-gray-100 px-1">npm run tauri dev</code>.
                    </p>
                  </Card>
                ) : section === "settings" ? (
                  <SettingsSection
                    sidebarCollapsed={sidebarCollapsed}
                    onSidebarCollapsedChange={onSidebarCollapsedChange}
                  />
                ) : (
                  <>
                    <StorageSection />
                    {/* Bringing sites in from Herd is about where things
                        live too: it copies their folders and databases here. */}
                    <div className="rounded-md border border-gray-200 bg-white">
                      <MigrateTab />
                    </div>
                  </>
                )}
              </div>
            </div>
          </Dialog.Panel>
        </Transition.Child>
      </Dialog>
    </Transition>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-md border border-gray-200 bg-gray-50 px-6 pt-5 pb-1">
      <h2 className="text-[15px] font-semibold text-gray-900">{title}</h2>
      <div className="mt-2 divide-y divide-gray-200">{children}</div>
    </section>
  );
}

/** A setting: label and hint on the left, the control on the right -- or,
 *  `stacked`, the control on a line of its own for values that need width. */
function Row({
  label,
  hint,
  stacked,
  children,
}: {
  label: string;
  hint?: ReactNode;
  stacked?: boolean;
  children: ReactNode;
}) {
  const text = (
    <div className="min-w-0">
      <div className="text-[13px] text-gray-900">{label}</div>
      {hint && <p className="mt-0.5 text-xs leading-relaxed text-gray-500">{hint}</p>}
    </div>
  );
  if (stacked) {
    return (
      <div className="py-4">
        {text}
        <div className="mt-3">{children}</div>
      </div>
    );
  }
  return (
    <div className="flex items-center justify-between gap-6 py-4">
      {text}
      <div className="flex flex-shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

function ServicesSection() {
  const t = useT();
  const [active, setActive] = useState<(typeof SERVICES)[number]["id"]>("php");
  const Active = SERVICES.find((s) => s.id === active)!.component;

  return (
    <div>
      <div className="flex justify-center">
        <div
          role="tablist"
          aria-label={t("nav.Services")}
          className="inline-flex rounded-sm border border-gray-300 bg-white p-0.5"
        >
          {SERVICES.map((s) => (
            <button
              key={s.id}
              role="tab"
              aria-selected={active === s.id}
              onClick={() => setActive(s.id)}
              className={clsx(
                "h-8 px-5 text-[13px] font-medium rounded-sm transition-colors",
                active === s.id ? "bg-gray-900 text-white" : "text-gray-600 hover:text-gray-900",
              )}
            >
              {t(s.label)}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-5 rounded-md border border-gray-200 bg-white">
        <Active key={active} />
      </div>
    </div>
  );
}

/** Every setting on this screen, as the controls hold it before saving. */
type Draft = {
  language: string;
  editor: string;
  browser: string;
  terminal: string;
  sites_dir: string;
  tld: string;
  default_php: string;
  quit_behavior: string;
  sidebar: boolean;
};

function SettingsSection({
  sidebarCollapsed,
  onSidebarCollapsedChange,
}: Pick<Props, "sidebarCollapsed" | "onSidebarCollapsedChange">) {
  const t = useT();
  const { data: settings, reload } = useAsync(() => api.settingsGet(), []);
  const { data: php } = useAsync(() => api.phpList(), []);
  const { data: systemPhp } = useAsync(() => api.phpSystemList(), []);
  const { data: apps } = useAsync(() => api.appsInstalled(), []);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  /** What is on the site now, as the controls show it. */
  const saved: Draft | null = settings
    ? {
        language: settings.language,
        editor: settings.editor ?? "",
        browser: settings.browser ?? "",
        terminal: settings.terminal ?? "",
        sites_dir: settings.sites_dir,
        tld: settings.tld,
        default_php: settings.default_php ?? "",
        quit_behavior: settings.quit_behavior ?? "ask",
        sidebar: sidebarCollapsed,
      }
    : null;

  // Nothing is written until Save, so a change can always be taken back.
  const [draft, setDraft] = useState<Draft | null>(null);
  const edited = useRef(false);
  useEffect(() => {
    if (saved && !edited.current) setDraft(saved);
  }, [settings, sidebarCollapsed]);

  const current = draft ?? saved;
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    edited.current = true;
    setNotice(null);
    setDraft((d) => (d ? { ...d, [key]: value } : d));
  };

  const changed: (keyof Draft)[] =
    saved && current
      ? (Object.keys(saved) as (keyof Draft)[]).filter((k) => saved[k] !== current[k])
      : [];
  const dirty = changed.length > 0;

  const discard = () => {
    edited.current = false;
    setDraft(saved);
    setNotice(null);
  };

  const saveAll = async () => {
    if (!saved || !current) return;
    setBusy(true);
    setNotice(null);
    try {
      for (const key of changed) {
        switch (key) {
          case "sidebar":
            onSidebarCollapsedChange(current.sidebar);
            break;
          case "default_php":
            await api.phpSetDefault(current.default_php);
            break;
          case "tld":
            await api.settingsSet("tld", current.tld.trim().replace(/^\./, ""));
            break;
          case "language":
            await api.settingsSet("language", current.language);
            setLanguage(current.language);
            break;
          default:
            await api.settingsSet(key, current[key] as string);
        }
      }
      edited.current = false;
      await reload();
      // Every screen showing a preferred app or the sites folder re-reads.
      notifySettingsChanged();
      setNotice({ ok: true, text: t("saved", { count: String(changed.length) }) });
    } catch (e) {
      // Whatever was written stays written: read it all back rather than
      // leaving the form claiming otherwise.
      edited.current = false;
      await reload();
      setNotice({ ok: false, text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  const chooseSitesDir = async () => {
    const picked = await pickFolder({
      directory: true,
      defaultPath: current?.sites_dir,
      title: t("chooseFolder"),
    });
    if (typeof picked === "string") set("sites_dir", picked);
  };

  const installed = (php ?? []).filter((p: PhpVersion) => p.installed);
  const terminal = apps?.terminals.find((a) => a.path === current?.terminal);
  const disabled = busy || !settings;

  return (
    <Card title={t("general")}>
      <Row label={t("language")} hint={t("languageHint")}>
        <select
          aria-label={t("language")}
          value={current?.language ?? "en"}
          onChange={(e) => set("language", e.target.value)}
          disabled={disabled}
          className={SELECT}
        >
          {LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.name}
            </option>
          ))}
        </select>
      </Row>

      <Row label={t("sidebar")}>
        <div className="inline-flex rounded-sm border border-gray-300 bg-white p-0.5">
          {[
            { label: t("expanded"), value: false },
            { label: t("collapsed"), value: true },
          ].map((o) => (
            <button
              key={String(o.value)}
              onClick={() => set("sidebar", o.value)}
              aria-pressed={current?.sidebar === o.value}
              className={clsx(
                "h-8 px-4 text-[13px] rounded-sm transition-colors",
                current?.sidebar === o.value
                  ? "ring-1 ring-gray-900 text-gray-900"
                  : "text-gray-500 hover:text-gray-900",
              )}
            >
              {o.label}
            </button>
          ))}
        </div>
      </Row>

      <Row label={t("editor")} hint={t("editorHint")}>
        <select
          aria-label={t("editor")}
          value={current?.editor ?? ""}
          onChange={(e) => set("editor", e.target.value)}
          disabled={disabled || !apps?.editors.length}
          className={SELECT}
        >
          {!apps?.editors.length && <option value="">{t("noEditors")}</option>}
          {apps?.editors.map((a) => (
            <option key={a.path} value={a.path}>
              {a.name}
            </option>
          ))}
        </select>
      </Row>

      <Row label={t("browser")} hint={t("browserHint")}>
        <select
          aria-label={t("browser")}
          value={current?.browser ?? ""}
          onChange={(e) => set("browser", e.target.value)}
          disabled={disabled || !apps?.browsers.length}
          className={SELECT}
        >
          {!apps?.browsers.length && <option value="">{t("noBrowsers")}</option>}
          {apps?.browsers.map((a) => (
            <option key={a.path} value={a.path}>
              {a.default ? t("appDefault", { name: a.name }) : a.name}
            </option>
          ))}
        </select>
      </Row>

      <Row
        label={t("terminal")}
        hint={
          terminal && !terminal.commands
            ? t("terminalFolderOnly", { name: terminal.name })
            : t("terminalHint")
        }
      >
        <select
          aria-label={t("terminal")}
          value={current?.terminal ?? ""}
          onChange={(e) => set("terminal", e.target.value)}
          disabled={disabled || !apps}
          className={SELECT}
        >
          {apps?.terminals.map((a) => (
            <option key={a.path} value={a.path}>
              {a.default ? t("appDefault", { name: a.name }) : a.name}
            </option>
          ))}
        </select>
      </Row>

      {/* Stacked, full width, never truncated: a folder you cannot read in
          full is a folder you cannot be sure of. The value only ever comes
          from the picker, so the whole field is the button. */}
      <Row label={t("sitesDir")} hint={t("sitesDirHint")} stacked>
        <button
          type="button"
          onClick={() => void chooseSitesDir()}
          disabled={disabled}
          aria-label={t("sitesDir")}
          className="flex w-full items-center gap-3 rounded-sm border border-gray-400 bg-white px-3 py-2.5 text-left transition-colors hover:border-gray-900 focus:outline-none focus:ring-1 focus:ring-wp-blue focus:border-wp-blue disabled:opacity-50"
        >
          <FolderIcon className="h-4 w-4 flex-shrink-0 text-gray-500" />
          <span className="min-w-0 flex-1 break-all font-mono text-[13px] leading-5 text-gray-900">
            {current?.sites_dir ?? ""}
          </span>
          <span className="flex-shrink-0 text-[13px] font-medium text-wp-blue">{t("change")}</span>
        </button>
      </Row>

      <Row label={t("tld")} hint={t("tldHint", { example: `name.${current?.tld || "test"}` })}>
        <div className="relative">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[13px] text-gray-400">
            .
          </span>
          <input
            type="text"
            aria-label={t("tld")}
            value={current?.tld ?? ""}
            onChange={(e) => set("tld", e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") set("tld", settings?.tld ?? "");
            }}
            disabled={disabled}
            className={clsx(FIELD, "w-60 pl-5 font-mono text-xs")}
          />
        </div>
      </Row>

      <Row label={t("php")} hint={t("phpHint")}>
        <select
          aria-label={t("php")}
          value={installed.length ? current?.default_php ?? "" : ""}
          onChange={(e) => set("default_php", e.target.value)}
          disabled={disabled}
          className={SELECT}
        >
          <optgroup label={t("phpNexora")}>
            {installed.length === 0 && (
              <option value="" disabled>
                {t("phpNone")}
              </option>
            )}
            {installed.map((p) => (
              <option key={p.minor} value={p.minor}>
                PHP {p.minor} ({p.patch})
              </option>
            ))}
          </optgroup>
          {(systemPhp?.length ?? 0) > 0 && (
            <optgroup label={t("phpElsewhere")}>
              {systemPhp!.map((p) => (
                <option key={p.path} value={`system:${p.path}`} disabled title={p.path}>
                  PHP {p.version} — {p.source}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </Row>

      <Row label={t("quit")} hint={t("quitHint")}>
        <select
          aria-label={t("quit")}
          value={current?.quit_behavior ?? "ask"}
          onChange={(e) => set("quit_behavior", e.target.value)}
          disabled={disabled}
          className={SELECT}
        >
          {QUIT_CHOICES.map((q) => (
            <option key={q} value={q}>
              {t(`quit.${q}`)}
            </option>
          ))}
        </select>
      </Row>

      <div className="flex flex-wrap items-center justify-between gap-3 py-4">
        <p
          role="status"
          className={clsx(
            "min-w-0 text-xs leading-relaxed",
            notice ? (notice.ok ? "text-gray-600" : "text-red-700") : "text-gray-500",
          )}
        >
          {notice?.text ?? (dirty ? t("unsaved", { count: String(changed.length) }) : "")}
        </p>

        <div className="flex flex-shrink-0 items-center gap-2">
          {dirty && (
            <button type="button" onClick={discard} disabled={busy} className={BTN}>
              {t("discard")}
            </button>
          )}
          <button
            type="button"
            onClick={() => void saveAll()}
            disabled={!dirty || busy}
            className="rounded-sm bg-wp-blue px-4 py-2 text-[13px] font-medium text-white transition-colors hover:bg-wp-blue/90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? t("saving") : t("saveChanges")}
          </button>
        </div>
      </div>
    </Card>
  );
}

function StorageSection() {
  const t = useT();
  const { data: settings, reload } = useAsync(() => api.settingsGet(), []);
  const [error, setError] = useState<string | null>(null);

  // The sites folder is set on the other tab; this one shows it.
  useEffect(() => onSettingsChanged(() => void reload()), [reload]);

  const rows: [string, string | undefined, string][] = [
    [t("storage.sites"), settings?.sites_dir, t("storage.sitesHint")],
    [t("storage.data"), settings?.root, t("storage.dataHint")],
    [t("storage.logs"), settings?.logs_dir, t("storage.logsHint")],
  ];

  return (
    <Card title={t("storageTitle")}>
      {rows.map(([label, path, hint]) => (
        <Row
          key={label}
          label={label}
          hint={
            <>
              {hint}
              <span className="mt-1 block break-all font-mono text-[11px] text-gray-700">{path ?? "—"}</span>
            </>
          }
        >
          <button
            onClick={() => path && void api.pathOpen(path).catch((e) => setError(errorText(e)))}
            disabled={!path}
            className={BTN}
          >
            <FolderOpenIcon className="h-4 w-4" />
            {t("showInFinder")}
          </button>
        </Row>
      ))}
      {error && <p className="py-3 text-xs text-red-700">{error}</p>}
    </Card>
  );
}
