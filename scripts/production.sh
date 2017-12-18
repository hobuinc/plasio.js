#!/bin/bash
# stage files correctly for deploying iowa-lidar stuff
#

PWD=`pwd`
TARGETDIR=$PWD/dist

if [ "$1" != "--no-confirm" ] ; then
        echo "Will reset the target directory: $TARGETDIR, press a key to begin..."
        read
fi

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
cp -v lib/dist/plasio.webworker.js $TARGETDIR/
cp -v lib/dist/plasio.color.webworker.js $TARGETDIR/
cp -v lib/lib/vendor/laz-perf.asm.js $TARGETDIR/
cp -v lib/lib/vendor/laz-perf.asm.js.mem $TARGETDIR/
cp -v lib/lib/vendor/laz-perf.js $TARGETDIR/
cp -v lib/lib/vendor/laz-perf.wasm $TARGETDIR/

echo " :: Cleaning up ..."
cd renderer && lein clean && cd ..

echo "Done."
