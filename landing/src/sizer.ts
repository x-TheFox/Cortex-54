import { DOCTRINE } from "../../src/generated/config.ts";
import { sizePosition } from "../../src/risk/PositionSizer.ts";
import { rungForEquity } from "../../src/risk/rungs.ts";

/**
 * Exhibit: the shipped position sizer (constitution U2), compiled into the page. The default state is the worked
 * example in docs/RISK_DOCTRINE.md §1: $54, R1, crypto, conviction 7, p 0.66, D_bear 0.1, stop 4%, fees 0.40%,
 * half-spread 0.05% → $12.23 notional, ≈ $0.54 at risk. The account-size switch shows the same rules at any size: the
 * rung (and so every limit) comes from rungForEquity(), exactly as the brain picks it.
 */
type Band = "GREEN" | "YELLOW" | "ORANGE";
type Arena = "CRYPTO" | "EQUITIES";

const ENTRY = 100;
const SPREAD = 0.001;
const FEE_RT: Record<Arena, number> = {
  CRYPTO: DOCTRINE.fees.crypto_maker + DOCTRINE.fees.crypto_taker,
  EQUITIES: DOCTRINE.fees.equity_commission * 2,
};

const fmt = (x: number) =>
  x >= 10_000
    ? `$${Math.round(x).toLocaleString("en-US")}`
    : `$${x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (x: number) => `${(x * 100).toFixed(2)}%`;

export function mountSizer(form: HTMLFormElement): void {
  const q = (sel: string) => form.querySelector<HTMLElement>(sel);
  const num = (name: string) => Number((form.elements.namedItem(name) as HTMLInputElement).value);
  const radio = (name: string) =>
    form.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)?.value;
  const setOut = (k: string, v: string) => setText(q(`[data-out="${k}"]`), v);
  const setRes = (k: string, v: string) => setText(q(`[data-res="${k}"]`), v);

  const paintFill = (input: HTMLInputElement) => {
    const min = Number(input.min);
    const max = Number(input.max);
    input.style.setProperty("--fill", `${((Number(input.value) - min) / (max - min)) * 100}%`);
  };

  const update = () => {
    const equity = Number(radio("equity") ?? DOCTRINE.accounts.PAPER.starting_equity_usd);
    const arena = (radio("arena") ?? "CRYPTO") as Arena;
    const band = (radio("band") ?? "GREEN") as Band;
    const conviction = num("conviction");
    const pWin = num("pWin");
    const bear = num("bear");
    const stopPct = num("stop") / 100;
    const rungName = rungForEquity(equity, DOCTRINE);
    const rung = DOCTRINE.rungs[rungName];
    const feeRt = FEE_RT[arena];

    setOut("conviction", String(conviction));
    setOut("pWin", pWin.toFixed(2));
    setOut("bear", bear.toFixed(2));
    setOut("stop", `${(stopPct * 100).toFixed(1)}%`);
    setOut("rung", `rung ${rungName}`);
    setRes("cap", fmt(equity * rung.max_position_notional));
    setRes("maxpos", String(rung.max_positions));
    setRes(
      "fees",
      arena === "CRYPTO"
        ? `Crypto fees ${pct(feeRt)} round trip`
        : "Stocks: $0 commission (regulatory sell fees aside)",
    );

    const stop = ENTRY * (1 - stopPct);
    const r = sizePosition(
      {
        equityUsd: equity,
        rung,
        conviction,
        pWin,
        bearLethality: bear,
        reputationWeight: 1,
        breakerMultiplier: DOCTRINE.breakers.multipliers[band],
        entry: ENTRY,
        stop,
        atr: (ENTRY - stop) / 1.5,
        feeRt,
        spreadFrac: SPREAD,
        availableCashUsd: equity,
        heatRoomUsd: equity * rung.total_heat,
        minNotionalUsd: DOCTRINE.execution.min_order_notional_usd[arena],
        minQty: 0,
        qtyIncrement: 1e-9,
      },
      DOCTRINE,
    );

    const big = q('[data-res="notional"]');
    const reason = q('[data-res="reason"]');
    const show = (v: string) => {
      if (!big) return;
      big.textContent = v;
      big.style.setProperty("--len", String(v.length));
    };
    if (r.ok) {
      big?.classList.remove("is-zero");
      show(fmt(r.notionalUsd));
      setRes("risk", fmt(r.riskUsd));
      setRes("binding", r.binding === "venue_min" ? "venue minimum" : r.binding);
      setRes("reff", pct(r.rEff));
      setRes("dstop", pct(r.dStop));
      if (reason) {
        reason.hidden = r.binding !== "venue_min";
        reason.textContent = `Below the broker's ${fmt(DOCTRINE.execution.min_order_notional_usd[arena])} minimum order, so it is lifted to it — only because the lifted risk still fits inside the cap.`;
      }
    } else {
      big?.classList.add("is-zero");
      show("$0.00");
      setRes("risk", "$0.00");
      setRes("binding", "no trade");
      setRes("reff", "—");
      setRes("dstop", pct(stopPct + feeRt + SPREAD / 2));
      if (reason) {
        reason.hidden = false;
        reason.textContent = `No trade: ${r.reasons.join("; ")}.`;
      }
    }
  };

  for (const input of form.querySelectorAll<HTMLInputElement>('input[type="range"]')) {
    paintFill(input);
    input.addEventListener("input", () => {
      paintFill(input);
      update();
    });
  }
  form.addEventListener("change", update);
  form.addEventListener("submit", (e) => e.preventDefault());
  update();
}

function setText(el: HTMLElement | null, v: string) {
  if (el) el.textContent = v;
}
