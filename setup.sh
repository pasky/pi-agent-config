#!/bin/bash
# Run after clone or submodule update
cd "$(dirname "$0")"
git config core.hooksPath .githooks
git submodule update --init --recursive
(cd packages/pi-amplike && npm install)
(cd packages/pi-sub && npm install)
(cd packages/chrome-cdp-skill && npm install)
