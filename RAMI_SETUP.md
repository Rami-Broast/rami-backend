# Rami Broast — platform setup & independence

This repository is the Rami Broast backend. Its code was adapted from an
earlier restaurant-delivery platform, but **Rami Broast runs as a completely
independent deployment**. Nothing here shares infrastructure, data, or
credentials with any other tenant.

The code alone cannot create a cross-connection — hosting, database and secrets
are supplied at deploy time, not committed. To keep Rami isolated, give it its
**own** values for every item below and never reuse another project's:

## Must be set to Rami-only values

| Where | Variable | Notes |
| --- | --- | --- |
| GitHub repo variables | `GCP_PROJECT_ID`, `GCP_REGION`, `CLOUDSQL_CONN` | Rami's own Google Cloud project + Cloud SQL instance. The demo workflow deploys a Cloud Run service named **`rami-api`**. |
| GitHub repo variables | `CLIENT_ORIGINS` | Rami's own app origins (admin / POS / customer / driver). |
| GitHub secrets | `DATABASE_URL` / Cloud SQL creds | A **separate** Postgres database. This is the single most important isolation boundary. |
| GitHub secrets | `JWT_ACCESS_SECRET`, `PAYMENT_MOCK_WEBHOOK_SECRET`, maps keys, etc. | Freshly generated for Rami. |
| Production | `PROD_SERVICE_NAME`, payment/SMS/push provider creds | `deploy-production.yml` is gated on a protected environment. |

The client apps (`rami-admin`, `rami-customer-app`, `rami-driver-app`,
`rami-kitchen`) point at Rami's backend via their own `API_BASE_URL` /
`VITE_API_BASE_URL`. Until Rami's backend is deployed, those default to the
placeholder `https://rami-api.example.com/api/v1`, which intentionally does not
resolve — so an unconfigured build fails loudly rather than silently calling
another environment.

See the backend `README.md`, `DEMO_DECISIONS.md` and `.env.example` for the full
configuration surface.
