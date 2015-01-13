// p2p.js
// Peer to peer stuff to guide sessions
//

var Peer = require('peerjs');
var EventEmitter = require("events").EventEmitter;

var P2PNode = function(name) {
    this.nodeName = name;
    this.peer = null;
};

P2PNode.key = null;

var validateSettings = function() {
    var key = P2PNode.key;
    if (!key)
        throw new Error("You don't have an API key defined, set P2PNode.key to a valid peer.js API key");

    return { key: key };
};

P2PNode.prototype.startBroadcast = function() {
    if (this.peer !== null)
        throw new Error("Cannot start as broadcaster if this node is already active");

    var s = validateSettings();

    this.peer = new Peer(this.nodeName, {key: s.key});
    this.bstate = {
        conns: {}
    };

    conns = this.bstate.conns;
    var o = this;
    
    o.peer.on('connection', function(conn) {
        var id = conn.peer;

        conn.on('open', function() {
            console.log("server open");
            conns[id] = conn;

            // a new connection came in, send our state over
            if (o.bstate.lastSentState)
                conn.send(o.bstate.lastSentState);
        });
        
        conn.on('data', function(data) {
            console.log("data from conn", conn, data);
        });

        conn.on('error', function() {
            delete conns[id];
        });

        conn.on('close', function() {
            delete conns[id];
        });
    });
};

P2PNode.prototype.stop = function() {
    if (this.bstate) {
        var s = this.bstate;
        
        for(var k in s.conns) {
            s.conns[k].close();
        }

        this.bstate = null;
    }

    if (this.cstate) {
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

    var d = JSON.stringify(data);

    var bstate = this.bstate;

    console.log("connections: ", bstate.conns);

    for (var k in bstate.conns) {
        var conn = bstate.conns[k];
        conn.send(d);
    }

    this.bstate.lastSentState = d;
};

P2PNode.prototype.startAsClient = function(ownerName) {
    var e = new EventEmitter();

    if (this.peer !== null)
        throw new Error("Cannot start as client if this node is already active");

    var s = validateSettings();
    var o = this;

    this.peer = new Peer(this.nodeName, {key: s.key});
    var conn = this.peer.connect(ownerName);

    conn.on('open', function() {
        console.log("open");
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
        e.emit('state', JSON.parse(data));
    });

    return e;
};

module.exports = {
    P2PNode: P2PNode
};
