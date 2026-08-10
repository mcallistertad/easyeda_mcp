#!/bin/zsh

set -eu

editor_process="${EASYEDA_MCP_EDITOR_PROCESS:-EasyEDA-Pro}"
host_process="${EASYEDA_MCP_HOST_PROCESS:-ChatGPT}"
host_bundle_id="${EASYEDA_MCP_HOST_BUNDLE_ID:-com.openai.codex}"

if ! /usr/bin/pgrep -x "$editor_process" >/dev/null 2>&1; then
  exit 0
fi

if /usr/bin/pgrep -x "$host_process" >/dev/null 2>&1; then
  exit 0
fi

echo "$(/bin/date -u +%Y-%m-%dT%H:%M:%SZ) EasyEDA is running; starting the MCP host ($host_bundle_id)."
/usr/bin/open -gj -b "$host_bundle_id"
