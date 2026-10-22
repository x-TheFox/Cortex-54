import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { type Constitution, ConstitutionSchema } from "../src/contracts/constitution.ts";
import { type Doctrine, DoctrineSchema } from "../src/contracts/doctrine.ts";

export const constitution: Constitution = ConstitutionSchema.parse(
  JSON.parse(readFileSync("config/constitution.json", "utf8")),
);
export const doctrine: Doctrine = DoctrineSchema.parse(parse(readFileSync("config/doctrine.yaml", "utf8")));

/** Doctrine copy with the baseline strategy enabled on both accounts (for LIVE-path tests). */
export function doctrineWith(mutate: (d: Doctrine) => void): Doctrine {
  const d = structuredClone(doctrine);
  mutate(d);
  return d;
}
