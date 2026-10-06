# Scripts

Operational and developer scripts.

Rules:

- A script must never contain a credential. Read from the environment.
- Anything touching production data requires explicit approval before it is run,
  and must be reviewed like application code.
- Destructive scripts must refuse to run unless the target environment is stated
  explicitly — no silent defaults to production.
