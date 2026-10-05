# Assets — owner-uploaded images

Menu photography and offer artwork, uploaded from the owner's own machine or
phone gallery instead of pasted in as a URL.

## Why the bytes are in Postgres

No object storage is provisioned for this platform — the same blocked-on-infra
category as proof-of-delivery photos. The alternative on offer was what the
admin panel already did: ask the owner for a URL. That meant every menu photo
and every offer card pointed at somewhere nobody here controls, and any of them
could 404 into a customer's menu without warning.

Bytes in the database is a deliberate, **bounded** trade:

- A menu is tens of images, written once and read from a cache. The volume is
  nothing like a transactional table.
- `GET /assets/:id` sets `Cache-Control: immutable` for a year, which is safe
  because an asset's bytes never change — a new image gets a new id. The second
  view of an image never touches Postgres.
- Uploading is gated on `assets:write`, an owner-level permission. This is
  **not** where bulk images belong; proof-of-delivery photos must not end up
  here.
- `MAX_ASSET_BYTES` caps a single upload at 6 MB, enforced twice: by multer
  before the body is read at all, and by `rejectAsset` after. An unbounded
  upload is an unbounded database.

## Moving to object storage later is one file

A client only ever handles the **URL**. Nothing in the admin panel or the
customer app knows where the bytes are, so switching to GCS signed uploads is a
change to `AssetsService` plus a redirect from `GET /assets/:id` — no client
release, and existing images keep working.

## SVG is refused on purpose

An SVG is a document that can carry script, and these files are served from our
own origin. An owner pulling one off a free-icons site would be handing that
site's author a foothold in the admin panel. Every accepted format is inert, and
responses additionally carry `X-Content-Type-Options: nosniff` and a
`default-src 'none'; sandbox` CSP so a file that somehow slipped the allow-list
still cannot execute anything.
