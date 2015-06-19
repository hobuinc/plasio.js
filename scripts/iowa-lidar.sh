#!/bin/sh
# stage files correctly for deploying iowa-lidar stuff
#

PWD=`pwd`
TARGETDIR=$PWD/iowa-lidar

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

echo " :: Copying files ..."

cp -v resources/index-iowa-lidar.html $TARGETDIR/index.html

cp -v \
    resources/hobu.png \
    renderer/plasio-renderer.js \
    $TARGETDIR


cp -v lib/dist/* $TARGETDIR/lib/dist
cp -v workers/decompress.js $TARGETDIR/workers

echo " :: Cleaning up ..."
cd renderer && lein clean && cd ..


S3_CREDS=$HOME/.s3env-iowa-lidar

if [ ! -f "$S3_CREDS" ] ; then
    echo " :: S3 Credentials for iowa lidar upload are missing, will not do S3 sync."
    exit 0
else
    source $HOME/.s3env-iowa-lidar
fi

echo " :: Syncing with S3 ..."
cd $TARGETDIR && s3cmd --access_key=$ACCESS_KEY --secret_key=$SECRET_KEY --delete-removed -P sync . s3://iowalidar.com/

echo "Done."
