#!/bin/bash
# <xbar.title>Savant pulse pill</xbar.title>
# <xbar.desc>Equity, positions, breakers and regime of the Savant trading agent (read-only).</xbar.desc>
# <xbar.dependencies>curl</xbar.dependencies>
# <swiftbar.hideRunInTerminal>true</swiftbar.hideRunInTerminal>
#
# macOS menu bar widget for SwiftBar (https://swiftbar.app) or xbar. Read-only: it can't trade or change anything.
# Setup: put the worker URL and the read-only PILL_TOKEN in ~/.cortex54-pill (two lines: URL, then token),
# chmod 600 it, then drop this file into the SwiftBar plugin folder. The "30s" in the name is the refresh rate.
CONF="${HOME}/.cortex54-pill"
if [ ! -f "$CONF" ]; then
  echo "⚪ C54"
  echo "---"
  echo "Create ~/.cortex54-pill (line 1: https://cortex.<you>.workers.dev, line 2: PILL_TOKEN)"
  exit 0
fi
URL=$(sed -n 1p "$CONF")
TOKEN=$(sed -n 2p "$CONF")
OUT=$(curl -fsS --max-time 8 -H "authorization: Bearer ${TOKEN}" "${URL%/}/pill?format=swiftbar" 2>/dev/null)
if [ -z "$OUT" ]; then
  echo "🔴 C54 offline"
  echo "---"
  echo "Could not reach ${URL%/}/pill"
  echo "Refresh | refresh=true"
else
  printf '%s\n' "$OUT"
fi
