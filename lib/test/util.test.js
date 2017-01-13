var expect = require('expect.js');
var util = require('../lib/util');

describe('utils', function() {
    describe('parseBrushSpec', function() {
        const tf = util.parseBrushSpec;

        it('should fail when multiple parameters sections exist', function() {
            expect(() => {
                tf('local://color?what=hello?why=hello');
            }).to.throwError();
        });

        it('should fail when base section is malformed', function() {
            expect(() => {
                tf('local://?what=hello?why=hello');
            }).to.throwError();

            expect(() => {
                tf('://?what=hello?why=hello');
            }).to.throwError();

            expect(() => {
                tf('what:/color?what=hello?why=hello');
            }).to.throwError();

            expect(() => {
                tf('what:\/color?what=hello?why=hello');
            }).to.throwError();
        });

        it('should fail when parameters syntax is invalid', function() {
            expect(() => tf('local://what?a&b=1')).to.throwError();
        });

        it('should parse non-parametrized spec correctly', function() {
            const r = tf('local://color');

            expect(r).to.have.property('scheme', 'local');
            expect(r).to.have.property('name', 'color');
            expect(r.params).to.eql({});
        });

        it('should parse parametrized spec correctly', function() {
            const r = tf('local://color?a=1&b=1');

            expect(r).to.have.property('scheme', 'local');
            expect(r).to.have.property('name', 'color');
            expect(r.params).to.eql({a: '1', b: '1'});
        });

        it('should parse specs with no value correctly', function() {
            const r = tf('local://window?a=1&b=&c=2');

            expect(r.params).to.eql({a: '1', b: null, c: '2'});
        });

        it('should parse specs with array type value correctly', function() {
            const r = tf('local://window?a=1&a=&b=2&b=4');
            expect(r.params).to.eql({a: ['1'], b: ['2', '4']});
        });

        it('should handle encoded parameters', function() {
            const url = encodeURIComponent('https://www.google.com/webhp?sourceid=chrome-instant&ion=1&espv=2&ie=UTF-8#q=such%20wow');
            const r = tf('local://window?a=1&a=&b=2&b=4&url=' + url);
            expect(r.params).to.eql({a: ['1'], b: ['2', '4'], url: url});

        });
    });

    describe('minmax', function() {
        const tf = util.minmax;
        it('should work as expected', function() {
            let [n1, m1] = tf([]);
            expect(n1).to.eql(Number.MAX_SAFE_INTEGER);
            expect(m1).to.eql(Number.MIN_SAFE_INTEGER);

            let [n2, m2] = tf([1, 2, 3]);
            expect(n2).to.eql(1);
            expect(m2).to.eql(3);

            let [n3, m3] = tf([3, 200, 0]);
            expect(n3).to.eql(0);
            expect(m3).to.eql(200);
        });
    });

    describe('enclosesBounds', function() {
        const tf = util.enclosesBounds;
        it('should work as expected', function() {
            expect(tf([-50, -50, -50, 50, 50, 50], [-25, -25, -25, 25, 25, 25])).to.equal(true);
            expect(tf([-50, -50, -50, 50, 50, 50], [0, 0, 0, 25, 25, 25])).to.equal(true);
            expect(tf([-50, -50, -50, 50, 50, 50], [0, 0, 0, 50, 50, 50])).to.equal(true);
            expect(tf([-50, -50, -50, 50, 50, 50], [0, 0, 0, 51, 50, 50])).to.equal(false);
            expect(tf([-50, -50, -50, 50, 50, 50], [-50, -50, -50, 0, 0, 0])).to.equal(true);
            expect(tf([-50, -50, -50, 50, 50, 50], [-50, -51, -50, 0, 0, 0])).to.equal(false);
            expect(tf([-50, -50, -50, 50, 50, 50], [-50, -50, -50, 50, 50, 50])).to.equal(true);
        });
    });

    describe('equalBounds', function() {
        const tf = util.equalBounds;
        it('should work as expected', function() {
            expect(tf([-50, -50, -50, 50, 50, 50], [-25, -25, -25, 25, 25, 25])).to.equal(false);
            expect(tf([-50, -50, -50, 50, 50, 50], [-50, -50, -50, 50, 50, 50])).to.equal(true);
        });
    });

    describe('accumulateStats', function() {
        const tf = util.accumulateStats;
        it('should work as expected', function() {
            let o = {
                'z': {"-10": 100, "0": 200},
                'y': {"-500": 0}
            };

            o = tf(o, {
                'z': {"-10": 1, "10": 5},
                'y': {"100": 10},
                'x': {"-212": 10}
            });

            expect(o['z']['-10']).to.equal(101);
            expect(o['z']['0']).to.equal(200);
            expect(o['y']['100']).to.equal(10);
            expect(o['y']['-500']).to.equal(0);
            expect(o['x']['-212']).to.equal(10);
        });

        it('should work as expected when original is empty', function() {
            let o = {};

            o = tf(o, {
                'z': {"-10": 1, "10": 5},
                'y': {"100": 10},
                'x': {"-212": 10}
            });

            expect(o['z']['-10']).to.equal(1);
            expect(o['y']['100']).to.equal(10);
            expect(o['x']['-212']).to.equal(10);
        });
    });

    describe('pickOne', function() {
        const tf = util.pickOne;

        it('should not do anything to a string with no replacements', () => {
            expect(tf('hello-world')).to.equal('hello-world');
            expect(tf('')).to.equal('');
        });

        it('should correctly parse and return an extrapolated string', () => {
            expect(tf('hello[1-1]-world')).to.equal('hello1-world');
        });

        it('should correctly parse more than one replacement and return an extrapolated string', () => {
            expect(tf('hello[1-1]-w[2-2]orld')).to.equal('hello1-w2orld');
        });

        it('should fail when the range is invalid', () => {
            expect(() => {
                tf('hello[2-1]-w[2-2]orld')
            }).to.throwError(/Invalid range/);
        });

        it('should not do anything for incomplete patterns', () => {
            expect(tf('hello[1-1-w[2-2]orld')).to.equal('hello[1-1-w2orld');
            expect(tf('hello[1-1-w2-2]orld')).to.equal('hello[1-1-w2-2]orld');
        });
    })
});