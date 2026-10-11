import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import "./lib/i18n";
import "./styles.css";

const container = document.getElementById("root");

if (container === null) {
  throw new Error("#root tidak ditemukan di index.html");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
