import { labelDownloads } from "./downloads.ts";
import "./plain.ts";

// Whop's checkout returns here with ?status=success (ADR-093): say so, then tidy the address bar.
const q = new URLSearchParams(location.search);
if (q.get("status") === "success" || q.get("checkout_status") === "success") {
  const n = document.querySelector("[data-paid]") as HTMLElement | null;
  if (n) n.hidden = false;
  history.replaceState(null, "", location.pathname);
}

void labelDownloads();
