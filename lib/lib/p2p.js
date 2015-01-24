// p2p.js
// Peer to peer stuff to guide sessions
//

var Peer = require('peerjs');
var EventEmitter = require("events").EventEmitter;
var util = require('./util');
var u = require('util');

var Session = function(name) {
    this.baseUrl = "http://localhost:2379/v2/keys/" + name;

    // start the look which continously polls for owner changes
    
    var o = this;
    o.lastOwner = null;
    var checkOwner = function(nowait) {
        var url = o.baseUrl + "/owner";
        if (!nowait) url += "?wait=true";
        
        util.get(url, function(err, res) {
            var r = JSON.parse(res);

            console.log("---------------------- VAL:", r);

            if (r.node && r.node.value && r.node.value !== o.lastOwner) {
                // new owner
                o.lastOwner = r.node.value;
                o.emit("new-owner", o.lastOwner);
            }

            setTimeout(checkOwner, 1000);
        });
    };

    setTimeout(checkOwner.bind(null, true));
};

u.inherits(Session, EventEmitter);

Session.prototype.setOwner = function(owner, cb) {
    util.put(this.baseUrl + "/owner", {value: owner}, cb);
};

var P2PNode = function(session, name) {
    this.session = session;
    this.nodeName = name;
    this.peer = null;
};

P2PNode.prototype.savePeer = function(name, id, cb) {
    var url = this.session.baseUrl + "/peers/" + name;
    util.put(url, { value: id }, function(err) {
        cb(err);
    });
};

P2PNode.prototype.getPeer = function(name, cb) {
    var url = this.session.baseUrl + "/peers/" + name;
    util.get(url, function(err, body) {
        if(err) return cb(err);

        var b = JSON.parse(body);
        return cb(null, b.node.value);
    });
};


var HANDOFF_INVALID = 0;
var HANDOFF_WAITING_RESPONSE = 1;

P2PNode.prototype.makePeer = function(name, cb) {
    var peer = new Peer({
        host: 'localhost',
        port: 9000,
        path: '/',
        key: 'hobu',
        debug: 3
    });

    var o = this;
    peer.on("open", function(id) {
        o.savePeer(name, id, function(err) {
            if (err) return cb(err);
            return cb(null, peer);
        });
    });
};

P2PNode.prototype.startBroadcast = function(startupProps) {
    if (this.peer !== null)
        throw new Error("Cannot start as broadcaster if this node is already active");

    var o = this;
    this.makePeer(this.nodeName, function(err, peer) {
        if (err) return console.log("ERROR:", err);
        o.peer = peer;

        o.session.setOwner(peer.id, function() {
            o.bstate = {
                conns: {}
            };

            conns = o.bstate.conns;

            if (o.onowner)
                o.onowner(startupProps);

            o.peer.on('connection', function(conn) {
                var id = conn.peer;
                var name = conn.metadata.name;

                conn.on('open', function() {
                    console.log("server open", conn, name);
                    conns[id] = {conn: conn, id: id, name: name};

                    // a new connection came in, send our state over
                    if (o.bstate.lastSentState)
                        o.send({
                            type: "state",
                            state: o.bstate.lastSentState
                        }, conn);
                });

                conn.on('data', function(data) {
                    var d = JSON.parse(data);
                    console.log("owner:", d);

                    if (d.type === "handoff-response" &&
                        o.handoffState === HANDOFF_WAITING_RESPONSE) {
                        // we have a handoff in progress and this is the first response we have received
                        //
                        o.handoffState = HANDOFF_INVALID;
                        var f = function(props) {
                            o.send({
                                type: "handoff-candidate",
                                owner: name,
                                props: props
                            }, conn);

                            setTimeout(function() {
                                o.stop();
                                o.startAsClient(name);
                            });
                        };

                        // if we have a handoff transfer handler, the user wants to transmit props
                        // over to the new owner


                        if (o.onhandofftransfer) {
                            o.onhandofftransfer(f);
                        }
                        else {
                            setTimeout(f);
                        }
                    }
                });

                conn.on('error', function() {
                    delete conns[id];
                });

                conn.on('close', function() {
                    delete conns[id];
                });
            });
        });
    });
};

P2PNode.prototype.stop = function() {
    if (this.bstate) {
        var s = this.bstate;
        
        for(var k in s.conns) {
            s.conns[k].conn.close();
        }

        this.bstate = null;
    }

    if (this.cstate) {
        this.cstate.conn.close();
        this.cstate = null;
    }

    if (this.peer) {
        this.peer.destroy();
        this.peer = null;
    }
};

P2PNode.prototype.broadcastState = function(data) {
    if (!this.peer || !this.bstate) {
        throw new Error("Cannot send data, make sure you have an active peer and are broadcasting");
    }

    var msg = {
        type: "state",
        state: data
    };

    this.send(msg);
    this.bstate.lastSentState = data;
};

P2PNode.prototype.startAsClient = function(ownerName) {
    var e = new EventEmitter();

    if (this.peer !== null)
        throw new Error("Cannot start as client if this node is already active");

    var o = this;

    this.makePeer(this.nodeName, function(err, peer) {
        if (err) return console.log("ERROR:", err);

        o.peer = peer;

        if (o.onviewer)
            o.onviewer(e);

        var setupClient = function(owner) {
            if (err) return console.log("ERROR:", err);

            if (owner === o.peer.id)
                return; // we are the owner, so don't do any client side stuff
            
            var conn = o.peer.connect(owner, {metadata: {name: o.nodeName}}); 

            conn.on('open', function() {
                o.cstate = { conn: conn };
                e.emit('open');
            });

            conn.on('close', function() {
                console.log("close");
                o.cstate = null;
                e.emit('close');
            });

            conn.on('error', function() {
                console.log("error");
                o.cstate = null;
                e.emit('error');
            });

            conn.on('data', function(data) {
                var d = JSON.parse(data);
                console.log(d);
                
                if (d.type === "state") {
                    e.emit('state', d.state);
                }
                else if (d.type === "handoff") {
                    if (o.onwanthandoffcontrol) {
                        var handoffResponse = function(v) {
                            if (v) {
                                o.send({
                                    type: "handoff-response"
                                });
                            }
                        };

                        o.onwanthandoffcontrol(handoffResponse);
                    }
                }
                else if (d.type === "handoff-candidate") {
                    var handoffProps = d.props;
                    console.log("+++++++++++++++++++++ RECV:", handoffProps);

                    setTimeout(function() {
                        o.stop();
                        if (d.owner === o.nodeName)
                            o.startBroadcast(d.props);
                    });
                }
            });
        };

        console.log("yay", o.session.lastOwner);

        if (o.session.lastOwner) {
            setupClient(o.session.lastOwner);
        }

        o.session.on("new-owner", setupClient);
    });

    return e;
};

P2PNode.prototype.send = function(obj, onlyto) {
    var pl = JSON.stringify(obj);

    if (this.bstate) {
        if (onlyto) {
            onlyto.send(pl);
        }
        else {
            for (var k in this.bstate.conns) {
                this.bstate.conns[k].conn.send(pl);
            }
        }
    }

    if (this.cstate) {
        this.cstate.conn.send(pl);
    }
};


P2PNode.prototype.startHandoff = function(complete) {
    if (!this.peer || !this.bstate) {
        throw new Error("Cannot start handoff, make sure you have an active peer and are broadcasting");
    }

    this.handoffState = HANDOFF_WAITING_RESPONSE;

    var req = {
        type: "handoff"
    };

    this.send({
        type: "handoff"
    });
};

module.exports = {
    Session: Session,
    P2PNode: P2PNode
};
