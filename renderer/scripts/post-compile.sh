#!/bin/bash

cat ./vendor/THREE.js \
    ./vendor/THREE.BinaryLoader.js \
    $1/renderer.js > plasio-renderer.js
echo "Wrote plasio-renderer.js"
echo "${@:2}" | terminal-notifier -title "cljsbuild"
