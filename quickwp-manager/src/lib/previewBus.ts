// A shortcut in the details asking the preview beside it to show a page of
// wp-admin. One listener, because there is one preview.

interface Request {
  domain: string;
  /** A page of wp-admin: "edit.php", "site-editor.php?path=%2Fpatterns". */
  path: string;
}

let listener: ((r: Request) => void) | null = null;

/**
 * Show a page of wp-admin in the preview. The site is started first if it is
 * not running, and the preview is already logged in, so the page is there
 * rather than loading from cold.
 */
export function openInPreview(domain: string, path: string) {
  listener?.({ domain, path });
}

export function onPreviewRequest(cb: (r: Request) => void) {
  listener = cb;
  return () => {
    if (listener === cb) listener = null;
  };
}
