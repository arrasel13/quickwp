import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import {
  CheckIcon,
  CodeBracketIcon,
  CommandLineIcon,
  FolderIcon,
  GlobeAltIcon,
} from "@heroicons/react/24/outline";
import clsx from "clsx";
import { api } from "../../lib/api";
import type { OverlayIcon, OverlayMenu } from "../../lib/overlay";
import CertDetails from "../site/CertDetails";
import "../../App.css";

const ICONS: Record<OverlayIcon, React.ComponentType<{ className?: string }>> = {
  browser: GlobeAltIcon,
  finder: FolderIcon,
  editor: CodeBracketIcon,
  terminal: CommandLineIcon,
};

/**
 * The overlay webview's whole page: nothing but the open menu, over a
 * see-through window. See src/lib/overlay.ts.
 */
export default function OverlayRoot() {
  const [menu, setMenu] = useState<OverlayMenu | null>(null);

  useEffect(() => {
    // A menu asked for before this page had loaded.
    void api
      .overlayCurrent()
      .then((m) => m && setMenu(m as OverlayMenu))
      .catch(() => {});
    const off = listen<OverlayMenu | null>("overlay-menu", (e) => setMenu(e.payload));
    return () => void off.then((f) => f());
  }, []);

  const close = (choice: string | null) => {
    if (!menu) return;
    const id = menu.id;
    setMenu(null);
    void emit("overlay-result", { id, choice });
    void api.overlayHide().catch(() => {});
  };

  // Escape, switching away from the app, or resizing the window closes it,
  // the way a menu does.
  useEffect(() => {
    if (!menu) return;
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") close(null);
    };
    const away = () => close(null);
    window.addEventListener("keydown", escape);
    window.addEventListener("blur", away);
    window.addEventListener("resize", away);
    return () => {
      window.removeEventListener("keydown", escape);
      window.removeEventListener("blur", away);
      window.removeEventListener("resize", away);
    };
  }, [menu]);

  return (
    <div
      className="fixed inset-0"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close(null);
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {menu && <Panel key={menu.id} menu={menu} onChoose={close} />}
    </div>
  );
}

function Panel({ menu, onChoose }: { menu: OverlayMenu; onChoose: (id: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const checkable = menu.items.some((i) => i.kind === "item" && i.checked !== undefined);
  /** A card rather than a list: it lays out its own padding and width. */
  const card = menu.items.some((i) => i.kind === "cert");

  // Beside its button, kept inside the window: above it when there is no room
  // below. Measured before paint, so it never shows in the wrong place.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const { anchor } = menu;
    let left = menu.align === "end" ? anchor.right - width : anchor.left;
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
    let top = anchor.bottom + 6;
    if (top + height > window.innerHeight - 8) top = Math.max(8, anchor.top - height - 6);
    setPos({ left, top });
  }, [menu]);

  // The keyboard goes to the menu itself, with no item picked out: a menu
  // opened by a click shows nothing highlighted until it is pointed at or an
  // arrow is pressed. Once placed -- until then it is hidden, and a hidden
  // element cannot take focus.
  useEffect(() => {
    if (pos) ref.current?.focus();
  }, [pos !== null]);

  const moveFocus = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = Array.from(
      ref.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)') ?? [],
    );
    if (!items.length) return;
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      at === -1
        ? e.key === "ArrowDown"
          ? 0
          : items.length - 1
        : (at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next].focus();
  };

  return (
    <div
      ref={ref}
      role="menu"
      tabIndex={-1}
      onKeyDown={moveFocus}
      style={pos ?? { left: 0, top: 0, visibility: "hidden" }}
      className={clsx(
        "fixed bg-white text-gray-900 shadow-xl shadow-black/10 outline-none ring-1 ring-black/10",
        card ? "rounded-xl" : "min-w-[200px] rounded-lg p-1",
      )}
    >
      {menu.items.map((item, i) => {
        if (item.kind === "cert") {
          return <CertDetails key={i} domain={item.domain} active={item.active} />;
        }
        if (item.kind === "separator") {
          return <div key={i} role="separator" className="mx-1 my-1 h-px bg-gray-200" />;
        }
        if (item.kind === "heading") {
          return (
            <p key={i} className="px-2.5 pb-1 pt-1.5 text-[11px] font-medium text-gray-500">
              {item.label}
            </p>
          );
        }
        const Icon = item.icon ? ICONS[item.icon] : null;
        return (
          <button
            key={item.id}
            type="button"
            role={item.checked !== undefined ? "menuitemcheckbox" : "menuitem"}
            aria-checked={item.checked}
            disabled={item.disabled}
            onClick={() => onChoose(item.id)}
            className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[13px] text-gray-800 outline-none transition-colors hover:bg-gray-100 focus:bg-gray-100 disabled:opacity-40 disabled:hover:bg-transparent"
          >
            {checkable && (
              <span className="grid h-4 w-4 flex-shrink-0 place-items-center">
                {item.checked && <CheckIcon className="h-3.5 w-3.5" strokeWidth={2.5} />}
              </span>
            )}
            {Icon && <Icon className={clsx("h-4 w-4 flex-shrink-0 text-gray-500")} />}
            <span className="whitespace-nowrap">{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}
