/*---------------------------------------------------------------------------------------------
* Copyright (c) 2019 Bentley Systems, Incorporated. All rights reserved.
* Licensed under the MIT License. See LICENSE.md in the project root for license terms.
*--------------------------------------------------------------------------------------------*/

const path = require("path");
const glob = require("glob");
const webpack = require("webpack");
const raw = require("@bentley/config-loader/lib/IModelJsConfig").IModelJsConfig.init(true /*suppress error*/, true);
module.exports = {
  mode: "development",
  entry: glob.sync(path.resolve(__dirname, "lib/**/*.test.js")),
  output: {
    path: path.resolve(__dirname, "lib/dist"),
    filename: "bundled-tests.js",
    devtoolModuleFilenameTemplate: "file:///[absolute-resource-path]"
  },
  devtool: "nosources-source-map",
  module: {
    noParse: [
      // Don't parse draco_*_nodejs.js modules for `require` calls.  There are
      // requires for fs that cause it to fail even though the fs dependency
      // is not used.
      /draco_decoder_nodejs.js$/,
      /draco_encoder_nodejs.js$/
    ],
    rules: [
      {
        test: /\.js$/,
        use: "source-map-loader",
        enforce: "pre"
      },
      {
        test: /azure-storage|AzureFileHandler|UrlFileHandler/,
        use: "null-loader"
      },
      {
        test: /imodeljs-backend/,
        use: "null-loader"
      }
    ]
  },
  stats: "errors-only",
  optimization: {
    nodeEnv: "production"
  },
  plugins: [
    // Makes some environment variables available to the JS code, for example:
    // if (process.env.NODE_ENV === "development") { ... }. See `./env.js`.
    new webpack.DefinePlugin({
      "process.env": Object.keys(raw)
        .filter((key) => {
          return key.match(/^imjs_/i);
        })
        .reduce((env, key) => {
          env[key] = JSON.stringify(raw[key]);
          return env;
        }, {
            IMODELJS_CORE_DIRNAME: JSON.stringify(path.join(__dirname, "../..")),
          }),
    })
  ]
};

