#!/bin/sh
# stage files correctly for deploying iowa-lidar stuff
#

PWD=`pwd`
TARGETDIR=$PWD/dist

echo "Will reset the target directory: $TARGETDIR, press a key to begin..."
read

if [ -d $TARGETDIR ] ; then
    echo " :: Found target dir, deleting..."
    rm -rf $TARGETDIR
fi

echo " :: Building renderer ..."
cd renderer && lein clean && lein cljsbuild once release && cd .. ;

echo " :: Building workers ..."
cd workers && gulp build-all && cd .. ;

echo " :: Building lib ..."
cd lib && ./node_modules/.bin/webpack --build && cd .. ;


echo " :: Prepping ..."
mkdir $TARGETDIR
mkdir -p $TARGETDIR/lib/dist
mkdir -p $TARGETDIR/workers

cp -v \
    renderer/plasio-renderer.js \
    $TARGETDIR


cp -v lib/dist/* $TARGETDIR/lib/dist
cp -v workers/decompress.js $TARGETDIR/workers

echo " :: Cleaning up ..."
cd renderer && lein clean && cd ..

echo "Done."
