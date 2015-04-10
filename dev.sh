#!/bin/sh
# development script

SESSION_NAME=plasio

tmux has-session -t $SESSION_NAME
if [ $? != 0 ] ; then
    tmux new-session -d -s $SESSION_NAME -c lib 'npm run dev'
    tmux split-window -v -t $SESSION_NAME -c workers 'gulp watch'
    tmux split-window -v -t $SESSION_NAME -c renderer 'lein cljsbuild auto dev'
    tmux split-window -v -t $SESSION_NAME 'env PORT=3000 http-server'

    # out of this project but start building plasio-ui as well
    if [ -d "../plasio-ui" ] ; then
        tmux split-window -v -t $SESSION_NAME -c ../plasio-io 'lein cljsbuild auto dev'
    fi
fi

tmux attach -t $SESSION_NAME
