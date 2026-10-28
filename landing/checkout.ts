/**
 * Where buying happens (ADR-086): Whop hosts checkout, licence keys and the customer's downloads. Prices live here
 * once and are printed into the page at build time; change them here and on Whop together.
 * Nothing on the page ever links to the source repository or its releases.
 */
export const CHECKOUT_URL = "https://whop.com/savant-agent/";

export const PLANS = {
  monthly: { price: "$35", per: "month", url: "https://whop.com/checkout/plan_4bBHwmIccRi3d" },
  yearly: { price: "$299", per: "year", url: "https://whop.com/checkout/plan_1uDX0TPE2wKea" },
  demo: { url: "https://whop.com/checkout/plan_YlojATUwHM5Um" },
} as const;

export const TRIAL_DAYS = 7;

/** Where customers find their licence key, downloads and billing (Whop's own account page). */
export const ORDERS_URL = "https://whop.com/@me/settings/orders";
