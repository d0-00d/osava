import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

// The UI's fonts ship inside the app. They used to be fetched from Google Fonts on
// every launch, which sent the user's IP address to a third party from a product
// that promises nothing leaves the machine, and fell back to a system font offline.
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-500.css";
import "@fontsource/jetbrains-mono/latin-700.css";
import "@fontsource/ibm-plex-mono/latin-500.css";
import "@fontsource/ibm-plex-mono/latin-600.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
