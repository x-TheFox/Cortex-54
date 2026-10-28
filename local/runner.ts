import { hostname } from "node:os";
import type { WorkflowDispatcher } from "../src/cortex/dispatch.ts";
import { signedHeaders } from "../src/lib/hmac.ts";

/**
 * Desktop research runner for a cloud brain (ADR-065). Polls the user's own cloud worker for queued jobs
 * (POST /runner/claim, HMAC-signed with the shared ingest secret) and runs each one locally through the same job
 * runner local mode uses; the job posts its batch straight back to the cloud. Run it from the desktop app or
 * `savant runner`; when no machine is on, jobs wait (and stale data fails closed, as it always has).
 */
export async function claimOnce(
  url: string,
  secret: string,
  jobs: WorkflowDispatcher,
  fetcher: typeof fetch = fetch,
  runner = hostname().slice(0, 40),
): Promise<string | null> {
  const body = JSON.stringify({ runner });
  const r = await fetcher(`${url.replace(/\/$/, "")}/runner/claim`, {
    method: "POST",
    headers: await signedHeaders(secret, "/runner/claim", body),
    body,
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`claim ${r.status}: ${(await r.text()).slice(0, 120)}`);
  const { job } = (await r.json()) as { job: { workflow: string; inputs: Record<string, string> } | null };
  if (!job) return null;
  await jobs.dispatch(job.workflow, job.inputs);
  return `${job.workflow} ${job.inputs.job ?? ""} ${job.inputs.symbol ?? ""}`.trim();
}
