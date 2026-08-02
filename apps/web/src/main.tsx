import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import App from "./App";
import "./main.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider delayDuration={300} skipDelayDuration={300}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </TooltipProvider>
  </StrictMode>,
);
