import {
  BRANCH_OVERRIDABLE_KEYS,
  DEFAULT_DOCKET_TEMPLATE,
  resolveTemplate,
  withDefaults,
} from '../../src/receipt-templates/receipt-template';

describe('withDefaults', () => {
  it('returns the shipped template when nothing has been edited', () => {
    // A branch that has never been touched prints the same receipt as every
    // other branch, rather than a blank page.
    expect(withDefaults(undefined)).toEqual(DEFAULT_DOCKET_TEMPLATE);
    expect(withDefaults(null)).toEqual(DEFAULT_DOCKET_TEMPLATE);
  });

  it('fills in a key an older saved template does not have', () => {
    // The stored config is a document written by whichever version of the
    // editor last saved it. A key added later must not print as undefined.
    const saved = withDefaults({ thankYouLines: ['Shukran'] });

    expect(saved.thankYouLines).toEqual(['Shukran']);
    expect(saved.footerLines).toEqual(DEFAULT_DOCKET_TEMPLATE.footerLines);
    expect(saved.sections).toEqual(DEFAULT_DOCKET_TEMPLATE.sections);
  });

  it('fills in a missing ready-time rule rather than taking the object whole', () => {
    const saved = withDefaults({ readyTimeRules: { deliveryExtraMinutes: 9 } });

    expect(saved.readyTimeRules.deliveryExtraMinutes).toBe(9);
    expect(saved.readyTimeRules.smallOrderMinutes).toEqual([10, 15]);
  });
});

describe('resolveTemplate', () => {
  const organisation = {
    ...DEFAULT_DOCKET_TEMPLATE,
    brandLines: ['Rami Broast'],
    footerLines: ['Not a tax invoice'],
    sections: ['brand', 'items', 'totals'],
  };

  it('puts a branch override on top of the owner default', () => {
    const resolved = resolveTemplate(organisation, {
      thankYouLines: ['Thank you from Olaya'],
      readyTimeRules: { deliveryExtraMinutes: 8 },
    });

    expect(resolved.thankYouLines).toEqual(['Thank you from Olaya']);
    expect(resolved.readyTimeRules.deliveryExtraMinutes).toBe(8);
    // And keeps the rest of the rules, rather than replacing the object.
    expect(resolved.readyTimeRules.largeOrderMinutes).toEqual([20, 25]);
  });

  it('refuses a branch the fields that are the owner’s', () => {
    // The layout, the brand and the footer are the brand. A branch that could
    // set them would produce a customer receipt the owner has never seen, one
    // branch at a time — and the footer is the line that keeps the document
    // from reading as a tax invoice.
    const resolved = resolveTemplate(organisation, {
      sections: ['items'],
      brandLines: ['A Different Restaurant'],
      footerLines: [],
      showNewCustomerBadge: false,
    });

    expect(resolved.sections).toEqual(['brand', 'items', 'totals']);
    expect(resolved.brandLines).toEqual(['Rami Broast']);
    expect(resolved.footerLines).toEqual(['Not a tax invoice']);
    expect(resolved.showNewCustomerBadge).toBe(true);
  });

  it('is the owner’s template exactly when a branch has no override', () => {
    expect(resolveTemplate(organisation, undefined)).toEqual(withDefaults(organisation));
    expect(resolveTemplate(organisation, {})).toEqual(withDefaults(organisation));
  });

  it('ignores a null or wrongly-typed override rather than printing it', () => {
    const resolved = resolveTemplate(organisation, {
      thankYouLines: null,
      readyTimeRules: 'soon',
    });

    expect(resolved.thankYouLines).toEqual(DEFAULT_DOCKET_TEMPLATE.thankYouLines);
    expect(resolved.readyTimeRules).toEqual(DEFAULT_DOCKET_TEMPLATE.readyTimeRules);
  });

  it('keeps the logo the owner\u2019s, not the branch\u2019s', () => {
    // The logo is the brand. A branch switching it off, or pointing it at
    //its own artwork, is the same class of change as rewriting the restaurant's
    // name — and it happens on a document the owner never sees.
    const resolved = resolveTemplate(organisation, {
      printLogoImage: false,
      logoImageUrl: 'https://example.test/not-ours.png',
    });

    expect(resolved.printLogoImage).toBe(true);
    expect(resolved.logoImageUrl).toBeNull();
  });

  it('names exactly the keys a branch may set', () => {
    // A guard on the decision itself: widening this list hands every branch a
    // piece of the owner's brand, and should have to be done deliberately.
    expect([...BRANCH_OVERRIDABLE_KEYS]).toEqual(['readyTimeRules', 'thankYouLines']);
  });
});
