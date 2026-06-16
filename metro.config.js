const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// Add WASM support (required by expo-sqlite on web)
config.resolver.assetExts.push("wasm");

module.exports = config;
