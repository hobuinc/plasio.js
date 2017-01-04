// point-buffer-cache.test.js
//

var expect = require('expect.js');

import { dummyDownloadedData } from './test-utils';
import { PointBufferCache } from '../lib/point-buffer-cache';
import { BrushFactory } from '../lib/brush-factory';


describe('PointBufferCache', () => {
    describe('constructions', () => {
        it('sets up initial state correctly', () => {
            const p = new PointBufferCache();
            expect(p).to.have.property('nodes');
        });
    });

    describe('push', () => {
        it('should throw an error if a required paramter is missing', (done) => {
            const p = new PointBufferCache();
            const b = dummyDownloadedData(10, []);

            p.push(b, [BrushFactory.createBrush("local://color")])
                .then(() => done(new Error('Should not succeed')))
                .catch(() => done());
        });
    });

    describe('push', () => {
        it('should correctly insert a valid downloaded buffer without an error', (done) => {
            const p = new PointBufferCache();
            const b = dummyDownloadedData(10, []);

            b.treePath = "R";
            p.push(b, [BrushFactory.createBrush("local://color")])
                .then(done)
                .catch(done);
        });

        it('processed buffer should have sane data', (done) => {
            const p = new PointBufferCache();
            const b = dummyDownloadedData(10, []);

            b.treePath = "R";

            let pb = null;

            p.push(b, [BrushFactory.createBrush("local://color")], (buf) => {
                pb = buf;
            }).then(() => {
                expect(pb).to.be.a(Float32Array);
                console.log(pb.slice(0, 10), b.data.slice(0, 10));
                expect(pb[0]).to.eql(b.data[0]);
                expect(pb[1]).to.eql(b.data[1]);
                expect(pb[2]).to.eql(b.data[2]);
                done();
            }).catch(done);
        });
    })
});
