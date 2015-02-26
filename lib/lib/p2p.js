// p2p.js
// Peer to peer stuff to guide sessions
//

var Peer = require('peerjs');
var EventEmitter = require("events").EventEmitter;
var util = require('./util');
var u = require('util');

var baseUrl = "http://thor.udayv.com:2379/v2/keys/";

var P2PNode = function(name) {
    this.nodeName = name;
    this.peer = null;

    var peer = new Peer({host: 'thor.udayv.com', port: 9000, key: 'hobu', debug: 3});
    var o = this;
    peer.on("open", function() {
        o.peer = peer;
        o.emit("ready", o);
    });

    peer.on("error", function() {
        o.emit("error", o);
    });

    peer.on("connection", function(conn) {
        conn.on("open", function() {
            o._attachProtocol(conn);
        });
    });
};

u.inherits(P2PNode, EventEmitter);

P2PNode.prototype.join = function(session) {
    if (!this.peer)
        throw new Error("This peer instance is not ready yet, cannot join a swarm");

    var o = this;

    o.swarm = {
        name: session,
        conns: []
    };

    this._establishConnectivity(function() {
        var id = o.peer.id;

        // keep pushing our info to keep the swarm open to new connections
        var pushEntry = function() {
            util.put(baseUrl + session + "/" + id + "?ttl=25", {value: id}, function() {
                o.swarm.refreshId = setTimeout(pushEntry, 10000 + Math.random() * 10000);
            });
        };
        pushEntry();

        o.swarm.metaUpdateId = setInterval(function() {
            o._send({
                type: "whoami",
                name: o.nodeName
            });
        }, 10000);
    });

};

P2PNode.prototype.leave = function() {
    var o = this;

    if (o.swarm) {
        var s = o.swarm;
        o.swarm = null;

        clearTimeout(s.refreshId);
        clearTimeout(s.metaUpdateId);

        for (var k in s.conns) {
            var c = s.conns[k];
            c.close();
        }

        o.emit("left", o);
    }
};

P2PNode.prototype.transferOwnership = function(to, props) {
    var o = this;

    if (!o.swarm)
        throw new Error("Cannot transfer ownership when not in swarm");

    var packet = {
        type: "ownership-transfer",
        recipient: to,
        props: props
    };

    o._send(packet);

    // finally release our own ownership
    setTimeout(function() {
        o._setOwner(to);
    });
};

P2PNode.prototype._send = function(obj) {
    var o = this;

    for (var k in o.swarm.conns) {
        var c = o.swarm.conns[k];
        c.send(obj);
    }
};

P2PNode.prototype.broadcastState = function(state) {
    var o = this;

    if (!o.swarm)
        throw new Error("Cannot broadcast state when not in a swarm");

    if (o.swarm.owner !== o.peer.id)
        throw new Error("Can only broadcast state when owner in a swarm");

    o._send({
        type: "state",
        state: state
    });
};

P2PNode.prototype._establishConnectivity = function(f) {
    // the goal here is to connect to at least one node in the swarm
    //
    var o = this;

    var meAndBail = function() {
        util.put(baseUrl + o.swarm.name + "/" + o.peer.id, {value: o.peer.id}, function(err) {
            if (err) return f(err);
            o.emit("joined", o); // we are the only ones here, so we joined it!

            o._setOwner(o.peer.id);

            return f();
        });
    };

    var tries = Math.floor(2 + Math.random() * 5);

    var tryToConnect = function() {
        var url = baseUrl + o.swarm.name;

        util.get(url, function(err, res) {
            res = err ? {} : JSON.parse(res);

            if (!res.node || !res.node.nodes) {
                // no listing of nodes, we are ze boss
                return meAndBail();
            }

            // there is a listing of nodes, try to connect in order we the most recently added first
            var nodes = res.node.nodes;
            nodes.sort(function(a, b) {
                return a.modifiedIndex - b.modifiedIndex;
            });

            var joinInitiated = false;
            var timeout = setTimeout(function() {
                tries --;
                if (tries === 0) {
                    joinInitiated = true;
                    meAndBail();
                }
                else {
                    console.log("Retrying...", tries);
                    setTimeout(tryToConnect);
                }
            }, 1000 + Math.random() * 4000);

            nodes = nodes.slice(0, 10).map(function(n) { return n.value; });
            nodes.forEach(function(n) {
                var c = o._connect(n);

                c.on("open", function() {
                    clearTimeout(timeout);

                    if (!joinInitiated) {
                        joinInitiated = true;
                        o._initiateJoin(c);

                        f();
                    }
                    else {
                        o._attachProtocol(c);
                    }
                });
            });
        });
    };

    tryToConnect();
};

P2PNode.prototype._setOwner = function(id, props) {
    var o = this;

    if (o.swarm) {
        if (id !== o.swarm.owner) {
            o.swarm.owner = id;
            if (id === o.peer.id)
                o.emit("self-owner", o, props);
            else
                o.emit("owner", o, id);
        }
    }
};

P2PNode.prototype._attachProtocol = function(c) {
    var o = this;
    var conn = c;
    var id = conn.peer;

    if (!o.swarm)
        return conn.close(); // don't handle connections if we are not in a swarm

    o.swarm.conns[id] = conn;

    // notify that we have a new peer
    setTimeout(function() {
        o.emit("peer-joined", o, id);
    });

    conn.on("data", function(data) {
        if (data.type === "helo") {
            var response = {
                type: "oleh",
                roster: Object.keys(o.swarm.conns),
                owner: o.swarm.owner,
                name: o.nodeName
            };

            o.swarm.conns[id].send(response);
        }
        else if (data.type === "oleh") {
            if (!o.swarm.conns[data.owner]) {
                var conn = o._connect(data.owner);
                o._attachProtocol(conn);
            }

            o._setOwner(data.owner);
        }
        else if (data.type === "ownership-transfer") {
            var newOwner = data.recipient;
            var props = data.props;
            o._setOwner(newOwner, props);
        }
        else if(data.type === "whoami") {
            o.emit("peer-name", o, id, data.name);
        }
        else if (data.type === "state") {
            o.emit("state", o, data.state);
        }
    });

    var bail = function() {
        if (!o.swarm)
            return;

        // The owner is leaving
        if (o.swarm.owner === id)
            o.leave();
        else {
            // someone else is leaving, notify that someone is leaving
            o.emit("peer-left", o, id);
        }
    };

    conn.on("close", bail);
    conn.on("error", bail);
};

P2PNode.prototype._initiateJoin = function(conn) {
    // first notify that we're in since we could connect to at least one node
    this.emit("joined", this);

    this._attachProtocol(conn);
    conn.send({
        type: "helo",
    });
};

P2PNode.prototype._connect = function(to) {
    return this.peer.connect(to, {serialization: 'json'});
};

module.exports = {
    P2PNode: P2PNode
};
