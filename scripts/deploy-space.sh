#!/usr/bin/env bash
#
# Deploy Squeeze to a Hugging Face Space (free, no credit card).
#
#   1. Create a free account at https://huggingface.co
#   2. Create an access token with "write" scope:
#      https://huggingface.co/settings/tokens
#   3. Run:
#        HF_TOKEN=hf_xxx ./scripts/deploy-space.sh <your-username> [space-name]
#
# Re-running is safe: it rebuilds the bundle and force-pushes the Space repo.
set -euo pipefail

USER_NAME="${1:-}"
SPACE_NAME="${2:-squeeze}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUNDLE="$ROOT/dist/hf-space"

if [[ -z "$USER_NAME" ]]; then
  echo "usage: HF_TOKEN=hf_xxx ./scripts/deploy-space.sh <hf-username> [space-name]" >&2
  exit 64
fi

if [[ -z "${HF_TOKEN:-}" ]]; then
  echo "HF_TOKEN is not set." >&2
  echo "Create one at https://huggingface.co/settings/tokens (write scope), then:" >&2
  echo "  HF_TOKEN=hf_xxx ./scripts/deploy-space.sh $USER_NAME $SPACE_NAME" >&2
  exit 64
fi

echo "==> Building the Space bundle"
node "$ROOT/scripts/package-space.js" "$BUNDLE"

cd "$BUNDLE"
rm -rf .git

echo "==> Preparing the Space repository"
git init -q -b main
git add -A
git -c user.name="squeeze-deploy" -c user.email="deploy@squeeze.local" \
  commit -qm "Squeeze: compress videos from a link"

# The Space may not exist yet; creating it through the API keeps this a one-liner.
echo "==> Making sure the Space exists"
curl -sS -o /dev/null -X POST "https://huggingface.co/api/repos/create" \
  -H "Authorization: Bearer $HF_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"$SPACE_NAME\",\"type\":\"space\",\"sdk\":\"docker\",\"private\":false}" \
  || true

echo "==> Pushing the app"
git push --quiet --force \
  "https://${USER_NAME}:${HF_TOKEN}@huggingface.co/spaces/${USER_NAME}/${SPACE_NAME}" main

URL="https://${USER_NAME}-${SPACE_NAME}.hf.space"
echo
echo "Deployed. The Space builds for a few minutes, then:"
echo "  App          $URL"
echo "  Diagnostics  $URL/diagnostics"
echo
echo "Verify it once the build finishes:"
echo "  node scripts/verify-deploy.js $URL"
