import qrcode from "qrcode-generator";
import { useMemo } from "react";

/**
 * A QR code drawn as one SVG path (ADR-076): phone alerts (the ntfy topic) and phone pairing (a one-time login link).
 * Encoded in the browser, so the link never goes to a QR web service.
 */
export function Qr({ text, size = 176, label }: { text: string; size?: number; label: string }) {
  const { n, d } = useMemo(() => {
    const q = qrcode(0, "M");
    q.addData(text, "Byte");
    q.make();
    const n = q.getModuleCount();
    let d = "";
    for (let r = 0; r < n; r++)
      for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c + 2} ${r + 2}h1v1h-1z`;
    return { n, d };
  }, [text]);
  return (
    <svg
      className="qr"
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={`0 0 ${n + 4} ${n + 4}`}
      shapeRendering="crispEdges"
    >
      <rect width={n + 4} height={n + 4} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}
