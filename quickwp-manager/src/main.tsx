import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import OverlayRoot from "./components/overlay/OverlayRoot";

// The same page, loaded a second time as the see-through layer the preview's
// menus open in (src-tauri/src/overlay.rs). It draws only the menu.
const isOverlay = new URLSearchParams(window.location.search).has("overlay");
if (isOverlay) document.documentElement.classList.add("overlay");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{isOverlay ? <OverlayRoot /> : <App />}</React.StrictMode>,
);
