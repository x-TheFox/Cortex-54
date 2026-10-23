---
version: 1
slug: "web-index-html"
primary_target: "web/index.html"
related_targets: ["web/src"]
---

# Web terminal (CORTEX-WEB)

Scope: the operator web terminal (web/), all workspaces. Mode: Operate. Desktop first; phone must work.
Audience/job: the single operator, at a desk, glancing for health, watching the funnel think, reviewing results. Controls exist but leaving the system alone is the norm (manual commands restart the 30-day clock).
Constraints: React static build served by the worker; strict CSP, self-hosted fonts; real API data only.

## Direction contract

THESIS: Dark cockpit. When CORTEX is normal the screen is nearly unlit; light means attention, and colour is a fixed vocabulary (green normal/active, amber caution, red warning, cyan actionable/selectable, white labels, magenta targets). Refuses the category default of a neon-accented dashboard where every panel shouts.

OWN-WORLD: Two glass displays in a matte graphite glareshield: the upper E/WD (equity, drawdown, heat and budget dials, memo/alert column) and the lower SD system pages chosen from an ECP key row. B612 / B612 Mono, the Airbus cockpit faces. Square-ish bezels, engraved labels, lit pushbuttons that stay dark when in their normal state.

STORY: The operator sees in one look whether anything is lit. If something is, the alert column says what, in amber or red, with the action in cyan. Otherwise they read the memo, page through ACCT / FUNNEL / MEM / OPT / GOV / STS, and leave.

FIRST VIEWPORT: Top: MASTER WARN and MASTER CAUT annunciators flank the title strip (UTC clock, pulse age, journal seq). Upper display: per-account equity readout with drawdown and heat dials left; ECAM memo and alert list right. Lower display: the selected system page. Below: ECP keys, then the overhead panel of guarded controls.

FORM: Airbus dark-cockpit / ECAM; candidate 1 of my grounded list (operator's pick over the assigned signal box); seed key ec589f93.

Signature interaction: guarded switches. FLATTEN and LIVE RATIFY sit under a red guard that must be lifted before the button arms; ENTRIES and dial are lit pushbuttons that light only when not in their normal state.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
