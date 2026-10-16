// Metro (the bundler) settings for SGM Pocket. The receipt reader's model
// files in models/ocr at the repository root are bundled as assets.
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
config.resolver.assetExts.push('onnx', 'yml');

module.exports = config;
