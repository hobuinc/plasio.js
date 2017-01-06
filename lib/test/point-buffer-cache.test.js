// point-buffer-cache.test.js
//

var expect = require('expect.js');

import {
    dummyDownloadedData, boundsKey,
    FunkyColor, InverseFunkyColor,
    TreeFunkyColor
} from './test-utils';
import { compressColor } from '../lib/util';
import { PointBufferCache } from '../lib/point-buffer-cache';
import { BrushFactory } from '../lib/brush-factory';


async function pushMany(p, brushes, ...buffers) {
    var ret = [];
    for (let i = 0 ; i < buffers.length ; i ++) {
        await p.push(buffers[i], brushes, (buf) => ret.push(buf));
    }

    return ret;
}

describe('PointBufferCache', () => {
    describe('constructions', () => {
        it('sets up initial state correctly', () => {
            const p = new PointBufferCache();
            expect(p).to.have.property('nodes');
        });
    });

    describe('push', () => {
        before(() => {
            BrushFactory.registerBrush('local', 'funkycolor', FunkyColor);
            BrushFactory.registerBrush('local', 'inversefunkycolor', InverseFunkyColor);
            BrushFactory.registerBrush('local', 'treefunkycolor', TreeFunkyColor);
        });

        after(() => {
            BrushFactory.deregisterBrush('local', 'funkycolor');
            BrushFactory.deregisterBrush('local', 'inversefunkycolor');
            BrushFactory.deregisterBrush('local', 'treefunkycolor');
        });

        it('should throw an error if a required parameter is missing', (done) => {
            const p = new PointBufferCache();
            const b = dummyDownloadedData(10, []);

            p.push(b, [BrushFactory.createBrush("local://color")])
                .then(() => done(new Error('Should not succeed')))
                .catch(() => done());
        });

        it('should correctly insert a valid downloaded buffer without an error', () => {
            const p = new PointBufferCache();
            const b = dummyDownloadedData(10, []);

            b.treePath = "R";
            return p.push(b, [BrushFactory.createBrush("local://color")]);
        });

        it('processed buffer should have sane data', (done) => {
            const p = new PointBufferCache();
            const b = dummyDownloadedData(10, []);

            b.treePath = "R";

            let pb = null;
            const brushes = [BrushFactory.createBrush("local://color")];

            p.push(b, brushes, (buf) => {
                pb = buf;
            }).then(() => {
                expect(pb).to.be.a(Float32Array);
                expect(pb[0]).to.eql(b.data[0]);
                expect(pb[1]).to.eql(b.data[1]);
                expect(pb[2]).to.eql(b.data[2]);

                done();
            }).catch(done);
        });

        it('should invoke correct brush functions in correct order', () => {
            const p = new PointBufferCache();
            const b = dummyDownloadedData(10, []);
            b.treePath = "R";

            const brushes = [BrushFactory.createBrush("local://funkycolor")];

            let pb = null;
            return p.push(b, brushes, (buf) => {
                pb = buf;
            }).then(() => {
                expect(pb).to.be.a(Float32Array);
                expect(pb[0]).to.eql(b.data[0]);
                expect(pb[1]).to.eql(b.data[1]);
                expect(pb[2]).to.eql(b.data[2]);


                const events = brushes[0].events;
                const ev1 = events[0];

                expect(events).to.have.length(13); // prepare + color (10 times) + stagingAttributes + unprepare

                // first event the brush should see is prepare.
                expect(ev1[0]).to.eql('prepare');
                expect(ev1[1]).to.eql(null); // should have no parents
                expect(ev1[2]).to.eql([]);   // should have no children
                expect(ev1[3]).to.have.property('bufferStats');
                expect(ev1[3]).to.have.property('pointCloudBufferStats');
                expect(ev1[3]).to.have.property('geoTransform');
                expect(ev1[3]).to.have.property('renderSpaceBounds');
                expect(ev1[3].renderSpaceBounds).to.eql(b.renderSpaceBounds);

                // The next ten events should be point coloring for each point, and the point seen should be from our input buffer
                for (let i = 1 ; i <= 10 ; i ++) {
                    const e = events[i];
                    expect(e[0]).to.eql('colorPoint');
                    expect(e[1]).to.have.property('x', b.data[(i - 1) * 3 + 0]);
                    expect(e[1]).to.have.property('y', b.data[(i - 1) * 3 + 1]);
                    expect(e[1]).to.have.property('z', b.data[(i - 1) * 3 + 2]);
                }

                // All points and colors in output buffer should also match
                for (let i = 0 ; i < 10 ; i ++) {
                    expect(pb[i * 4 + 0]).to.eql(b.data[i * 3 + 0]);
                    expect(pb[i * 4 + 1]).to.eql(b.data[i * 3 + 1]);
                    expect(pb[i * 4 + 2]).to.eql(b.data[i * 3 + 2]);

                    expect(pb[i * 4 + 3]).to.eql(compressColor([1, 2, 3]));
                }

                // Right after coloring all the points, staging attributes should be requested
                const ev11 = events[11];
                expect(ev11[0]).to.eql('stagingAttributes');
                expect(ev11[1]).to.eql(null); // should have no parents
                expect(ev11[2]).to.eql([]);   // should have no children
                expect(ev11[3]).to.have.property('bufferStats');
                expect(ev11[3]).to.have.property('pointCloudBufferStats');
                expect(ev11[3]).to.have.property('geoTransform');
                expect(ev11[3]).to.have.property('renderSpaceBounds');
                expect(ev11[3].renderSpaceBounds).to.eql(b.renderSpaceBounds);

                // Followed by an un-prepare event
                const ev12 = events[12];
                expect(ev12[0]).to.eql('unprepare');
                expect(ev12[1]).to.have.property('bufferStats');
                expect(ev12[1]).to.have.property('pointCloudBufferStats');
                expect(ev12[1]).to.have.property('geoTransform');
                expect(ev12[1]).to.have.property('renderSpaceBounds');
                expect(ev12[1].renderSpaceBounds).to.eql(b.renderSpaceBounds);
            });
        });

        it('should invoke correct brush functions in correct order for multiple buffers', () => {
            const p = new PointBufferCache();
            const b1 = dummyDownloadedData(10, []);
            const b2 = dummyDownloadedData(10, []);
            const b3 = dummyDownloadedData(10, []);
            b1.treePath = "R";
            b2.treePath = "R1";
            b3.treePath = "R1114";

            const brushes = [BrushFactory.createBrush("local://funkycolor")];

            let pb1 = null, pb2 = null, pb3 = null;
            return p.push(b1, brushes, (buf) => {
                pb1 = buf;
            }).then(() => {
                return p.push(b2, brushes, (buf) => {
                    pb2 = buf;
                })
            }).then(() => {
                return p.push(b3, brushes, (buf) => {
                    pb3 = buf;
                });
            }).then(() => {
                expect(pb1).to.be.a(Float32Array);
                expect(pb2).to.be.a(Float32Array);
                expect(pb3).to.be.a(Float32Array);


                const events = brushes[0].events;

                // Total events prepare x 3 + color (10 times each) x 3 + stagingAttributes x 3 + unprepare x 3
                // + 1 (2nd buffer re-color check for the first 1) + 2 (3rd buffer re-color checks of the first 2)
                // = 42
                expect(events).to.have.length(42); // prepare + color (10 times) + stagingAttributes + unprepare

                const expectBufferProcessingEvents = (startIndex, bufferSize, parent, children, b, pb) => {
                    const ev1 = events[startIndex + 0];
                    expect(ev1[0]).to.eql('prepare');
                    expect(ev1[1]).to.eql(parent); // should have no parents
                    expect(ev1[2]).to.eql(children);   // should have no children
                    expect(ev1[3]).to.have.property('bufferStats');
                    expect(ev1[3]).to.have.property('pointCloudBufferStats');
                    expect(ev1[3]).to.have.property('geoTransform');
                    expect(ev1[3]).to.have.property('renderSpaceBounds');
                    expect(ev1[3].renderSpaceBounds).to.eql(b.renderSpaceBounds);

                    // The next ten events should be point coloring for each point, and the point seen should be from our input buffer
                    for (let i = 1 ; i <= bufferSize ; i ++) {
                        const e = events[startIndex + i];
                        expect(e[0]).to.eql('colorPoint');
                        expect(e[1]).to.have.property('x', b.data[(i - 1) * 3 + 0]);
                        expect(e[1]).to.have.property('y', b.data[(i - 1) * 3 + 1]);
                        expect(e[1]).to.have.property('z', b.data[(i - 1) * 3 + 2]);
                    }

                    // All points and colors in output buffer should also match
                    for (let i = 0 ; i < 10 ; i ++) {
                        expect(pb[i * 4 + 0]).to.eql(b.data[i * 3 + 0]);
                        expect(pb[i * 4 + 1]).to.eql(b.data[i * 3 + 1]);
                        expect(pb[i * 4 + 2]).to.eql(b.data[i * 3 + 2]);

                        expect(pb[i * 4 + 3]).to.eql(compressColor([1, 2, 3]));
                    }

                    // Right after coloring all the points, staging attributes should be requested
                    const ev11 = events[startIndex + bufferSize + 1];
                    expect(ev11[0]).to.eql('stagingAttributes');
                    expect(ev11[1]).to.eql(parent); // should have no parents
                    expect(ev11[2]).to.eql(children);   // should have no children
                    expect(ev11[3]).to.have.property('bufferStats');
                    expect(ev11[3]).to.have.property('pointCloudBufferStats');
                    expect(ev11[3]).to.have.property('geoTransform');
                    expect(ev11[3]).to.have.property('renderSpaceBounds');
                    expect(ev11[3].renderSpaceBounds).to.eql(b.renderSpaceBounds);

                    // Followed by an un-prepare event
                    const ev12 = events[startIndex + bufferSize + 2];
                    expect(ev12[0]).to.eql('unprepare');
                    expect(ev12[1]).to.have.property('bufferStats');
                    expect(ev12[1]).to.have.property('pointCloudBufferStats');
                    expect(ev12[1]).to.have.property('geoTransform');
                    expect(ev12[1]).to.have.property('renderSpaceBounds');
                    expect(ev12[1].renderSpaceBounds).to.eql(b.renderSpaceBounds);
                };

                expectBufferProcessingEvents(0, 10, null, [], b1, pb1);

                // Right after R no extra brush events should be generated
                expectBufferProcessingEvents(13, 10, {
                    so: 'wow' + boundsKey(b1.renderSpaceBounds),
                    many: 'yes' + boundsKey(b1.renderSpaceBounds)
                }, [], b2, pb2);


                // When processing R1, R should have been determined as one needing re-color consideration, so there should be an
                // event indicating that
                const ev1 = events[26];

                expect(ev1[0]).to.eql('bufferNeedsRecolor');
                expect(ev1[1]).to.have.property('bufferStats');
                expect(ev1[1]).to.have.property('pointCloudBufferStats');
                expect(ev1[1]).to.have.property('geoTransform');
                expect(ev1[1]).to.have.property('renderSpaceBounds');
                expect(ev1[1].renderSpaceBounds).to.eql(b2.renderSpaceBounds);
                expect(ev1[2]).to.have.property('yay', 'wow' + boundsKey(b2.renderSpaceBounds));
                expect(ev1[3]).to.have.property('so', 'wow' + boundsKey(b1.renderSpaceBounds));
                expect(ev1[3]).to.have.property('many', 'yes' + boundsKey(b1.renderSpaceBounds));

                expectBufferProcessingEvents(27, 10, null, [], b3, pb3);

                // When processing R1114, both R, and R1 should have been checked for re-color checks
                const ev2 = events[40];
                expect(ev2[0]).to.eql('bufferNeedsRecolor');
                expect(ev2[1]).to.have.property('bufferStats');
                expect(ev2[1]).to.have.property('pointCloudBufferStats');
                expect(ev2[1]).to.have.property('geoTransform');
                expect(ev2[1]).to.have.property('renderSpaceBounds');
                expect(ev2[1].renderSpaceBounds).to.eql(b3.renderSpaceBounds);
                expect(ev2[2]).to.have.property('yay', 'wow' + boundsKey(b3.renderSpaceBounds));
                expect(ev2[3]).to.have.property('so', 'wow' + boundsKey(b1.renderSpaceBounds));
                expect(ev2[3]).to.have.property('many', 'yes' + boundsKey(b1.renderSpaceBounds));

                const ev3 = events[41];
                expect(ev3[0]).to.eql('bufferNeedsRecolor');
                expect(ev3[1]).to.have.property('bufferStats');
                expect(ev3[1]).to.have.property('pointCloudBufferStats');
                expect(ev3[1]).to.have.property('geoTransform');
                expect(ev3[1]).to.have.property('renderSpaceBounds');
                expect(ev3[1].renderSpaceBounds).to.eql(b3.renderSpaceBounds);
                expect(ev3[2]).to.have.property('yay', 'wow' + boundsKey(b3.renderSpaceBounds));
                expect(ev3[3]).to.have.property('so', 'wow' + boundsKey(b2.renderSpaceBounds));
                expect(ev3[3]).to.have.property('many', 'yes' + boundsKey(b2.renderSpaceBounds));
            });
        });

        it('should invoke correct brush functions in correct order for large sets (spanning tasks)', function() {
            this.timeout(5000);

            const p = new PointBufferCache();
            const b = dummyDownloadedData(1100, []);
            b.treePath = "R";

            const brushes = [BrushFactory.createBrush("local://funkycolor")];

            let pb = null;
            return p.push(b, brushes, (buf) => {
                pb = buf;
            }).then(() => {
                expect(pb).to.be.a(Float32Array);
                expect(pb[0]).to.eql(b.data[0]);
                expect(pb[1]).to.eql(b.data[1]);
                expect(pb[2]).to.eql(b.data[2]);


                const events = brushes[0].events;
                const ev1 = events[0];

                expect(events).to.have.length(1103); // prepare + color (1100 times) + stagingAttributes + unprepare

                // first event the brush should see is prepare.
                expect(ev1[0]).to.eql('prepare');
                expect(ev1[1]).to.eql(null); // should have no parents
                expect(ev1[2]).to.eql([]);   // should have no children
                expect(ev1[3]).to.have.property('bufferStats');
                expect(ev1[3]).to.have.property('pointCloudBufferStats');
                expect(ev1[3]).to.have.property('geoTransform');
                expect(ev1[3]).to.have.property('renderSpaceBounds');

                // The next ten events should be point coloring for each point, and the point seen should be from our input buffer
                for (let i = 1 ; i <= 1100 ; i ++) {
                    const e = events[i];
                    expect(e[0]).to.eql('colorPoint');
                    expect(e[1]).to.have.property('x', b.data[(i - 1) * 3 + 0]);
                    expect(e[1]).to.have.property('y', b.data[(i - 1) * 3 + 1]);
                    expect(e[1]).to.have.property('z', b.data[(i - 1) * 3 + 2]);
                }

                // All points and colors in output buffer should also match
                for (let i = 0 ; i < 1100 ; i ++) {
                    expect(pb[i * 4 + 0]).to.eql(b.data[i * 3 + 0]);
                    expect(pb[i * 4 + 1]).to.eql(b.data[i * 3 + 1]);
                    expect(pb[i * 4 + 2]).to.eql(b.data[i * 3 + 2]);

                    expect(pb[i * 4 + 3]).to.eql(compressColor([1, 2, 3]));
                }

                // Right after coloring all the points, staging attributes should be requested
                const ev11 = events[1101];
                expect(ev11[0]).to.eql('stagingAttributes');
                expect(ev11[1]).to.eql(null); // should have no parents
                expect(ev11[2]).to.eql([]);   // should have no children
                expect(ev11[3]).to.have.property('bufferStats');
                expect(ev11[3]).to.have.property('pointCloudBufferStats');
                expect(ev11[3]).to.have.property('geoTransform');
                expect(ev11[3]).to.have.property('renderSpaceBounds');

                // Followed by an un-prepare event
                const ev12 = events[1102];
                expect(ev12[0]).to.eql('unprepare');
                expect(ev12[1]).to.have.property('bufferStats');
                expect(ev12[1]).to.have.property('pointCloudBufferStats');
                expect(ev12[1]).to.have.property('geoTransform');
                expect(ev12[1]).to.have.property('renderSpaceBounds');
            });
        });

        it('should invoke correct brush functions in correct order for multiple buffers for large sets (spanning tasks)', function() {
            this.timeout(10000);

            const p = new PointBufferCache();
            const b1 = dummyDownloadedData(2000, []);
            const b2 = dummyDownloadedData(2000, []);
            const b3 = dummyDownloadedData(2000, []);
            b1.treePath = "R";
            b2.treePath = "R1";
            b3.treePath = "R1114";

            const brushes = [BrushFactory.createBrush("local://funkycolor")];

            return pushMany(p, brushes, b1, b2, b3).then(([pb1, pb2, pb3]) => {
                expect(pb1).to.be.a(Float32Array);
                expect(pb2).to.be.a(Float32Array);
                expect(pb3).to.be.a(Float32Array);


                const events = brushes[0].events;

                // Total events prepare x 3 + color (2000 times each) x 3 + stagingAttributes x 3 + unprepare x 3
                // + 1 (2nd buffer re-color check for the first 1) + 2 (3rd buffer re-color checks of the first 2)
                // = 6012
                expect(events).to.have.length(6012); // prepare + color (10 times) + stagingAttributes + unprepare

                const expectBufferProcessingEvents = (startIndex, bufferSize, parent, children, b, pb) => {
                    const ev1 = events[startIndex + 0];
                    expect(ev1[0]).to.eql('prepare');
                    expect(ev1[1]).to.eql(parent); // should have no parents
                    expect(ev1[2]).to.eql(children);   // should have no children
                    expect(ev1[3]).to.have.property('bufferStats');
                    expect(ev1[3]).to.have.property('pointCloudBufferStats');
                    expect(ev1[3]).to.have.property('geoTransform');
                    expect(ev1[3]).to.have.property('renderSpaceBounds');
                    expect(ev1[3].renderSpaceBounds).to.eql(b.renderSpaceBounds);

                    // The next ten events should be point coloring for each point, and the point seen should be from our input buffer
                    for (let i = 1 ; i <= bufferSize ; i ++) {
                        const e = events[startIndex + i];
                        expect(e[0]).to.eql('colorPoint');
                        expect(e[1]).to.have.property('x', b.data[(i - 1) * 3 + 0]);
                        expect(e[1]).to.have.property('y', b.data[(i - 1) * 3 + 1]);
                        expect(e[1]).to.have.property('z', b.data[(i - 1) * 3 + 2]);
                    }

                    // All points and colors in output buffer should also match
                    for (let i = 0 ; i < 10 ; i ++) {
                        expect(pb[i * 4 + 0]).to.eql(b.data[i * 3 + 0]);
                        expect(pb[i * 4 + 1]).to.eql(b.data[i * 3 + 1]);
                        expect(pb[i * 4 + 2]).to.eql(b.data[i * 3 + 2]);

                        expect(pb[i * 4 + 3]).to.eql(compressColor([1, 2, 3]));
                    }

                    // Right after coloring all the points, staging attributes should be requested
                    const ev11 = events[startIndex + bufferSize + 1];
                    expect(ev11[0]).to.eql('stagingAttributes');
                    expect(ev11[1]).to.eql(parent); // should have no parents
                    expect(ev11[2]).to.eql(children);   // should have no children
                    expect(ev11[3]).to.have.property('bufferStats');
                    expect(ev11[3]).to.have.property('pointCloudBufferStats');
                    expect(ev11[3]).to.have.property('geoTransform');
                    expect(ev11[3]).to.have.property('renderSpaceBounds');
                    expect(ev11[3].renderSpaceBounds).to.eql(b.renderSpaceBounds);

                    // Followed by an un-prepare event
                    const ev12 = events[startIndex + bufferSize + 2];
                    expect(ev12[0]).to.eql('unprepare');
                    expect(ev12[1]).to.have.property('bufferStats');
                    expect(ev12[1]).to.have.property('pointCloudBufferStats');
                    expect(ev12[1]).to.have.property('geoTransform');
                    expect(ev12[1]).to.have.property('renderSpaceBounds');
                    expect(ev12[1].renderSpaceBounds).to.eql(b.renderSpaceBounds);
                };

                expectBufferProcessingEvents(0, 2000, null, [], b1, pb1);

                // Right after R no extra brush events should be generated
                expectBufferProcessingEvents(2003, 2000, {
                    so: 'wow' + boundsKey(b1.renderSpaceBounds),
                    many: 'yes' + boundsKey(b1.renderSpaceBounds)
                }, [], b2, pb2);


                // When processing R1, R should have been determined as one needing re-color consideration, so there should be an
                // event indicating that
                const ev1 = events[4006];

                expect(ev1[0]).to.eql('bufferNeedsRecolor');
                expect(ev1[1]).to.have.property('bufferStats');
                expect(ev1[1]).to.have.property('pointCloudBufferStats');
                expect(ev1[1]).to.have.property('geoTransform');
                expect(ev1[1]).to.have.property('renderSpaceBounds');
                expect(ev1[1].renderSpaceBounds).to.eql(b2.renderSpaceBounds);
                expect(ev1[2]).to.have.property('yay', 'wow' + boundsKey(b2.renderSpaceBounds));
                expect(ev1[3]).to.have.property('so', 'wow' + boundsKey(b1.renderSpaceBounds));
                expect(ev1[3]).to.have.property('many', 'yes' + boundsKey(b1.renderSpaceBounds));

                expectBufferProcessingEvents(4007, 2000, null, [], b3, pb3);

                // When processing R1114, both R, and R1 should have been checked for re-color checks
                const ev2 = events[6010];
                expect(ev2[0]).to.eql('bufferNeedsRecolor');
                expect(ev2[1]).to.have.property('bufferStats');
                expect(ev2[1]).to.have.property('pointCloudBufferStats');
                expect(ev2[1]).to.have.property('geoTransform');
                expect(ev2[1]).to.have.property('renderSpaceBounds');
                expect(ev2[1].renderSpaceBounds).to.eql(b3.renderSpaceBounds);
                expect(ev2[2]).to.have.property('yay', 'wow' + boundsKey(b3.renderSpaceBounds));
                expect(ev2[3]).to.have.property('so', 'wow' + boundsKey(b1.renderSpaceBounds));
                expect(ev2[3]).to.have.property('many', 'yes' + boundsKey(b1.renderSpaceBounds));

                const ev3 = events[6011];
                expect(ev3[0]).to.eql('bufferNeedsRecolor');
                expect(ev3[1]).to.have.property('bufferStats');
                expect(ev3[1]).to.have.property('pointCloudBufferStats');
                expect(ev3[1]).to.have.property('geoTransform');
                expect(ev3[1]).to.have.property('renderSpaceBounds');
                expect(ev3[1].renderSpaceBounds).to.eql(b3.renderSpaceBounds);
                expect(ev3[2]).to.have.property('yay', 'wow' + boundsKey(b3.renderSpaceBounds));
                expect(ev3[3]).to.have.property('so', 'wow' + boundsKey(b2.renderSpaceBounds));
                expect(ev3[3]).to.have.property('many', 'yes' + boundsKey(b2.renderSpaceBounds));
            });
        });

        it('should determine parent and children nodes correctly', () => {
            const p = new PointBufferCache();
            const b1 = dummyDownloadedData(10, []);
            const b2 = dummyDownloadedData(10, []);
            const b3 = dummyDownloadedData(10, []);
            const b4 = dummyDownloadedData(10, []);
            b1.treePath = "R";
            b2.treePath = "R0";
            b3.treePath = "R04"
            b4.treePath = "R05";

            const brushes = [BrushFactory.createBrush("local://funkycolor")];

            return pushMany(p, brushes, b1, b3, b4, b2).then(() => {
                const events = brushes[0].events;

                // We are only interested in a particular event here generated when b2 was pushed.
                //
                // 0->12 .. b1 prep + color 10 points + stage + unprep
                // 13->26 .. b3 prep + color 10 points + stage + unprep + recolor check
                // 27 -> 41   .. b4 prep + color 10 points + stage + unprep + 2 recolor checks
                // 42 -> our buffer of interest events
                //
                const e1 = events[42];

                expect(e1[0]).to.eql('prepare');
                expect(e1[1]).to.have.property('so', 'wow' + boundsKey(b1.renderSpaceBounds));
                expect(e1[1]).to.have.property('many', 'yes' + boundsKey(b1.renderSpaceBounds));
                expect(e1[2]).to.be.an(Array);
                expect(e1[2]).to.have.length(2);
                expect(e1[2][0]).to.have.property('so', 'wow' + boundsKey(b3.renderSpaceBounds));
                expect(e1[2][1]).to.have.property('so', 'wow' + boundsKey(b4.renderSpaceBounds));
                expect(e1[3]).to.have.property('bufferStats');
                expect(e1[3]).to.have.property('pointCloudBufferStats');
                expect(e1[3]).to.have.property('geoTransform');
                expect(e1[3]).to.have.property('renderSpaceBounds');
                expect(e1[3].renderSpaceBounds).to.eql(b2.renderSpaceBounds);
            });
        });


        it('should paint with multiple brushes correctly', () => {
            const p = new PointBufferCache();
            const b1 = dummyDownloadedData(10, []);
            b1.treePath = "R";

            const brushes = [
                BrushFactory.createBrush("local://funkycolor"),
                BrushFactory.createBrush("local://inversefunkycolor")
            ];

            return p.push(b1, brushes, (buf) => {
                expect(buf).to.be.a(Float32Array);
                expect(buf).to.have.length(10 * (3 + 2)); // 3 for XYZ and 2 for each brush

                for (let i = 0 ; i < 10 ; i ++) {
                    expect(buf[5 * i + 3]).to.eql(compressColor([1, 2, 3]));
                    expect(buf[5 * i + 4]).to.eql(compressColor([3, 2, 1]));
                }
            });
        });

        it('should paint with multiple brushes correctly when certain brushes are null', () => {
            const p = new PointBufferCache();
            const b1 = dummyDownloadedData(10, []);
            b1.treePath = "R";

            const brushes = [
                BrushFactory.createBrush("local://funkycolor"),
                null,
                null,
                BrushFactory.createBrush("local://inversefunkycolor")
            ];

            return p.push(b1, brushes, (buf) => {
                expect(buf).to.be.a(Float32Array);
                expect(buf).to.have.length(10 * (3 + 2)); // 3 for XYZ and 2 for each brush

                for (let i = 0 ; i < 10 ; i ++) {
                    expect(buf[5 * i + 3]).to.eql(compressColor([1, 2, 3]));
                    expect(buf[5 * i + 4]).to.eql(compressColor([3, 2, 1]));
                }
            });
        });

        it('determine recolor nodes for tree strategy correctly', () => {
            const p = new PointBufferCache();
            const b2 = dummyDownloadedData(10, []);
            const b3 = dummyDownloadedData(10, []);
            const b4 = dummyDownloadedData(10, []);
            const b5 = dummyDownloadedData(10, []);

            b2.treePath = "R1";
            b3.treePath = "R27";
            b4.treePath = "R12";
            b5.treePath = "R120";

            const brushes = [
                BrushFactory.createBrush("local://treefunkycolor"),
            ];

            return pushMany(p, brushes, b2, b3, b4, b5).then(() => {
                const events = brushes[0].events;

                // We are interested in the recolor events generated by the 2nd and 3rd buffer push
                // b2: 0 -> 12 prep + color 10 + stage + unprep
                // b3: 13 -> 25 prep + color 10 + stage + unprep
                // b4: 26 -> 39   prep + color 10 + stage + unprep + 1 recolor
                const e1 = events[39];

                expect(e1[0]).to.eql('bufferNeedsRecolor');
                expect(e1[1]).to.have.property('bufferStats');
                expect(e1[1]).to.have.property('pointCloudBufferStats');
                expect(e1[1]).to.have.property('geoTransform');
                expect(e1[1]).to.have.property('renderSpaceBounds');
                expect(e1[1].renderSpaceBounds).to.eql(b4.renderSpaceBounds);
                expect(e1[2]).to.have.property('yay', 'yoy' + boundsKey(b4.renderSpaceBounds));
                expect(e1[3]).to.have.property('so', 'wow' + boundsKey(b2.renderSpaceBounds));

                // Insertion of b5 should generate two recolor events delivered in increasing ancestry order (closer parent first)
                // b5: 40->  prep + color 10 + stage + unprep + 2 recolor
                const e2 = events[53];
                const e3 = events[54];

                expect(e2[0]).to.eql('bufferNeedsRecolor');
                expect(e2[1]).to.have.property('bufferStats');
                expect(e2[1]).to.have.property('pointCloudBufferStats');
                expect(e2[1]).to.have.property('geoTransform');
                expect(e2[1]).to.have.property('renderSpaceBounds');
                expect(e2[1].renderSpaceBounds).to.eql(b5.renderSpaceBounds);
                expect(e2[2]).to.have.property('yay', 'yoy' + boundsKey(b5.renderSpaceBounds));
                expect(e2[3]).to.have.property('so', 'wow' + boundsKey(b4.renderSpaceBounds));

                expect(e3[0]).to.eql('bufferNeedsRecolor');
                expect(e3[1]).to.have.property('bufferStats');
                expect(e3[1]).to.have.property('pointCloudBufferStats');
                expect(e3[1]).to.have.property('geoTransform');
                expect(e3[1]).to.have.property('renderSpaceBounds');
                expect(e3[1].renderSpaceBounds).to.eql(b5.renderSpaceBounds);
                expect(e3[2]).to.have.property('yay', 'yoy' + boundsKey(b5.renderSpaceBounds));
                expect(e3[3]).to.have.property('so', 'wow' + boundsKey(b2.renderSpaceBounds));
            });
        });
    })
});
