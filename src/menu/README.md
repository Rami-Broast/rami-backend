# `menu/`

**Status: implemented in Phase 6.**

The catalog, and the bridge from a customer's cart to server-side prices.

## What is here

| Path | Purpose |
| --- | --- |
| `menu.service.ts` / `menu.controller.ts` | Staff catalog management and per-branch availability |
| `catalog.service.ts` | Branch menu reads, and `resolveCartLines` for pricing |
| `catalog.controller.ts` | Public branch menu, and the cart quote endpoint |

## The split that matters

The catalog is **organisation-wide**: categories, products, prices. Managing it
requires `menu:write`, which only an owner holds.

**Availability is per branch**: whether this branch currently sells an item, and
optionally at what price. That requires `menu:availability` and is guarded by
branch isolation.

So a branch manager can take the lamb off for the evening without being able to
rename a product or reprice the whole chain.

## Rules this module upholds

- A cart request carries product IDs and quantities, **never a price**.
- An unavailable item **fails the whole cart** rather than being dropped — a
  customer must not be charged for less than they believe they ordered.
- An add-on from a group the product does not offer is rejected, so a crafted
  request cannot attach arbitrary extras.
- Products are soft-deleted, and deletion immediately stops every branch selling
  them.

## Not yet built

Variant, modifier-group and add-on management endpoints. The models, the
customer-facing reads and the cart resolution all handle them; what is missing
is staff CRUD, which lands with the admin app work in Phase 10.
