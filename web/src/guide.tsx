import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * In-panel walkthrough (operator request, 2026-10-23): a spotlight tour of the real cockpit in plain English for
 * someone who knows nothing about trading. Opened from the GUIDE key or the "?" key at any time.
 * Steps point at `data-guide` attributes; a step may first switch the lower display to a page.
 */

export type GuidePage = "ACCT" | "FUNNEL" | "MEM" | "OPT" | "GOV" | "STS" | "FCST";

interface Step {
  target?: string; // data-guide value; none = centred card
  page?: GuidePage;
  title: string;
  body: string[];
  terms?: [string, string][];
}

const STEPS: Step[] = [
  {
    title: "Welcome to the cockpit",
    body: [
      "CORTEX-54 is a robot that buys and sells on its own, starting with $54. Right now it uses a practice account (“paper trading”): the money is pretend, the prices are real.",
      "This screen is built like an airliner cockpit. When everything is fine, almost nothing lights up. Light means “look here”.",
      "You never have to approve its trades. Your job is to glance, understand, and usually leave it alone.",
    ],
  },
  {
    target: "annunciators",
    title: "The two master lights",
    body: [
      "These are the first thing to check. Dark means all is well.",
      "Amber MASTER CAUT means something needs attention, but the robot is already handling it safely. Red MASTER WARN means something serious, like the robot going quiet or a big loss lock.",
      "Clicking a lit one tells it you've seen the message, and it goes dark until something new happens.",
    ],
  },
  {
    target: "strip",
    title: "Heartbeat and clock",
    body: [
      "PULSE is the robot's heartbeat: it wakes up every 1 to 5 minutes to check prices and decide. If the pulse gets old, the master lights come on.",
      "JOURNAL is its diary entry number. Every action is written in a diary that can't be edited later. DATA shows how fresh this screen is.",
    ],
  },
  {
    target: "equity",
    title: "How much the account is worth",
    body: [
      "The big green number is the account's total value right now: cash plus anything it owns, valued at today's prices.",
      "SINCE $54 is the profit or loss since the start. HWM (high-water mark) is the highest value it has ever reached.",
    ],
    terms: [
      ["Equity", "The total value of the account."],
      ["Profit / loss", "Up or down compared with the $54 it started with."],
    ],
  },
  {
    target: "dials",
    title: "The safety dials",
    body: [
      "DRAWDOWN shows how far the account has fallen below its best value. The robot slows itself down automatically: from 3% it bets half as much, from 6% it stops buying new things, and at 10% it sells everything and locks itself.",
      "HEAT shows how much money is at risk right now: what it would lose if every trade it holds hit its safety exit at once. It is never allowed above 12%.",
      "FREE TIER shows how much of today's free computer allowance is used. The whole system runs on free services, so if a limit gets close it stops buying until midnight UTC.",
    ],
    terms: [
      ["Stop-loss", "A price set in advance where the robot sells to cap the loss on a trade."],
      ["Amber / red marks", "The dial's caution and danger zones."],
    ],
  },
  {
    target: "trend",
    title: "The trend line",
    body: [
      "Green is the account's value over the last few days, one point per hour. The dashed pink line is the high-water mark. The gap between them is the drawdown.",
    ],
  },
  {
    target: "live",
    title: "Real money is asleep",
    body: [
      "LIVE is a second account with real money. It stays switched off until three things happen: every part of the system is built, the practice account has run on its own for 30 days with good results, and you approve it once by typing RATIFY.",
      "Until then, nothing here can spend real money.",
    ],
  },
  {
    target: "memo",
    title: "Messages",
    body: [
      "Green lines are notes that everything is normal, like which account is running and how fresh the heartbeat is.",
      "When something is wrong, amber or red messages appear here with a plain description. The blue lines underneath say what happens next, or what you could do.",
    ],
  },
  {
    target: "ecp",
    title: "The six system pages",
    body: [
      "These keys switch the lower screen between pages: FEED shows everything the robot says, ASK lets you question it, SET holds every setting. Keys 1 to 9 and 0 on your keyboard do the same. The lit bar shows which page is open.",
    ],
  },
  {
    target: "sd",
    page: "ACCT",
    title: "ACCT: what it owns",
    body: [
      "A position is something the robot has bought and still holds. ENTRY is the price it paid. STOP is its pre-set safety exit if the price falls. TARGET is where it plans to take profit. RISK is the most that trade can lose.",
      "BROKER stops sit at the exchange itself. SYNTHETIC stops are watched by the robot on every heartbeat. Working orders are buy or sell requests that haven't happened yet.",
    ],
    terms: [
      ["Stock", "A small slice of ownership in a company, like Apple (AAPL)."],
      ["Crypto", "Digital currencies like Bitcoin (BTC/USD). They trade 24/7."],
      [
        "Long",
        "Buying something hoping it goes up. It is the only kind of trade the robot makes: a small cash account can't short.",
      ],
      [
        "Inverse fund",
        "A fund that rises when the market falls (SH, PSQ, RWM, BITI). Buying one is how the robot profits from a drop without borrowing.",
      ],
    ],
  },
  {
    target: "sd",
    page: "FUNNEL",
    title: "FUNNEL: how it decides",
    body: [
      "Ideas come from news, company filings and price-pattern scanners. Two quick AI filters throw most of them away.",
      "The few that survive go to the “court”: one AI argues why to buy (the bull), a different AI argues against (the bear), and a judge model scores both. Then strict rules, not AI, decide whether to trade and how much.",
      "Rejections lists every idea it said no to, with the reason. They're checked later to see whether saying no was right.",
    ],
  },
  {
    target: "sd",
    page: "MEM",
    title: "MEM: what it has learned",
    body: [
      "Scar tissue is rules learned from repeated losses, for example “stop trading this coin for 30 days”. The robot can only suggest these; you approve them.",
      "Source reputation tracks which news sources and scanners actually led to good trades, and gives the good ones slightly bigger bets. Beliefs are short notes about past results that slowly fade.",
    ],
  },
  {
    target: "sd",
    page: "OPT",
    title: "OPT: the options practice lab",
    body: [
      "Options are contracts that pay off if a price moves past a level by a date. They're too big for a $54 account, so the robot only practises them here with pretend trades. Nothing on this page is ever sent to a real exchange.",
      "Once enough practice trades show a profit and the account is big enough, options could be unlocked later.",
    ],
  },
  {
    target: "sd",
    page: "GOV",
    title: "GOV: the report card",
    body: [
      "The Governor is the robot's weekly review. It grades past decisions and checks whether the robot's confidence matches reality.",
      "The real-money checklist shows each condition for switching on the LIVE account: PASS, OPEN (not met yet) or WAIT (not enough data).",
    ],
  },
  {
    target: "sd",
    page: "STS",
    title: "STS: market mood and system health",
    body: [
      "Regime is the robot's read of the market's mood. When stock markets look shaky (REDUCE_ONLY), it normally doesn't buy stocks, because buying while prices keep falling is how robots lose money.",
      "In a falling market it switches tools rather than sitting still: it can buy inverse funds that rise as the market drops, and buy coins that fell too far, too fast, once they start bouncing.",
      "The exception: truly huge news (rated near the top of the scale by two AI checks and then the court) can still be traded, at half size and only one at a time. In the danger posture (CASH_PRIORITY) or when its data is out of date, it buys nothing.",
      "Below that are today's free-service usage and the diary's status.",
    ],
  },
  {
    target: "sd",
    page: "FCST",
    title: "FCST: two views of what comes next",
    body: [
      "The white line is the real price over the last week. The amber cloud is Kronos, a small pattern-reading model: the shaded area is where most of its imagined futures end up over the next two days, and the dashed line is its middle guess. It reads charts only, no news, so treat it as a rough hint.",
      "The blue lines are the robot's own view: where it bought or plans to buy, where it would cut the loss (stop) and where it would take profit (target), with the odds it acted on written underneath. The robot never trades on Kronos alone.",
    ],
    terms: [
      ["Forecast band", "The range most of the model's sampled futures fall inside. Wider means less sure."],
      ["Low confidence", "Shown for context, never trusted on its own."],
    ],
  },
  {
    target: "overhead",
    title: "The control panel",
    body: [
      "You normally don't need any of these. Every press is written in the diary and restarts the 30-day clock that decides when real money can start.",
      "ENTRIES pauses new buying (selling to protect existing trades continues). AUTONOMY sets how independent each account is. FLATTEN sells everything immediately: lift the red cover first, then press.",
    ],
  },
  {
    target: "court",
    title: "Asking the court by hand",
    body: [
      "Type a symbol like BTC/USD or NVDA and press CONVENE to make the robot study that one right now. All the same safety rules still apply, and it also counts as stepping in.",
    ],
  },
  {
    title: "That's the whole cockpit",
    body: [
      "Check the two master lights, glance at the green number, and let it work. Discord shows the same alerts and controls on your phone.",
      "Open this guide again any time with the GUIDE key or the ? key.",
    ],
    terms: [
      ["Paper trading", "Practice trading with pretend money and real prices."],
      ["Breaker", "An automatic brake that slows or stops trading after losses."],
      [
        "Fees",
        "Small costs on each trade; at $54 they matter, so the robot only takes trades that can clearly beat them.",
      ],
    ],
  },
];

export const GUIDE_SEEN_KEY = "cortex.guide.seen";

export function Guide(props: { open: boolean; onClose: () => void; setPage: (p: GuidePage) => void }) {
  const { open, onClose, setPage } = props;
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const step = STEPS[i] as Step;

  const measure = useCallback(() => {
    if (!step.target) return setRect(null);
    const el = document.querySelector(`[data-guide="${step.target}"]`);
    setRect(el ? el.getBoundingClientRect() : null);
  }, [step.target]);

  useEffect(() => {
    if (open) setI(0);
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    if (step.page) setPage(step.page);
    const el = step.target ? document.querySelector(`[data-guide="${step.target}"]`) : null;
    el?.scrollIntoView({ block: window.innerWidth <= 640 ? "start" : "center", behavior: "smooth" });
    const t = setTimeout(measure, 380);
    measure();
    card.current?.focus();
    return () => clearTimeout(t);
  }, [open, step, setPage, measure]);

  useEffect(() => {
    if (!open) return;
    const on = () => measure();
    window.addEventListener("resize", on);
    window.addEventListener("scroll", on, true);
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") setI((x) => Math.min(STEPS.length - 1, x + 1));
      else if (e.key === "ArrowLeft") setI((x) => Math.max(0, x - 1));
    };
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("resize", on);
      window.removeEventListener("scroll", on, true);
      window.removeEventListener("keydown", key);
    };
  }, [open, measure, onClose]);

  if (!open) return null;
  const last = i === STEPS.length - 1;
  const pad = 8;
  const hole = rect
    ? {
        top: rect.top - pad,
        left: rect.left - pad,
        width: rect.width + pad * 2,
        height: rect.height + pad * 2,
      }
    : null;
  // place the card below the target when there is room, otherwise above; centred when there is no target
  const vh = window.innerHeight;
  const below = hole ? hole.top + hole.height + 16 : 0;
  const narrow = window.innerWidth <= 640;
  const cardStyle: React.CSSProperties =
    narrow && hole
      ? { bottom: 12, left: 16 }
      : !hole
        ? {}
        : below + 280 < vh
          ? { top: below, left: Math.max(16, Math.min(hole.left, window.innerWidth - 476)) }
          : {
              bottom: Math.max(16, vh - hole.top + 16),
              left: Math.max(16, Math.min(hole.left, window.innerWidth - 476)),
            };

  return (
    <div className="guide" role="dialog" aria-modal="true" aria-labelledby="guide-title">
      {hole ? (
        <div className="guide-hole" style={hole} aria-hidden="true" />
      ) : (
        <div className="guide-dim" aria-hidden="true" onClick={onClose} />
      )}
      <div ref={card} tabIndex={-1} className={`guide-card ${hole ? "" : "centred"}`} style={cardStyle}>
        <h2 id="guide-title" className="guide-title">
          {step.title}
        </h2>
        {step.body.map((p) => (
          <p key={p} className="guide-body">
            {p}
          </p>
        ))}
        {step.terms && (
          <dl className="guide-terms">
            {step.terms.map(([t, d]) => (
              <div key={t}>
                <dt>{t}</dt>
                <dd>{d}</dd>
              </div>
            ))}
          </dl>
        )}
        <div className="guide-nav">
          <button type="button" className="guide-btn quiet" onClick={onClose}>
            {last ? "CLOSE" : "SKIP"}
          </button>
          <span className="spacer" />
          <span className="guide-count">
            {i + 1} / {STEPS.length}
          </span>
          <button type="button" className="guide-btn" disabled={i === 0} onClick={() => setI(i - 1)}>
            BACK
          </button>
          <button
            type="button"
            className="guide-btn primary"
            onClick={() => (last ? onClose() : setI(i + 1))}
          >
            {last ? "DONE" : "NEXT"}
          </button>
        </div>
      </div>
    </div>
  );
}
