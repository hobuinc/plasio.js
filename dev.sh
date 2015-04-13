#!/bin/sh
# development script

SESSION_NAME=plasio
PWD=`pwd`

tmux has-session -t $SESSION_NAME
if [ $? != 0 ] ; then
    tmux new-session -d -s $SESSION_NAME -c $PWD/lib 'npm run dev'
    tmux split-window -v -t $SESSION_NAME -c $PWD/workers 'gulp watch'
    tmux split-window -v -t $SESSION_NAME -c $PWD/renderer 'lein cljsbuild auto dev'
    tmux split-window -v -t $SESSION_NAME 'env PORT=3000 http-server'
fi

tmux attach -t $SESSION_NAME
