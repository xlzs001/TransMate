/**
 * 质量预算门禁
 *
 * 度量本身不拦人 —— 谁都不会因为"复杂度 32"被 CI 拦下。
 * 这个脚本把度量变成可执行的上限，让已经做出的改进不会再退化。
 *
 * 三条规则：
 *   R1 不在名单里的函数超标 → 拦下（新代码不许开新的坑）
 *   R2 名单里的函数比记录值更差 → 拦下（已有的坑不许再挖深）
 *   R3 名单里的函数已经达标 / 已不存在 → 拦下，要求把条目删掉
 *
 * R3 是关键。没有它，这份名单只会越来越长，最后变成"什么都可以"。
 * 所以它同时是重构待办清单：改好一个，就来这里删一行。
 *
 * 用法：node temp/quality-budget.cjs
 * 退出码非 0 表示门禁不通过。
 */
const { collectFunctions } = require('./quality-metrics.cjs');

/** 上限取《工程规范手册》里的建议值，不是拍脑袋定的。 */
const LIMITS = {
  complexity: 15,   // 超过 15 基本该拆分支
  length: 80        // 超过 80 行基本该拆
};

/**
 * 已知超标、暂时接受的位置。key 是 `文件:函数名`。
 * 每一条都要写清楚"打算怎么改" —— 写不出来就说明还没想清楚，那就不该放进来。
 */
const ALLOWED = new Map([
  ['options.js:loadSettings', {
    length: 62, complexity: 24,
    plan: '按「读存储 / 校验 / 填表单」拆三段'
  }],
  ['timezone.js:pumpChatTranslationQueue', {
    length: 56, complexity: 24,
    plan: '按「取待翻译 / 请求 / 回填」拆三段'
  }],
  ['timezone.js:translateVisibleChat', {
    length: 43, complexity: 24,
    plan: '按「挑选待翻译节点 / 翻译 / 回填」拆三段'
  }],
  ['options.js:runProviderAction', {
    length: 46, complexity: 22,
    plan: '按「校验输入 / 发请求 / 回填界面」拆三段'
  }],
  ['timezone.js:getRecentIncomingMessages', {
    length: 45, complexity: 22,
    plan: '按「取候选节点 / 过滤 / 截断」拆三段'
  }],
  ['timezone.js:findStatusAnchorRect', {
    length: 44, complexity: 16,
    plan: '按「找候选元素 / 算位置」拆两段'
  }],
  ['background.js:callProvider', {
    length: 89, complexity: 13,
    plan: '复杂度不高，只是长：六种服务商已各抽成独立函数，这里只剩分发。可暂缓'
  }],
  ['timezone.js:createRoot', {
    length: 97, complexity: 4,
    plan: '一整个面板的 DOM 模板。拆开反而更难和设计稿对照，倾向保留'
  }]
]);

/** 同名函数只保留最差的一处：重名时不能因为"某一个没超标"就放过。 */
function worstByName(functions) {
  const worst = new Map();
  for (const fn of functions) {
    const key = `${fn.file}:${fn.name}`;
    const current = worst.get(key);
    if (!current) {
      worst.set(key, { ...fn });
      continue;
    }
    current.length = Math.max(current.length, fn.length);
    current.complexity = Math.max(current.complexity, fn.complexity);
  }
  return worst;
}

function run() {
  const worst = worstByName(collectFunctions());
  const problems = [];
  let allowed = 0;

  for (const [key, fn] of worst) {
    const over = fn.complexity > LIMITS.complexity || fn.length > LIMITS.length;
    const entry = ALLOWED.get(key);

    if (!entry) {
      if (over) {
        problems.push(`${key}（${fn.file}:${fn.line}）超标：复杂度 ${fn.complexity} / ${fn.length} 行，`
          + `上限是 ${LIMITS.complexity} / ${LIMITS.length}。拆开它，或者写进 ALLOWED 并说明打算怎么改`);
      }
      continue;
    }

    allowed += 1;
    if (fn.complexity > entry.complexity) {
      problems.push(`${key} 复杂度从记录的 ${entry.complexity} 涨到 ${fn.complexity} —— 名单里的函数不许再变差`);
    }
    if (fn.length > entry.length) {
      problems.push(`${key} 长度从记录的 ${entry.length} 涨到 ${fn.length} 行 —— 名单里的函数不许再变差`);
    }
    if (!over) {
      problems.push(`${key} 已经达标（复杂度 ${fn.complexity} / ${fn.length} 行），`
        + `请把 ALLOWED 里这一条删掉 —— 名单留着过期的条目就失去意义了`);
    }
  }

  for (const key of ALLOWED.keys()) {
    if (!worst.has(key)) {
      problems.push(`ALLOWED 里的 ${key} 在代码里找不到了（改名或删除？），请同步删掉这条`);
    }
  }

  return {
    ok: problems.length === 0,
    limits: LIMITS,
    allowedCount: allowed,
    problemCount: problems.length,
    problems
  };
}

module.exports = { run, LIMITS, ALLOWED };

if (require.main === module) {
  const result = run();
  console.log('=== 质量预算检查 ===');
  console.log(`上限：复杂度 ≤ ${result.limits.complexity}，长度 ≤ ${result.limits.length} 行`);
  console.log(`名单内暂时接受：${result.allowedCount} 处`);
  console.log();
  if (result.ok) {
    console.log('通过：没有新增超标，名单也没有过期条目。');
    process.exit(0);
  }
  console.log(`发现 ${result.problemCount} 个问题：`);
  for (const problem of result.problems) console.log('  - ' + problem);
  process.exit(1);
}
