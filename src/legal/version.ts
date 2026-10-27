/**
 * The version of the legal set (docs/legal: terms, EULA, risk disclosure, privacy, refunds) that a user accepts at
 * first launch (ADR-087). Bump it whenever any of those documents changes in substance: the app then asks again and
 * holds new entries until the user accepts.
 */
export const TERMS_VERSION = "2026-10-27";
