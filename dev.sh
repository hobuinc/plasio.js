#!/bin/sh
# development script

SESSION_NAME=plasio-js-dev
PWD=`pwd`

# move vendor stuff to dist
mkdir -p lib/dist
cp lib/lib/vendor/* lib/dist/

cd lib && npm install && cd ..

./lib/node_modules/.bin/nf start
