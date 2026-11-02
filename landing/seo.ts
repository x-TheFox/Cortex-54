import { EDITION, PLANS, TRIAL_DAYS } from "./checkout.ts";

/**
 * Search-engine data for getsavant.pro (ADR-101). One FAQ list feeds both the visible FAQ section and its FAQPage
 * markup (search engines require the answers to be on the page). Prices come from checkout.ts, like the page itself.
 * Every answer must stay true and checkable (CORTEX_LEDGER §14).
 */

export const SITE = "https://getsavant.pro";

export const FAQ: { q: string; a: string }[] = [
  {
    q: "Does Savant trade on its own?",
    a: "Yes. Savant reads the news, holds a court hearing on each idea and places trades on your own broker account without asking you first. A deterministic risk engine sizes every trade and can veto it; no AI model ever chooses a size.",
  },
  {
    q: "Do I have to approve each trade?",
    a: "No. There is no approve-each-trade mode. You set the autonomy dial, and you can pause, flatten or kill everything at any time. Real-money trading stays off until you switch it on yourself.",
  },
  {
    q: "Where do my API keys and data live?",
    a: "On your own computer. Savant runs locally; your broker and model keys stay in your data folder or your system keychain and are never sent to us. The licence check sends only your licence key and a one-way fingerprint of the computer.",
  },
  {
    q: "Which AI models does it use?",
    a: "Any you connect: free tiers such as Google Gemini, Groq, NVIDIA NIM and OpenRouter's free models, or your own paid or local models. You choose free only or free and paid, and which models the court may use.",
  },
  {
    q: "Can Savant lose money?",
    a: "Yes. Trading can lose all of the money in the account. Hard caps limit the risk per trade, per position and per day, and every position carries a stop, but gaps can jump past a stop and software can fail. Paper and backtest results are simulations and don't predict future results.",
  },
  {
    q: "Is there a free trial?",
    a: `Every paid plan starts with a ${TRIAL_DAYS}-day free trial, and demo mode is free forever. Any charge can be refunded from your account page within 14 days.`,
  },
];

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The visible FAQ (plain <details>, no script). */
export function faqHtml(): string {
  return FAQ.map(
    (f) => `<details class="faq-item"><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`,
  ).join("\n          ");
}

const amount = (p: string) => p.replace(/[^0-9.]/g, "");

/** JSON-LD for the home page: Organization, WebSite, SoftwareApplication, Product with offers, and FAQPage. */
export function jsonLd(): string {
  const org = {
    "@type": "Organization",
    "@id": `${SITE}/#org`,
    name: "Savant",
    url: `${SITE}/`,
    logo: `${SITE}/favicon.svg`,
  };
  const offers = [
    {
      "@type": "Offer",
      name: `Monthly · ${EDITION}`,
      price: amount(PLANS.monthly.price),
      priceCurrency: "USD",
      url: `${SITE}/#pricing`,
      availability: "https://schema.org/InStock",
      priceSpecification: {
        "@type": "UnitPriceSpecification",
        price: amount(PLANS.monthly.price),
        priceCurrency: "USD",
        unitCode: "MON",
      },
    },
    {
      "@type": "Offer",
      name: `Yearly · ${EDITION}`,
      price: amount(PLANS.yearly.price),
      priceCurrency: "USD",
      url: `${SITE}/#pricing`,
      availability: "https://schema.org/InStock",
      priceSpecification: {
        "@type": "UnitPriceSpecification",
        price: amount(PLANS.yearly.price),
        priceCurrency: "USD",
        unitCode: "ANN",
      },
    },
    { "@type": "Offer", name: "Demo", price: "0", priceCurrency: "USD", url: `${SITE}/demo/` },
  ];
  const description =
    "An autonomous trading agent you run on your own computer. AI models argue every trade in a court; a deterministic risk engine sizes it; eight rules no model can change.";
  const graph = [
    org,
    {
      "@type": "WebSite",
      "@id": `${SITE}/#site`,
      url: `${SITE}/`,
      name: "Savant",
      publisher: { "@id": `${SITE}/#org` },
      inLanguage: "en",
    },
    {
      "@type": "SoftwareApplication",
      "@id": `${SITE}/#app`,
      name: "Savant",
      applicationCategory: "FinanceApplication",
      operatingSystem: "macOS, Windows, Linux",
      description,
      url: `${SITE}/`,
      image: `${SITE}/og.png`,
      screenshot: `${SITE}/cockpit.webp`,
      publisher: { "@id": `${SITE}/#org` },
      offers,
    },
    {
      "@type": "Product",
      "@id": `${SITE}/#product`,
      name: "Savant",
      description,
      brand: { "@id": `${SITE}/#org` },
      image: `${SITE}/og.png`,
      offers,
    },
    {
      "@type": "FAQPage",
      "@id": `${SITE}/#faq`,
      mainEntity: FAQ.map((f) => ({
        "@type": "Question",
        name: f.q,
        acceptedAnswer: { "@type": "Answer", text: f.a },
      })),
    },
  ];
  // "</" can't appear inside the script element
  const body = JSON.stringify({ "@context": "https://schema.org", "@graph": graph }).replace(/</g, "\\u003c");
  return `<script type="application/ld+json">${body}</script>`;
}
