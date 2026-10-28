import { rowHash } from "../../src/journal/Journal.ts";

/**
 * Exhibit: the journal hash chain (constitution U7). Synthetic rows, real hash function: every row is
 * sha256(prev | seq | ts | kind | payload) exactly as src/journal/Journal.ts computes it. The visitor may edit row 3;
 * re-walking the chain from the recomputed hashes shows every row from the edit onward failing verification.
 */
interface Row {
  seq: number;
  ts: number;
  kind: string;
  payload: string;
  stored: string;
}

const T0 = Date.UTC(2026, 9, 24, 15, 53, 4);
const SEED = [
  ["COURT", '{"symbol":"SOL/USD","win_cal":0.554,"bear":0.31}'],
  ["CONTRACT", '{"origin":"COURT","conviction":6,"stop":176.9}'],
  ["FILL", '{"side":"buy","qty":"0.0634","price":182.71}'],
  ["STOP_BROKER", '{"stop":176.9,"type":"stop_limit"}'],
  ["STOP_MOVE", '{"from":176.9,"to":182.71,"why":"breakeven at +1R"}'],
] as const;
const EDITABLE = 2;

export function mountChain(root: HTMLElement): void {
  const list = root.querySelector<HTMLOListElement>(".chain-rows");
  const reset = root.querySelector<HTMLButtonElement>("[data-chain-reset]");
  if (!list) return;

  const genesisPrev = rowHash("0".repeat(64), 1040, T0 - 60_000, "DAY_ROLL", "{}");
  const rows: Row[] = [];
  let prev = genesisPrev;
  SEED.forEach(([kind, payload], i) => {
    const seq = 1041 + i;
    const ts = T0 + i * 47_000;
    const stored = rowHash(prev, seq, ts, kind, payload);
    rows.push({ seq, ts, kind, payload, stored });
    prev = stored;
  });

  const els = rows.map((r, i) => {
    const li = document.createElement("li");
    li.className = "crow";
    const seq = el("span", "crow-seq", String(r.seq));
    const kind = el("span", "crow-kind", r.kind);
    const payload = el("div", "crow-payload");
    if (i === EDITABLE) {
      const input = document.createElement("input");
      input.type = "text";
      input.value = r.payload;
      input.spellcheck = false;
      input.autocomplete = "off";
      input.setAttribute("aria-label", `Payload of journal row ${r.seq} (editable)`);
      input.addEventListener("input", () => {
        r.payload = input.value;
        verify();
      });
      payload.append(input);
    } else {
      payload.append(el("span", "", r.payload));
    }
    const hash = el("div", "crow-hash");
    const h = el("b", "", "");
    const ok = el("span", "crow-ok", "");
    hash.append(h, ok);
    li.append(seq, kind, payload, hash);
    list.append(li);
    return { li, h, ok };
  });

  const original = rows[EDITABLE]?.payload ?? "";

  function verify() {
    let p = genesisPrev;
    let brokenAt: number | null = null;
    rows.forEach((r, i) => {
      const recomputed = rowHash(p, r.seq, r.ts, r.kind, r.payload);
      const good = recomputed === r.stored && brokenAt === null;
      if (!good && brokenAt === null) brokenAt = r.seq;
      const e = els[i];
      if (e) {
        e.h.textContent = `sha256 ${recomputed.slice(0, 24)}…`;
        e.ok.textContent = good ? "✓ verified" : "✗ broken";
        e.li.classList.toggle("is-broken", !good);
      }
      p = recomputed;
    });
    root.dataset.broken = brokenAt === null ? "" : String(brokenAt);
  }

  reset?.addEventListener("click", () => {
    const r = rows[EDITABLE];
    if (!r) return;
    r.payload = original;
    const input = list.querySelector<HTMLInputElement>("input");
    if (input) input.value = original;
    verify();
  });

  verify();
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
