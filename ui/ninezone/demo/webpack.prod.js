/*---------------------------------------------------------------------------------------------
* Copyright (c) 2019 Bentley Systems, Incorporated. All rights reserved.
* Licensed under the MIT License. See LICENSE.md in the project root for license terms.
*--------------------------------------------------------------------------------------------*/
const path = require('path');
const merge = require('webpack-merge');
const common = require('./webpack.common.js');

module.exports = merge(common, {
  entry: path.resolve(__dirname, 'src', 'Index.tsx'),
  mode: 'production',
  output: {
    filename: 'demo.js',
    path: path.resolve(__dirname, '..', '..', '..', 'generated-docs', 'ui', 'assets', 'ui-ninezone')
  }
});
