/**
 * Confirmation depth, and the floor it must never go below.
 *
 * WARNING: do not lower NTH_CONFIRMATIONS below 6.
 *
 * NTH publishes block h only once the chain tip is at least `confirmations`
 * above it. ONOSENDAI's Seeds clock relies on that: it takes the newest anchor
 * NTH has published as the DECK-0008 section 4.1 clock height, which the spec
 * defines as "best chain tip minus 6". That reading is only correct while NTH
 * waits for at least 6 confirmations. With a shallower depth, seeds would read
 * blocks that are still young enough to be reorged away, and blooms could
 * differ between clients after a reorg.
 *
 * So a depth below MIN_CONFIRMATIONS refuses to start. The only way past it is
 * NTH_ALLOW_SHALLOW_CONFIRMATIONS=1, which exists for the test suite (fake
 * chains a few blocks tall) and must never be set on a publisher whose anchors
 * reach a real relay.
 */

/** The DECK-0008 section 4.1 clock lag ("best chain tip minus 6"). */
export const MIN_CONFIRMATIONS = 6;

/** The value NTH uses when NTH_CONFIRMATIONS is unset or not a number. */
export const DEFAULT_CONFIRMATIONS = 6;

/** Set to exactly "1" to allow a depth below MIN_CONFIRMATIONS. Tests only. */
export const ALLOW_SHALLOW_ENV = 'NTH_ALLOW_SHALLOW_CONFIRMATIONS';

export type ConfirmationsResult = {
  confirmations: number;
  /** Set when the override let a shallow depth through; the caller should log it loudly. */
  warning: string | null;
};

/**
 * Read NTH_CONFIRMATIONS and enforce the floor.
 *
 * Throws when the configured depth is below MIN_CONFIRMATIONS and the
 * override is not set to exactly "1". With the override, returns the shallow
 * depth (never below 1, since NTH needs block h+1 for the `N` tag anyway)
 * together with a warning to print.
 */
export function resolveConfirmations(env: NodeJS.ProcessEnv = process.env): ConfirmationsResult {
  const raw = (env.NTH_CONFIRMATIONS || '').trim();
  const parsed = raw ? Number.parseInt(raw, 10) : DEFAULT_CONFIRMATIONS;
  const requested = Number.isFinite(parsed) ? parsed : DEFAULT_CONFIRMATIONS;

  if (requested >= MIN_CONFIRMATIONS) {
    return { confirmations: requested, warning: null };
  }

  const reason =
    `NTH_CONFIRMATIONS=${raw} is below the minimum of ${MIN_CONFIRMATIONS}. ` +
    `ONOSENDAI's Seeds clock reads NTH's newest published anchor as the DECK-0008 section 4.1 ` +
    `clock height ("best chain tip minus ${MIN_CONFIRMATIONS}"), so NTH must not publish a block ` +
    `until the tip is at least ${MIN_CONFIRMATIONS} above it. A shallower depth lets seeds read ` +
    `blocks that can still be reorged away, and blooms could differ between clients after a reorg.`;

  if ((env[ALLOW_SHALLOW_ENV] || '').trim() !== '1') {
    throw new Error(
      `Refusing to start: ${reason} Set NTH_CONFIRMATIONS to ${MIN_CONFIRMATIONS} or more ` +
        `(or unset it for the default of ${DEFAULT_CONFIRMATIONS}).`,
    );
  }

  const confirmations = Math.max(1, requested);
  return {
    confirmations,
    warning:
      `!!! ${ALLOW_SHALLOW_ENV}=1 is set: publishing with only ${confirmations} confirmation(s). !!!\n` +
      `!!! ${reason} !!!\n` +
      `!!! This override is for tests only. Never run a publisher whose anchors reach a real relay with it. !!!`,
  };
}
