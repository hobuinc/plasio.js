#!/bin/sh

cat ./vendor/THREE.js \
    ./vendor/THREE.BinaryLoader.js \
    ./vendor/gl-matrix.js \
    $1/renderer.js > plasio-renderer.js
echo "Wrote plasio-renderer.js"
