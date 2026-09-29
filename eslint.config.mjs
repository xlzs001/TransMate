// TransMate ESLint 配置（ESLint 9 flat config）
//
// 取舍原则：只开"能抓到真 bug"的规则，不开纯风格规则。
// 风格交给 Prettier（如果之后引入），否则人写人样，评审时吵不出结论。
//
// 关掉的几条都在下面写了理由，不是懒得配。

import js from "@eslint/js";
import globals from "globals";

/** 扩展运行时的全局对象。chrome / importScripts 不在标准 WebExtensions 集合里，单独声明。 */
const extensionGlobals = {
  ...globals.browser,
  ...globals.webextensions,
  ...globals.serviceworker,
  chrome: "readonly",
  importScripts: "readonly"
};

// ---------------------------------------------------------------------------
// 跨文件全局：靠 importScripts / <script src> 注入，不是 ES module 导入。
//
// 这里按"文件实际加载了什么"逐文件声明，而不是一把梭全放开。
// 原因：background.js 同时加载了 providers.js + verify.js，
// 但 options.html / popup.html 只加载了 providers.js。
// 如果在 options.js 里写了 TLP_VERIFY，运行时就是 undefined，
// 而这种错误在浏览器里只会表现为"某个按钮点了没反应"，极难定位。
// 逐文件声明能让 ESLint 直接把它标出来。
//
// 注意：声明成 readonly 只解决"变量名拼错"，属性名拼错仍需靠测试覆盖。
// ---------------------------------------------------------------------------
const fromProviders = {
  TLP_ADAPTERS_WITHOUT_MODEL: "readonly",
  TLP_ADAPTERS_WITHOUT_MODEL_LIST: "readonly",
  TLP_PROVIDER_PRESETS: "readonly"
};
const fromVerify = { TLP_VERIFY: "readonly" };

const correctnessRules = {
  // ---- 抓真 bug 的规则：一律 error ----
  "no-undef": "error",                    // 拼错变量名 / 用了没声明的全局
  "no-unused-vars": ["error", {
    args: "after-used",
    argsIgnorePattern: "^_",
    caughtErrors: "none",                 // catch (_) 里不用变量是常见写法
    varsIgnorePattern: "^_"
  }],
  "no-redeclare": "error",
  "no-dupe-keys": "error",
  "no-dupe-args": "error",
  "no-dupe-else-if": "error",
  "no-cond-assign": ["error", "except-parens"],
  "no-constant-condition": ["error", { checkLoops: false }],
  "no-fallthrough": "error",
  "no-unsafe-finally": "error",
  "no-unsafe-negation": "error",
  "no-unsafe-optional-chaining": "error",
  "no-self-assign": "error",
  "no-self-compare": "error",
  "no-sparse-arrays": "error",
  "no-unreachable": "error",
  "no-async-promise-executor": "error",
  "no-promise-executor-return": "error",
  "no-prototype-builtins": "error",
  "no-obj-calls": "error",
  "no-compare-neg-zero": "error",
  "valid-typeof": "error",
  "use-isnan": "error",
  "array-callback-return": "error",
  "no-constructor-return": "error",
  "no-template-curly-in-string": "error",

  // ---- 安全：这个项目已经确认没有动态代码执行面，用规则把它焊死 ----
  "no-eval": "error",
  "no-implied-eval": "error",
  "no-new-func": "error",
  "no-script-url": "error",

  // ---- 可疑写法：warn，允许在明确知道自己在做什么时用 eslint-disable 注释豁免 ----
  "eqeqeq": ["warn", "smart"],
  "no-var": "off",                        // 代码是 tsc/esbuild 风格产物，改 var→let 收益低风险高
  "no-console": "off",                    // 扩展里 console.error 是唯一可用的日志出口
  "no-empty": ["warn", { allowEmptyCatch: true }],
  "no-useless-escape": "warn",
  "no-unused-private-class-members": "error",
  "no-await-in-loop": "off",              // 串行 await 在这个项目里是刻意的（限速、顺序依赖）
  "require-atomic-updates": "off",        // 对 MV3 事件回调误报太多
  "no-inner-declarations": "off"          // 大量 if 块内 function 声明，是既有风格
};

export default [
  {
    ignores: [
      "node_modules/**",
      "icons/**",
      "relay/**",                          // 独立部署的服务端组件，单独维护
      "temp/relay-worker.mjs",             // 冒烟测试生成的临时副本
      "temp/preview-ui*.html"
    ]
  },

  // ---- 扩展本体：跑在浏览器 / Service Worker 里 ----
  {
    files: ["*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "script",
      globals: extensionGlobals
    },
    rules: {
      ...js.configs.recommended.rules,
      ...correctnessRules
    }
  },

  // background.js 用 importScripts 同时加载了 providers.js 和 verify.js。
  {
    files: ["background.js"],
    languageOptions: { globals: { ...extensionGlobals, ...fromProviders, ...fromVerify } }
  },

  // options.html / popup.html 只加载 providers.js，没有 verify.js。
  {
    files: ["options.js", "popup.js"],
    languageOptions: { globals: { ...extensionGlobals, ...fromProviders } }
  },

  // ---- 测试与工具脚本：跑在 Node 里，允许 console.log ----
  {
    files: ["temp/**/*.cjs", "temp/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node }
    },
    rules: {
      ...js.configs.recommended.rules,
      ...correctnessRules,
      "no-console": "off"
    }
  },

  // ---- ESLint 自己的配置文件 ----
  {
    files: ["eslint.config.mjs"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node }
    }
  }
];
