import { useEffect, useState } from "react";
import { api, hasBackend, onSettingsChanged } from "./api";

const appName = (bundle: string | null | undefined) =>
  bundle ? bundle.split("/").pop()!.replace(/\.app$/, "") : null;

/**
 * The names of the editor and terminal chosen in App settings, so buttons can
 * say "Cursor" rather than a generic "Editor". Follows changes made while the
 * screen is open.
 */
export function usePreferredApps() {
  const [names, setNames] = useState<{ editor: string | null; terminal: string | null }>({
    editor: null,
    terminal: null,
  });
  useEffect(() => {
    if (!hasBackend) return;
    const load = () =>
      void api
        .settingsGet()
        .then((s) => setNames({ editor: appName(s.editor), terminal: appName(s.terminal) }))
        .catch(() => {});
    load();
    return onSettingsChanged(load);
  }, []);
  return names;
}
