import clsx from "clsx";
import { markDragStrip } from "../lib/windowDrag";

/**
 * A transparent strip across the top of the window that moves it, for
 * overlays that cover the window's own drag areas. Pair the overlay's close
 * handler with `unlessWindowDrag`, or dragging will close it.
 */
export default function WindowDragStrip({ className }: { className?: string }) {
  return (
    <div
      data-tauri-drag-region
      aria-hidden
      onPointerDown={markDragStrip}
      className={clsx("fixed inset-x-0 top-0 h-9", className)}
    />
  );
}
