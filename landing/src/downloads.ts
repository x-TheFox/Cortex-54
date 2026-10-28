/**
 * Download buttons show the version they will hand out and the file size (ADR-094). The links themselves never change:
 * /download/<target> always serves the newest build. Without this (offline, blocked) the buttons still work.
 */
interface Info {
  version: string;
  files: Record<string, { size: number }>;
}

const mb = (n: number) => `${Math.round(n / 1e6)} MB`;

export async function labelDownloads(root: ParentNode = document): Promise<void> {
  let info: Info;
  try {
    const r = await fetch("/downloads.json");
    if (!r.ok) return;
    info = (await r.json()) as Info;
  } catch {
    return;
  }
  for (const el of root.querySelectorAll<HTMLElement>("[data-dl-version]"))
    el.textContent = `Version ${info.version}`;
  for (const a of root.querySelectorAll<HTMLAnchorElement>('a[href^="/download/"]')) {
    const f = info.files[a.getAttribute("href")?.slice("/download/".length) ?? ""];
    if (f?.size) a.title = `Savant ${info.version} · ${mb(f.size)}`;
  }
}
