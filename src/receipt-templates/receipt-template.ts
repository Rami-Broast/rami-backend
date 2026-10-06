/**
 * What a customer docket is made of — the shape, the default, and the rule for
 * putting a branch's override on top of the owner's default.
 *
 * Pure and tested. The **rendering** of it lives in the apps (`kitchen-pos`
 * prints it, `admin-app` previews it) because the backend never talks to a
 * printer; what lives here is the part both of them and the database have to
 * agree on.
 *
 * Two decisions worth keeping:
 *
 *  - **A branch overrides a handful of fields, not the layout.** The owner's
 *    template is the brand; a branch that could reorder sections, rewrite the
 *    footer or drop the reference would produce a customer receipt the owner
 *    has never seen, one branch at a time. What a branch genuinely knows
 *    better is how long its own kitchen takes and what it wants to say to its
 *    own customers — so that is what it may set.
 *  - **An unknown key is dropped, not merged.** The override is stored JSON
 *    written by an older or newer client, and a template is printed on paper
 *    in front of a customer; taking only the keys named here means a stale
 *    override cannot smuggle a field past the owner's decision about what a
 *    branch may change.
 */

export const DOCKET_SECTION_IDS = [
  'logo',
  'brand',
  'orderType',
  'orderMeta',
  'customer',
  'readyTime',
  'items',
  'totals',
  'reference',
  'thankYou',
] as const;

export type DocketSectionId = (typeof DOCKET_SECTION_IDS)[number];

export interface ReadyTimeRules {
  /** Above this items total, the order counts as a big one. In halalas. */
  largeOrderThresholdMinor: number;
  smallOrderMinutes: [number, number];
  largeOrderMinutes: [number, number];
  /** Added to both ends of a delivery order: packing for a journey. */
  deliveryExtraMinutes: number;
}

export interface DocketTemplate {
  /** The sections that print, in the order they print in. */
  sections: DocketSectionId[];
  /**
   * Print the restaurant's logo as an image at the top, **on by default**.
   *
   * The printing app rasterises it to the roll's dot width and hands it to the
   * printer; nothing about it is stored here but the choice and, optionally,
   * where to get the artwork.
   */
  printLogoImage: boolean;
  /**
   * The artwork, when the owner has replaced the one the apps ship with.
   * Null means "use the bundled brand mark", which is what makes a logo print
   * on day one at a branch that has configured nothing.
   */
  logoImageUrl: string | null;
  /**
   * How wide the logo prints, as a percentage of the paper.
   *
   * The roll is the only ruler that means anything here — an 80mm head is 576
   * dots across and a 58mm one 384, so a size in millimetres or pixels would be
   * a different size on each. 100 is edge to edge.
   *
   * It matters more than it looks: a wordmark with fine detail survives being
   * *smaller* rather better than being stretched, because the detail is lost to
   * the head's resolution either way and a smaller mark hides it.
   */
  logoWidthPercent: number;
  /** Text above the name, for a printer that cannot manage an image. */
  logoLines: string[];
  brandLines: string[];
  showBranchName: boolean;
  showNewCustomerBadge: boolean;
  readyTimeRules: ReadyTimeRules;
  thankYouLines: string[];
  footerLines: string[];
}

export const DEFAULT_DOCKET_TEMPLATE: DocketTemplate = {
  sections: [...DOCKET_SECTION_IDS],
  printLogoImage: true,
  logoImageUrl: null,
  // Full width is what every existing branch already prints, so the default
  // changes nothing for anyone who never opens the control.
  logoWidthPercent: 100,
  logoLines: [],
  brandLines: ['رامي', 'Rami Broast'],
  showBranchName: true,
  showNewCustomerBadge: true,
  readyTimeRules: {
    largeOrderThresholdMinor: 10000,
    smallOrderMinutes: [10, 15],
    largeOrderMinutes: [20, 25],
    deliveryExtraMinutes: 5,
  },
  thankYouLines: ['Thank you!', 'Please visit again.'],
  footerLines: ['Not a tax invoice'],
};

/**
 * The fields a branch may set for itself.
 *
 * `readyTimeRules` because a branch's kitchen speed is a fact about that
 * kitchen, and `thankYouLines` because a local message is the one piece of the
 * document that is genuinely the branch's to say. Everything else — the
 * layout, the brand lines, the footer that says this is not a tax invoice —
 * belongs to the owner.
 */
export const BRANCH_OVERRIDABLE_KEYS = ['readyTimeRules', 'thankYouLines'] as const;

export type BranchDocketOverride = Partial<
  Pick<DocketTemplate, (typeof BRANCH_OVERRIDABLE_KEYS)[number]>
>;

/** A stored template merged onto the built-in default, key by key. */
export function withDefaults(stored: unknown): DocketTemplate {
  const source = isRecord(stored) ? stored : {};
  const readyTimeRules = isRecord(source.readyTimeRules)
    ? { ...DEFAULT_DOCKET_TEMPLATE.readyTimeRules, ...(source.readyTimeRules as object) }
    : DEFAULT_DOCKET_TEMPLATE.readyTimeRules;

  return {
    ...DEFAULT_DOCKET_TEMPLATE,
    ...source,
    readyTimeRules,
  };
}

/**
 * The template one branch prints: the owner's default with that branch's
 * override on top, taking only the keys a branch is allowed to set.
 */
export function resolveTemplate(
  organisationDefault: unknown,
  branchOverride: unknown,
): DocketTemplate {
  const base = withDefaults(organisationDefault);
  const override = isRecord(branchOverride) ? branchOverride : {};

  const allowed: BranchDocketOverride = {};
  for (const key of BRANCH_OVERRIDABLE_KEYS) {
    const value = override[key];
    if (value === undefined || value === null) {
      continue;
    }
    if (key === 'readyTimeRules' && isRecord(value)) {
      allowed.readyTimeRules = { ...base.readyTimeRules, ...(value as object) };
    }
    if (key === 'thankYouLines' && Array.isArray(value)) {
      allowed.thankYouLines = value.filter((line): line is string => typeof line === 'string');
    }
  }

  return { ...base, ...allowed };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
