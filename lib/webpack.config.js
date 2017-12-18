var webpack = require('webpack');



var plasioLibConfig = {
    entry: [
        './index.js'
    ],

    resolve: {
        extensions: ['', '.js' ]
    },

    output: {
        path: './dist',
        filename: 'plasio.js'
    },

    module: {
        loaders: [
            {
                test: /\.jsx?$/,
                exclude: /node_modules/,
                loader: 'babel',
                query: {
                    cacheDirectory: true,
                    presets: ["es2015"]
                }
            },
            {
                test: /\.tsx?$/,
                exclude: /node_modules/,
                loader: 'ts-loader',
            }
        ]
    }
};

var plasioWebWorkerConfig = {
    entry: [
        './index-webworker.js'
    ],

    resolve: {
        extensions: ['', '.js' ]
    },

    output: {
        path: './dist',
        filename: 'plasio.webworker.js'
    },

    module: {
        loaders: [
            {
                test: /\.jsx?$/,
                exclude: /node_modules/,
                loader: 'babel',
                query: {
                    cacheDirectory: true,
                    presets: ["es2015"]
                }
            },
            {
                test: /\.tsx?$/,
                exclude: /node_modules/,
                loader: 'ts-loader',
            }
        ]
    }
};

var plasioColorWebWorkerConfig = {
    entry: [
        './index-colorworker.js'
    ],

    resolve: {
        extensions: ['', '.js' ]
    },

    output: {
        path: './dist',
        filename: 'plasio.color.webworker.js'
    },

    module: {
        loaders: [
            {
                test: /\.jsx?$/,
                exclude: /node_modules/,
                loader: 'babel',
                query: {
                    cacheDirectory: true,
                    presets: ["es2015"]
                }
            },
            {
                test: /\.tsx?$/,
                exclude: /node_modules/,
                loader: 'ts-loader',
            }
        ]
    }
};

module.exports = [plasioLibConfig, plasioWebWorkerConfig, plasioColorWebWorkerConfig];
