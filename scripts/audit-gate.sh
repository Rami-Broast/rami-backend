#!/usr/bin/env bash
# Dependency vulnerability gate.
#
# Fails on any high or critical advisory. Distinguishes that from "the advisory
# registry did not answer", which is the distinction the previous
# implementations could not make and the reason this check was unreliable.
#
# `audit-ci` (pinned 7.x, installed by `npm ci`, so not an unpinned-fetch
# problem) hangs on the advisory endpoint from GitHub's runners: three
# consecutive 120s attempts produced no output at all, twice, on two different
# commits. A retry cannot help with that, and a check that goes red because a
# third party was slow is worse than no check — it teaches everyone to re-run
# the security job on sight, which is the habit that waves a real advisory
# through.
#
# Swapping `audit-ci` for plain `npm audit` would not have helped: they share
# the endpoint. Measured directly — `npm audit --audit-level=high` ran for
# 7m01s (0.98s of CPU: blocked on a socket, not working) and then exited **1**
# with "audit endpoint returned an error".
#
# That last detail is the whole argument for this script. `npm audit` exits 1
# both when your dependencies are vulnerable and when it could not ask. A gate
# that reads only the exit code cannot tell a compromised build from a bad
# afternoon at the registry, and will eventually be trusted for neither.
#
# So: ask once, with a deadline, and branch on whether we got *data* rather
# than on an exit code that conflates "vulnerable" with "unreachable".
#   - Valid JSON with high/critical counts  -> gate on them (red means red).
#   - Valid JSON, nothing high or critical  -> pass.
#   - No JSON at all                        -> warn loudly, pass.
#
# The last case is a deliberate trade, and it is why Dependabot alerts should be
# enabled on the repository: they are evaluated by GitHub rather than by a
# runner with egress problems, so they still catch what this step misses on a
# bad day. This step is the fast signal, not the only one.
set -uo pipefail

TIMEOUT_SECONDS="${AUDIT_TIMEOUT_SECONDS:-120}"
REPORT="${AUDIT_REPORT_PATH:-/tmp/npm-audit.json}"

# `AUDIT_SKIP_FETCH` lets the decision logic below be exercised against a
# fixture report. The three branches — clean, finding, no data — are the whole
# point of this script, and they are not testable if the fetch always
# overwrites the file first.
if [ "${AUDIT_SKIP_FETCH:-0}" != "1" ]; then
  timeout "${TIMEOUT_SECONDS}" npm audit --json > "${REPORT}" 2>/dev/null
  # Exit code deliberately ignored: `npm audit` exits non-zero *because* it
  # found something, which is data, not an error.
fi

if ! node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "${REPORT}" 2>/dev/null; then
  echo "::warning::Dependency audit skipped: the advisory registry did not answer within ${TIMEOUT_SECONDS}s. Dependabot alerts remain the backstop."
  exit 0
fi

read -r HIGH CRITICAL <<EOF2
$(node -e '
  const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const v = (r.metadata && r.metadata.vulnerabilities) || {};
  process.stdout.write(`${v.high || 0} ${v.critical || 0}`);
' "${REPORT}")
EOF2

if [ "${HIGH}" -gt 0 ] || [ "${CRITICAL}" -gt 0 ]; then
  echo "::error::Dependency audit found ${CRITICAL} critical and ${HIGH} high advisories."
  node -e '
    const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    for (const [name, v] of Object.entries(r.vulnerabilities || {})) {
      if (v.severity === "high" || v.severity === "critical") {
        console.log(`  ${v.severity.padEnd(9)} ${name}`);
      }
    }
  ' "${REPORT}"
  exit 1
fi

echo "Dependency audit clean: no high or critical advisories."
