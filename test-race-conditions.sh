#!/bin/bash
set -euo pipefail

SEED=12345

# Parse args ( --rebuild already handled later ); support --seed <n> or --seed=n
PARSED_ARGS=()
while [[ $# -gt 0 ]]; do
    case "$1" in
        --seed)
            SEED="$2"; shift 2 ;;
        --seed=*)
            SEED="${1#*=}"; shift ;;
        --rebuild)
            PARSED_ARGS+=("--rebuild"); shift ;;
        *)
            echo "Unknown arg: $1" >&2; exit 1 ;;
    esac
done

# Recover rebuild flag positionally for later logic
if printf '%s\n' "${PARSED_ARGS[@]:-}" | grep -q -- '--rebuild'; then
    set -- --rebuild
else
    set --
fi

# Ensure we're in repo root (script lives at root already)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "🧪 Testing for race condition bug (seed=$SEED) - will (re)build createDoc first"

# Build TypeScript (only if needed or if --rebuild passed)
ROOT_TSCONFIG=tsconfig.json
OUT_FILE=functions/lib/scripts/createDoc.js
SRC_FILE=functions/scripts/createDoc.ts

if [[ "${1:-}" == "--rebuild" ]]; then
    echo "♻️  Forced rebuild requested"
    npm run build >/dev/null
elif [[ ! -f "$OUT_FILE" ]]; then
    echo "📦 No compiled createDoc.js found. Building..."
    npm run build >/dev/null
elif [[ "$SRC_FILE" -nt "$OUT_FILE" ]]; then
    echo "🛠  Source newer than build. Rebuilding..."
    npm run build >/dev/null
else
    echo "✅ Existing build is up to date (pass --rebuild to force)"
fi

if [[ ! -f "$OUT_FILE" ]]; then
    echo "❌ Build failed: $OUT_FILE still missing" >&2
    exit 1
fi

echo "🚀 Starting iterations"

# Provide a quick emulator env summary
export GOOGLE_CLOUD_PROJECT=${GOOGLE_CLOUD_PROJECT:-firebase-cli-emulator-race-condition-repro}
export TEST_SEED="$SEED"
echo "ENV CHECK -> PROJECT=$GOOGLE_CLOUD_PROJECT SEED=$TEST_SEED FIRESTORE_EMULATOR_HOST=${FIRESTORE_EMULATOR_HOST:-unset} FIREBASE_STORAGE_EMULATOR_HOST=${FIREBASE_STORAGE_EMULATOR_HOST:-unset} STORAGE_EMULATOR_HOST=${STORAGE_EMULATOR_HOST:-unset}"

# Deterministic pseudo-random generator (LCG) -> sets global variable _SEED_STATE
_SEED_STATE=$SEED
prng_next() {
    # LCG params (glibc-esque)
    _SEED_STATE=$(( (1103515245 * _SEED_STATE + 12345) % 2147483648 ))
    echo $_SEED_STATE
}
prng_float() {
    local v=$(prng_next)
    # Scale to 0.00 - 1.00 (two decimals) deterministically
    awk -v val="$v" 'BEGIN { printf "%.2f", (val/2147483648) }'
}

for i in {1..20}; do
        echo ""
        echo "🔄 Iteration $i/20"
        echo "-------------------"

        # Run the trigger (set both legacy & current env vars for safety)
        FIRESTORE_EMULATOR_HOST=${FIRESTORE_EMULATOR_HOST:-127.0.0.1:8080} \
        FIREBASE_STORAGE_EMULATOR_HOST=${FIREBASE_STORAGE_EMULATOR_HOST:-127.0.0.1:9199} \
        STORAGE_EMULATOR_HOST=${STORAGE_EMULATOR_HOST:-127.0.0.1:9199} \
        ITERATION=$i \
        node "$OUT_FILE"

        # Wait a moment for all events to process
        sleep 2

        # Add some randomness to timing
        sleep_time=$(prng_float)
        echo "⏱  sleep $sleep_time s (deterministic)"
        sleep "$sleep_time"
done

echo ""
echo "✅ Completed 20 iterations"
echo "🔍 Check logs above for any 'CRITICAL BUG DETECTED' messages"
echo "🔍 Also check for Storage events appearing in createBeforeSnapshot logs"
