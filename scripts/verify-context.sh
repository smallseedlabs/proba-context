#!/usr/bin/env bash
# Run the full-conversation context checks against any base URLs given by env.
# Prefer the umbrella script when the local stack is up:
#   ~/Projects/proba/proba/local/verify-context.sh
#
# Env (all optional defaults point at loopback):
#   CONTEXT_API_URL   default http://127.0.0.1:3500
#   HUB_URL           default http://127.0.0.1:3300
#   AUDIT_API_URL     default http://127.0.0.1:3400
#   MEMORY_API_URL    default http://127.0.0.1:3420
#   CONTEXT_ASSERTION_PRIVATE_KEY_FILE  PEM for minting act-as assertions
#
# Refuses non-loopback hosts. Forwards flags to the umbrella script when present.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UMBRELLA_VERIFY="${PROBA_UMBRELLA_VERIFY:-$ROOT/../proba/local/verify-context.sh}"

host_of() {
  local u="${1#*://}"
  u="${u%%/*}"
  u="${u%%@*}"
  u="${u%%:*}"
  printf '%s' "$u"
}

for var in CONTEXT_API_URL HUB_URL AUDIT_API_URL MEMORY_API_URL; do
  val="${!var:-}"
  [ -z "$val" ] && continue
  h="$(host_of "$val")"
  case "$h" in
    127.0.0.1|localhost) ;;
    *)
      printf 'refuse: %s=%s is not 127.0.0.1 (got host %s)\n' "$var" "$val" "$h" >&2
      exit 2
      ;;
  esac
done

export CONTEXT_API_URL="${CONTEXT_API_URL:-http://127.0.0.1:3500}"
export HUB_URL="${HUB_URL:-http://127.0.0.1:3300}"
export AUDIT_API_URL="${AUDIT_API_URL:-http://127.0.0.1:3400}"
export MEMORY_API_URL="${MEMORY_API_URL:-http://127.0.0.1:3420}"

if [ -x "$UMBRELLA_VERIFY" ] || [ -f "$UMBRELLA_VERIFY" ]; then
  exec bash "$UMBRELLA_VERIFY" "$@"
fi

cat <<EOF >&2
umbrella verify-context.sh not found at:
  $UMBRELLA_VERIFY
Clone/build the umbrella repo (smallseedlabs/proba) and run:
  ./up.sh --portal --memory --context
  ./verify-context.sh
Or set PROBA_UMBRELLA_VERIFY to that script's path.
EOF
exit 2
