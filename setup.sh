#!/bin/bash
# Run after clone or submodule update
cd "$(dirname "$0")"
git submodule update --init --recursive
(cd packages/pi-amplike && npm install)
(cd packages/pi-sub && npm install)
