import { defineConfig } from "zotero-plugin-scaffold";
import pkg from "./package.json";

export default defineConfig({
  source: ["src", "addon"],
  dist: ".scaffold/build",
  name: pkg.config.addonName,
  id: pkg.config.addonID,
  namespace: pkg.config.addonRef,
  updateURL: `https://github.com/{{owner}}/{{repo}}/releases/download/release/${
    pkg.version.includes("-") ? "update-beta.json" : "update.json"
  }`,
  xpiDownloadLink:
    "https://github.com/{{owner}}/{{repo}}/releases/download/v{{version}}/{{xpiName}}.xpi",

  build: {
    // 注意：不能写成 addon/**/*.* —— 那会漏掉 274 个无扩展名的
    // Ghostscript 资源文件（如 Resource/CIDFont/ArtifexBullet、lib/gsbj）。
    assets: ["addon/**/*"],
    define: {
      ...pkg.config,
      author: pkg.author,
      description: pkg.description,
      homepage: pkg.homepage,
      buildVersion: pkg.version,
      buildTime: "{{buildTime}}",
    },
    prefs: {
      prefix: pkg.config.prefsPrefix,
    },
    esbuildOptions: [
      {
        entryPoints: ["src/index.ts"],
        define: {
          __env__: `"${process.env.NODE_ENV}"`,
        },
        bundle: true,
        target: "firefox115",
        outfile: `.scaffold/build/addon/content/scripts/${pkg.config.addonRef}.js`,
      },
    ],
  },

  test: {
    waitForPlugin: `() => Zotero.${pkg.config.addonInstance}.data.initialized`,
    // 解包 42MB 的 Ghostscript 需要时间，默认 10s 不够
    mocha: {
      timeout: 600000,
    },
  },

  // PROTOTYPE: 关掉 jsdebugger —— 默认 server.devtools=true 会加 --jsdebugger，
  // 使 Zotero 启动后暂停等待调试器连接，导致自动化测试挂起。
  server: {
    devtools: false,
  },

  // If you need to see a more detailed log, uncomment the following line:
  // logLevel: "trace",
});
