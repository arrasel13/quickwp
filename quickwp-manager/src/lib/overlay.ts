// Menus drawn in the overlay: a see-through webview of the app raised over the
// whole window, so a menu can open over the site preview -- a native view that
// covers anything the page draws -- and still look and sit inside the app.
// See src-tauri/src/overlay.rs.

import { listen } from "@tauri-apps/api/event";
import { api, hasBackend } from "./api";

export type OverlayIcon = "browser" | "finder" | "editor" | "terminal";

export type OverlayItem =
  | { kind: "heading"; label: string }
  | { kind: "separator" }
  /** A site's SSL state and certificate, with its own controls. */
  | { kind: "cert"; domain: string; active: boolean }
  | {
      kind: "item";
      id: string;
      label: string;
      icon?: OverlayIcon;
      /** A check mark beside it: true ticked, false unticked but aligned. */
      checked?: boolean;
      disabled?: boolean;
    };

export interface OverlayMenu {
  id: string;
  /** The button it opens from, in window coordinates. */
  anchor: { left: number; right: number; top: number; bottom: number };
  /** Which of the button's edges the menu lines up with. */
  align: "start" | "end";
  items: OverlayItem[];
}

export const menuAnchor = (el: Element) => {
  const r = el.getBoundingClientRect();
  return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
};

let prepared = false;

/** Load the overlay ahead of the first menu, so it opens at once. */
export function prepareOverlay() {
  if (!hasBackend || prepared) return;
  prepared = true;
  void api.overlayPrepare().catch(() => {
    prepared = false;
  });
}

let settleOpen: ((choice: string | null) => void) | null = null;

/**
 * Open a menu and wait for the choice: an item's id, or null when it was
 * dismissed. Opening one closes any menu still waiting.
 */
export function openOverlayMenu(menu: Omit<OverlayMenu, "id">): Promise<string | null> {
  if (!hasBackend) return Promise.resolve(null);
  settleOpen?.(null);
  const full: OverlayMenu = { ...menu, id: `${Date.now()}-${Math.random().toString(36).slice(2)}` };

  return new Promise((resolve) => {
    let unlisten: (() => void) | null = null;
    let done = false;
    const finish = (choice: string | null) => {
      if (done) return;
      done = true;
      unlisten?.();
      if (settleOpen === finish) settleOpen = null;
      resolve(choice);
    };
    settleOpen = finish;

    void listen<{ id: string; choice: string | null }>("overlay-result", (e) => {
      if (e.payload.id === full.id) finish(e.payload.choice);
    }).then((off) => {
      if (done) off();
      else unlisten = off;
    });

    api.overlayShow(full, window.innerWidth, window.innerHeight).catch(() => finish(null));
  });
}
