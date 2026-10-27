import { type HubDb, handleHub } from "./handler.ts";

/** CORTEX community hub Worker (ADR-068): the one service the publisher hosts. */
interface Env {
  DB: D1Database;
}

function d1(db: D1Database): HubDb {
  return {
    all: async <T>(sql: string, ...b: unknown[]) =>
      ((
        await db
          .prepare(sql)
          .bind(...b)
          .all()
      ).results ?? []) as T[],
    first: async <T>(sql: string, ...b: unknown[]) =>
      (await db
        .prepare(sql)
        .bind(...b)
        .first()) as T | null,
    run: async (sql: string, ...b: unknown[]) => {
      await db
        .prepare(sql)
        .bind(...b)
        .run();
    },
  };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === "OPTIONS")
      return new Response(null, {
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST",
          "access-control-allow-headers": "content-type",
        },
      });
    return handleHub(req, d1(env.DB), Date.now());
  },
} satisfies ExportedHandler<Env>;
