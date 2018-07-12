#!/bin/bash
#

DIRNAME="$1"
shift

if [ "$DIRNAME" == "" ] ; then
    echo "No directory name provided"
    exit 1
fi

set -x

docker run -v `pwd`:/data connormanning/entwine:ept build \
   -i http://s3.amazonaws.com/entwine.io/sample-data/autzen.laz \
   -o /data/ept/$DIRNAME \
   $*
