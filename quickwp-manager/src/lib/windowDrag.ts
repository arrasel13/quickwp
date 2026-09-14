// The window has no title bar, so it moves by dragging the parts of the page
// marked `data-tauri-drag-region`. Over a dialog that raises a problem: the
// press that starts a window drag lands outside the dialog panel, and the
// dialog reads that as a click outside and closes -- taking a half-filled
// form with it. Strips over dialogs mark the press, and dialog close handlers
// ignore a close that began on one.

let pressStartedOnDragStrip = false;

if (typeof window !== "undefined") {
  // Capture on window runs before anything else sees the press, so every new
  // press starts unmarked; a strip then marks its own.
  window.addEventListener("pointerdown", () => {
    pressStartedOnDragStrip = false;
  }, true);
}

export function markDragStrip() {
  pressStartedOnDragStrip = true;
}

/** A dialog's onClose that stays open when the "outside click" was a window drag. */
export function unlessWindowDrag(close: () => void) {
  return () => {
    if (!pressStartedOnDragStrip) close();
  };
}
