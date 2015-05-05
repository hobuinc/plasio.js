plasio.js
===

Much awesome!

How to get this awesomary to work?
===

Install these things:

  - Nodejs and NPM
  - `npm install -g grunt`
  - `npm install -g http-server`
  - Install leiningen (http://leiningen.org/)
  - Make sure you have tmux (use brew may be)

Then,

```
$ cd lib ; npm install ; cd ..
$ cd workers ; npm install ; cd ..
```

Finally to start all of it up:

`$ ./dev.sh`

tmux will (should) launch with 4 split panes. Wait for all text panes to settle down (Clojure one looks like its settled, but wait till you see a green message with "compiled successfully" message).  If it doesn't look at `dev.sh` and try to run the commands individually to find the one which is failing.

Now go to `localhost:3000` and you shall witness awesomary.
