# API documentation

The live contract is OpenAPI, served at `/api/docs` when `SWAGGER_ENABLED=true`
and generated from the code itself — that is the source of truth, not this
directory.

What belongs here: integration guides that the spec cannot express — auth flows
end to end, idempotency-key usage for payments and refunds, error-code handling,
pagination conventions, and any generated client artefacts shared with the five
app repositories.

Conventions (versioning, the error envelope, correlation IDs, pagination) are
documented in the root [README.md](../../README.md).
