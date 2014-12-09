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

//clean build directory
gulp.task('clean', function(){
    return gulp.src('./gh-loader.js', {read: false} )
        .pipe(clean());
});

// lint all of our js source files
gulp.task('lint', function (){
    return gulp.src(['workers/**/*.js'])
    .pipe(jshint({
        "smarttabs": true
    }))
    .pipe(jshint.reporter('default'));
});

gulp.task('build-gh-loader', ['lint'], function() {
    return gulp.src('workers/gh-loader.js')
        .pipe(browserify())
        .on("error", gutil.log)
        .on("error", gutil.beep)
        .pipe(gulp.dest("."));
});

gulp.task('build-all', ['build-gh-loader']);

gulp.task('watch', ['build-all'], function() {
    // watch all our dirs and reload if any build stuff changes
    //
    gulp.watch(['workers/**/*.js'], ['build-all']);
});
