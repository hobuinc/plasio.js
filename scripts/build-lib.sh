#!/bin/sh
# stage files correctly for deploying iowa-lidar stuff
#

PWD=`pwd`
TARGETDIR=$PWD/dist

echo " :: Building lib ..."
cd lib && ./node_modules/.bin/webpack --build --optimize-minimize  && cd .. ;


echo " :: Prepping ..."
mkdir $TARGETDIR
mkdir -p $TARGETDIR/lib/dist
mkdir -p $TARGETDIR/workers

cp -v lib/dist/* $TARGETDIR/lib/dist
cp -v workers/decompress.js $TARGETDIR/workers

echo "Done."
