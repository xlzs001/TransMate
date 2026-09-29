/**
 * 统一门禁运行器
 *
 * 把分散的检查跑成一张表，任何一项失败就整体失败（退出码非 0）。
 * CI 和本地都用这一个入口，避免"记得跑哪几个命令"这种口头约定。
 *
 * 全部在同一个进程里跑，不起子进程：
 *   - 不受环境是否允许创建进程影响（CI 容器、受限沙箱都能跑）
 *   - 少一层进程启动开销
 *   - 每道门禁的检查逻辑都是可 import 的模块，不是一次性脚本
 *
 * 用法：node temp/run-checks.cjs [--verbose]
 */
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const verbose = process.argv.includes('--verbose');

/**
 * 每道门禁：名字 + 跑法 + 这道门在防什么（失败时给成员看的）。
 * run() 统一返回 { ok, summary, detail }。
 */
const GATES = [
  {
    name: '静态检查（ESLint）',
    guards: '未定义变量、恒真恒假、Promise 返回值写错、未使用的变量',
    async run() {
      const { ESLint } = require('eslint');
      const eslint = new ESLint({ cwd: root });
      const results = await eslint.lintFiles(['.']);
      const errors = results.reduce((sum, r) => sum + r.errorCount, 0);
      const warnings = results.reduce((sum, r) => sum + r.warningCount, 0);
      const formatter = await eslint.loadFormatter('stylish');
      const text = formatter.format(results);
      return {
        ok: errors === 0 && warnings === 0,
        summary: `${errors} error / ${warnings} warning`,
        detail: text.trim()
      };
    }
  },
  {
    name: '默认值一致性',
    guards: '5 份 DEFAULTS 副本漂移，加新设置漏改某一处',
    run() {
      const { run: check } = require('./defaults-consistency.cjs');
      const { problems, authoritySize, sources } = check();
      return {
        ok: problems.length === 0,
        summary: `${sources.length} 份定义 / 权威 ${authoritySize} 键 / ${problems.length} 个问题`,
        detail: problems.map(item => '- ' + item).join('\n')
      };
    }
  },
  {
    name: '回归测试',
    guards: '已经修过的 bug 重新出现',
    async run() {
      const { run: check } = require('./regression-checks.cjs');
      const { passed, checks } = await check();
      return { ok: true, summary: `${passed} / ${passed} 通过`, detail: checks.join('\n') };
    }
  },
  {
    name: '审查项',
    guards: '版本号、HTML id、开关默认值不一致',
    async run() {
      const { run: check } = require('./review-checks.cjs');
      const { verified, checks, openItems } = await check();
      const ok = openItems.length === 0;
      return {
        ok,
        summary: `${verified} / ${verified} 通过，遗留 ${openItems.length} 项`,
        detail: openItems.length ? openItems.join('\n') : checks.join('\n')
      };
    }
  },
  {
    name: '中转服务冒烟',
    guards: '中转服务的请求/响应契约被改坏',
    async run() {
      const { run: check } = await import('./relay-smoke.mjs');
      const lines = [];
      const { passed, failures } = await check(line => lines.push(line));
      return {
        ok: failures.length === 0,
        summary: `${passed} / ${passed + failures.length} 通过`,
        detail: failures.map(item => '- ' + item).join('\n')
      };
    }
  },
  {
    name: '空 catch 有说明',
    guards: '吞掉异常却不写为什么 —— 半年后没人敢动这段代码',
    run() {
      const { analyzeAll } = require('./quality-metrics.cjs');
      const report = analyzeAll();
      const undocumented = report.emptyCatches.filter(item => !item.documented);
      return {
        ok: undocumented.length === 0,
        summary: `${report.emptyCatchCount - undocumented.length} / ${report.emptyCatchCount} 有说明`,
        detail: undocumented
          .map(item => `- ${item.file}:${item.line} 空 catch 没有说明为什么可以吞`)
          .join('\n')
      };
    }
  },
  {
    name: '质量预算',
    guards: '函数越写越长、越写越绕 —— 已经改好的地方再退回去',
    run() {
      const { run: check } = require('./quality-budget.cjs');
      const result = check();
      return {
        ok: result.ok,
        summary: `名单内 ${result.allowedCount} 处 / ${result.problemCount} 个问题`,
        detail: result.problems.map(item => '- ' + item).join('\n')
      };
    }
  },
  {
    name: '变异测试',
    guards: '测试变成摆设 —— 代码改坏了，回归测试却还是绿的',
    async run() {
      const { run: check } = require('./mutation-test.cjs');
      const result = await check();
      return {
        ok: result.ok,
        summary: `${result.caught} / ${result.total} 个变异被抓住`,
        detail: result.problems.length ? result.problems.map(item => '- ' + item).join('\n') : result.lines.join('\n')
      };
    }
  }
];

async function main() {
  const results = [];
  for (const gate of GATES) {
    const started = Date.now();
    let outcome;
    try {
      const value = await gate.run();
      outcome = { ...value, ms: Date.now() - started };
    } catch (error) {
      outcome = {
        ok: false,
        summary: '抛异常',
        detail: error?.stack || String(error),
        ms: Date.now() - started
      };
    }
    results.push({ name: gate.name, guards: gate.guards, ...outcome });
  }

  const pad = (value, width) => String(value).padEnd(width);
  const nameWidth = Math.max(...results.map(r => [...r.name].length)) + 2;
  const line = '─'.repeat(nameWidth + 40);

  console.log('');
  console.log('代码质量门禁');
  console.log(line);
  for (const r of results) {
    console.log(`${r.ok ? '通过  ' : '未通过'} ${pad(r.name, nameWidth)} ${pad(r.summary, 22)} ${String(r.ms).padStart(5)} ms`);
  }
  console.log(line);

  const failed = results.filter(r => !r.ok);
  if (failed.length === 0) {
    console.log(`全部通过（${results.length} 道门禁）`);
    return 0;
  }

  console.log(`${failed.length} / ${results.length} 道门禁未通过：`);
  for (const r of failed) {
    console.log('');
    console.log(`✗ ${r.name}`);
    console.log(`  这道门在防：${r.guards}`);
    if (r.detail) {
      console.log('  详情：');
      for (const textLine of r.detail.split('\n').slice(0, 40)) console.log('    ' + textLine);
    }
  }
  return 1;
}

main().then(code => {
  if (verbose) console.log('');
  process.exitCode = code;
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
