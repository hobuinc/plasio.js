var gulp = require('gulp');

var jshint = require('gulp-jshint');
var concat = require('gulp-concat');
var uglify = require('gulp-uglify');
var rename = require('gulp-rename');
var browserify = require('gulp-browserify');
var gutil = require('gulp-util');
var watch = require('gulp-watch');
var livereload = require('gulp-livereload');
var clean = require('gulp-clean');
var connect = require('gulp-connect');

var http = require('http');
var open = require('open');
var path = require('path');

var execFile = require('child_process').execFile;
var fs = require('fs');


gulp.task('tdd', ['serve-specs', 'watch']);


//clean build directory
gulp.task('clean', function(){
    return gulp.src('./dist', {read: false} )
        .pipe(clean());
});

// lint all of our js source files
gulp.task('lint', function (){
    return gulp.src(['lib/**/*.js', 'index.js'])
    .pipe(jshint({
        "smarttabs": true
    }))
    .pipe(jshint.reporter('default'));
});

gulp.task('build', ['lint'], function() {
    return gulp.src('index.js')
        .pipe(rename(function(path) {
            path.basename = "plasio-lib";
        }))
        .pipe(browserify({
            standalone: "PlasioLib"
        }))
        .on("error", gutil.log)
        .on("error", gutil.beep)
        .pipe(gulp.dest("dist"));
});

gulp.task('watch', ['build'], function() {
    // watch all our dirs and reload if any build stuff changes
    //
    gulp.watch(['lib/**/*.js', 'index.js'], ['build']);
});

gulp.task('optimize', ['build'], function(cb) {
    var input = 'dist/gh-policies.js';
    var output = 'dist/gh-policies.min.js';

    execFile('java', [
        '-jar', 'vendor/closure-compiler/compiler.jar',
        '--js', input,
        '--language_in', 'ECMASCRIPT5',
        '--compilation_level', 'SIMPLE_OPTIMIZATIONS',
        '--js_output_file', output],
        {maxBuffer: (1000*4096)},
        function(err, stdout, stderr) {
            if (err)
                return cb(err);

            fs.unlinkSync(input);
            return cb();
        });
});

gulp.task('dist', ['optimize']);
