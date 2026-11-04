const { withAppBuildGradle } = require("expo/config-plugins");

// Enables core library desugaring in the generated :app module.
// Required because the local `pcm-recorder` module uses java.time APIs
// with minSdkVersion 24 (see modules/pcm-recorder/android/build.gradle).
module.exports = function withCoreLibraryDesugaring(config) {
  return withAppBuildGradle(config, (cfg) => {
    if (cfg.modResults.language !== "groovy") {
      throw new Error("withCoreLibraryDesugaring only supports a groovy build.gradle");
    }
    let contents = cfg.modResults.contents;
    if (!/coreLibraryDesugaringEnabled\s+true/.test(contents)) {
      contents += "\nandroid {\n    compileOptions {\n        coreLibraryDesugaringEnabled true\n        sourceCompatibility JavaVersion.VERSION_17\n        targetCompatibility JavaVersion.VERSION_17\n    }\n}\n";
    }
    if (!contents.includes("desugar_jdk_libs")) {
      contents += '\ndependencies {\n    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.4")\n}\n';
    }
    cfg.modResults.contents = contents;
    return cfg;
  });
};
