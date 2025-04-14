#!/bin/bash

# This script updates all logger component names to the new standardized format
# It removes V2 suffixes and converts to lowercase with dot notation

echo "Updating logger component names to standardized format..."

# Directory containing the code
SRC_DIR="packages/sync-test/src"

# Old to new name mappings
declare -A REPLACEMENTS=(
  ["EntityChanges:ApplierV2"]="entity-changes.applier"
  ["EntityChanges:ValidationV2"]="entity-changes.validation"
  ["EntityChanges:TrackerV2"]="entity-changes.tracker"
  ["EntityChanges:BatchChangesV2"]="entity-changes.batch"
  ["EntityChanges:BuilderV2"]="entity-changes.builder"
  ["EntityChanges:StateManager"]="entity-changes.state"
  ["Runner"]="sync.runner"
  ["api-service"]="sync.api"
  ["websocket-connection"]="sync.websocket"
  ["ProfileMgr"]="sync.profile"
  ["ws-client-factory"]="sync.ws-client"
  ["streamlined-live-sync"]="sync.live-sync"
)

# Process each replacement
for OLD_NAME in "${!REPLACEMENTS[@]}"; do
  NEW_NAME="${REPLACEMENTS[$OLD_NAME]}"
  echo "Replacing '$OLD_NAME' with '$NEW_NAME'..."
  
  # Find and replace in all TypeScript files
  find "$SRC_DIR" -type f -name "*.ts" -exec sed -i "s/createLogger(['\"]$OLD_NAME['\"])/createLogger('$NEW_NAME')/g" {} \;
done

echo "Logger name replacements complete!" 