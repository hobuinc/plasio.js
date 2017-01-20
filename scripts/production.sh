#!/bin/bash
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

echo " :: Building renderer (cljs) ..."
cd renderer && lein clean && lein cljsbuild once release && cd .. ;

echo " :: Building lib ..."
cd lib && ./node_modules/.bin/webpack --build --optimize-minimize && cd .. ;


echo " :: Preparing for staging ..."
mkdir $TARGETDIR

cp -v \
    renderer/target/rel/renderer.cljs.js \
    $TARGETDIR

cp -v lib/dist/plasio.js $TARGETDIR/

echo " :: Cleaning up ..."
cd renderer && lein clean && cd ..

echo "Done."
