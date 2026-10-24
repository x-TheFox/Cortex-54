import { describe, expect, it } from "vitest";
import { AlpacaClient } from "../src/broker/AlpacaClient.ts";
import { BrokerError } from "../src/broker/types.ts";

const creds = { keyId: "k", secret: "s" };
const account = {
  id: "a",
  status: "ACTIVE",
  currency: "USD",
  cash: "54",
  equity: "54",
  last_equity: "54",
  buying_power: "54",
  non_marginable_buying_power: "54",
  trading_blocked: false,
  account_blocked: false,
};

describe("Alpaca client retries (audit W3-11)", () => {
  it("retries a read through a 429 and a 503, counting each attempt against the subrequest guard", async () => {
    const replies = [
      new Response("slow down", { status: 429, headers: { "retry-after": "0" } }),
      new Response("x", { status: 503 }),
    ];
    let guarded = 0;
    const c = new AlpacaClient(
      "https://paper-api.alpaca.markets",
      creds,
      () => {
        guarded++;
      },
      async () => replies.shift() ?? Response.json(account),
    );
    const a = await c.account().catch((e) => e);
    expect(a instanceof BrokerError ? a.message : "ok").toBe("ok");
    expect(guarded).toBe(3);
  });

  it("never retries a write, and a network failure becomes a 408 BrokerError", async () => {
    let calls = 0;
    const c = new AlpacaClient(
      "https://paper-api.alpaca.markets",
      creds,
      () => undefined,
      async () => {
        calls++;
        throw new TypeError("network down");
      },
    );
    const e = await c
      .submitOrder({
        symbol: "BTC/USD",
        side: "buy",
        type: "limit",
        time_in_force: "gtc",
        qty: "1",
        client_order_id: "x",
        limit_price: "1",
      })
      .catch((x) => x);
    expect(e).toBeInstanceOf(BrokerError);
    expect((e as BrokerError).status).toBe(408);
    expect(calls).toBe(1);
  });
});
