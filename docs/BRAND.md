# Savant and Cortex — the names

**Savant** is the product and the company: the app people download, the store they buy from, the name on the
installer. **Cortex** is the agent inside it: the thing that reads the market, holds its hearings and places (or
refuses) trades. The relationship is the one between a family name and a model name: you use Savant; Savant runs
Cortex.

## Why "Savant"

A savant is someone with deep, narrow mastery: unusually good at one demanding thing, and honest about the edge of
that skill. That is the promise of the product:

- **Narrow on purpose.** Savant does one job — autonomous, risk-bounded trading on the customer's own broker
  account — and refuses everything around it that would make it a worse version of that job (margin, shorting,
  leverage, trades nobody can explain).
- **Learned, not lucky.** The edge comes from a process (evidence, a hearing, a sizer, a constitution, a journal),
  not from a model's mood. A savant's skill looks like intuition from the outside and is method on the inside.
- **Quietly confident.** The cockpit stays dark when things are fine; the agent explains itself in plain words when
  asked. The name should sound calm, not like a get-rich promise.
- **Ownable and pronounceable** in every market the store reaches, and short enough for a menu bar.

## Why "Cortex" stays

The cortex is the layer of the brain that reasons: it weighs evidence, plans and inhibits impulses. That is exactly
the agent's job, and its architecture is built like one — a fast reflex layer (Tier 0 math), a triage layer, a
structure layer and a deliberative court, with a risk engine that can veto all of them. The engine has been called
Cortex since its first commit, so keeping the name for the agent keeps the history, the journal and every existing
install continuous.

The "54" is retired from the name: it was the size of the first account ($54), the budget that made every cent and
basis point visible. Savant now trades accounts of any size, so $54 stays as the worked example in the docs and on
the page ("why 54?"), not as a limit in the name.

## How to write it

- In copy: **Savant** (the app), **Cortex** (the agent). "Savant's Cortex agent", "Cortex, the agent inside Savant".
- In the cockpit header: `SAVANT · CORTEX`.
- The command line: `savant` (`cortex` keeps working as an alias for existing scripts).
- Never "Savant AI" or "Cortex AI" in headlines: the product's argument is that the models are jurors, not the
  judge.

## What did not change (on purpose)

Internal identifiers that live inside data or connect running systems keep their names, because renaming them would
lose data or break a link: the Durable Object names (`CORTEX-54-PRIMARY`, `CORTEX-54-LAB`), Worker names,
`c54-…` client order ids, the licence and backup file kinds, environment variables (`CORTEX_*`, with `SAVANT_HOME`
accepted too), the keychain service, the repository name, and an existing `~/.cortex54` folder (new installs use
`~/.savant`). See ADR-085.
