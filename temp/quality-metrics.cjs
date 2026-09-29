/**
 * 代码质量度量（AST 级，不是数行数）
 *
 * 只量四件事，都是"能直接指向一次重构"的：
 *   1. 函数长度  —— 超过 80 行基本就该拆
 *   2. 圈复杂度  —— 超过 15 基本就该拆分支
 *   3. 嵌套深度  —— 超过 4 层基本就该用卫语句提前返回
 *   4. 重复代码  —— 连续 6 行以上雷同，多半该抽函数
 *
 * 用法：node temp/quality-metrics.cjs [--json]
 */
const fs = require('node:fs');
const path = require('node:path');
const acorn = require('acorn');

const root = path.resolve(__dirname, '..');

// 只统计我们自己的代码。timezone.js 里夹着 3200 行第三方打包产物，
// 用源码里的 eslint-disable / eslint-enable 标记把那段剔掉。
const FILES = [
  'background.js',
  'content.js',
  'providers.js',
  'options.js',
  'popup.js',
  'verify.js',
  'timezone.js'
];

const VENDOR_START = '/* eslint-disable */';
const VENDOR_END = '/* eslint-enable */';

function loadSource(file) {
  const raw = fs.readFileSync(path.join(root, file), 'utf8');
  const lines = raw.split('\n');
  let skip = new Set();
  let vendored = 0;
  if (file === 'timezone.js') {
    const start = lines.findIndex(line => line.includes(VENDOR_START));
    const end = lines.findIndex(line => line.includes(VENDOR_END));
    if (start !== -1 && end !== -1) {
      for (let i = start; i <= end; i += 1) skip.add(i);
      vendored = end - start + 1;
    }
  }
  return { lines, skip, vendored };
}

const BRANCH_NODES = new Set([
  'IfStatement', 'ConditionalExpression', 'ForStatement', 'ForInStatement',
  'ForOfStatement', 'WhileStatement', 'DoWhileStatement', 'CatchClause',
  'LogicalExpression'
]);

const FUNCTION_NODES = new Set([
  'FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'
]);

function walk(node, visit, depth = 0) {
  if (!node || typeof node.type !== 'string') return;
  visit(node, depth);
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'start' || key === 'end') continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child.type === 'string') walk(child, visit, depth + 1);
      }
    } else if (value && typeof value.type === 'string') {
      walk(value, visit, depth + 1);
    }
  }
}

function functionName(node, parentName) {
  if (node.id?.name) return node.id.name;
  if (node.key?.name) return node.key.name;
  if (node.key?.value) return String(node.key.value);
  return parentName || '(anonymous)';
}

/**
 * 找出顶层 IIFE 外壳 `(function () { ... })()` / `(() => { ... })()`。
 * 它把整个文件包起来，行数和复杂度等于全文件之和，会把统计彻底带偏
 * （timezone.js 的"最长函数 5020 行 / 复杂度 1243"就是这个壳，不是真函数）。
 * 所以单独标记出来，不计入函数度量。
 */
function findTopLevelWrappers(ast) {
  const wrappers = new Set();
  for (const statement of ast.body) {
    if (statement.type !== 'ExpressionStatement') continue;
    const expr = statement.expression;
    if (expr?.type !== 'CallExpression') continue;
    const callee = expr.callee;
    if (callee?.type === 'FunctionExpression' || callee?.type === 'ArrowFunctionExpression') {
      wrappers.add(callee);
    }
  }
  return wrappers;
}

function analyze(file) {
  const { lines, skip, vendored } = loadSource(file);
  const ast = acorn.parse(lines.join('\n'), {
    ecmaVersion: 2023,
    sourceType: 'script',
    locations: true,
    allowReturnOutsideFunction: true
  });

  const wrappers = findTopLevelWrappers(ast);
  const functions = [];
  const emptyCatches = [];
  let maxDepth = 0;

  const measure = (node) => {
    let branches = 1;
    let depth = 0;
    const stack = [[node, 0]];
    while (stack.length) {
      const [current, currentDepth] = stack.pop();
      if (!current || typeof current.type !== 'string') continue;
      if (BRANCH_NODES.has(current.type)) {
        if (current.type !== 'LogicalExpression'
          || current.operator === '&&' || current.operator === '||' || current.operator === '??') {
          branches += 1;
        }
      }
      if (current.type === 'BlockStatement') depth = Math.max(depth, currentDepth);
      for (const key of Object.keys(current)) {
        if (key === 'type' || key === 'start' || key === 'end') continue;
        const value = current[key];
        if (Array.isArray(value)) {
          for (const child of value) {
            if (child && typeof child.type === 'string') stack.push([child, currentDepth + 1]);
          }
        } else if (value && typeof value.type === 'string') {
          stack.push([value, currentDepth + 1]);
        }
      }
    }
    return { branches, depth };
  };

  walk(ast, (node, depth) => {
    maxDepth = Math.max(maxDepth, depth);
    if (FUNCTION_NODES.has(node.type)) {
      const name = functionName(node, node.id?.name);
      const startLine = node.loc.start.line;
      const endLine = node.loc.end.line;
      // 跳过落在 vendored 区段里的函数，以及顶层 IIFE 外壳
      if (skip.has(startLine - 1)) return;
      if (wrappers.has(node)) return;
      const { branches, depth: innerDepth } = measure(node);
      functions.push({
        name,
        line: startLine,
        length: endLine - startLine + 1,
        complexity: branches,
        depth: innerDepth
      });
    }
    if (node.type === 'CatchClause' && node.body.body.length === 0) {
      // vendored 区段里的空 catch 是第三方打包产物，不是我们要管的对象
      if (skip.has(node.loc.start.line - 1)) return;
      // 空 catch 本身不算错，"没写为什么可以吞"才是错。
      // 说明可以写在 catch 前面，也可以写在块内的第一行，所以两头都看。
      const startLine = node.loc.start.line;                 // 1-based，指向 catch 那行
      const context = lines.slice(Math.max(0, startLine - 4), startLine + 1).join('\n');
      const documented = /\/\/|\/\*/.test(context);
      emptyCatches.push({ line: startLine, documented });
    }
  });

  // 有效代码行：去掉空行、纯注释行、以及 vendored 区段
  let codeLines = 0;
  lines.forEach((line, index) => {
    if (skip.has(index)) return;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) return;
    codeLines += 1;
  });

  return { file, codeLines, vendored, functions, emptyCatches, maxDepth };
}

/** 连续 N 行雷同即视为重复。注释和空行先归一化掉。 */
function findDuplication(allFiles, window = 6) {
  const seen = new Map();
  for (const { file, lines, skip } of allFiles) {
    const normalized = lines.map((line, index) => {
      if (skip.has(index)) return null;
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return null;
      return trimmed.replace(/\s+/g, ' ');
    });
    for (let i = 0; i + window <= normalized.length; i += 1) {
      const slice = normalized.slice(i, i + window);
      if (slice.some(item => item === null)) continue;
      const key = slice.join('\n');
      if (key.length < 120) continue;                       // 太短的不算
      if (!seen.has(key)) seen.set(key, []);
      seen.get(key).push(`${file}:${i + 1}`);
    }
  }
  return [...seen.entries()]
    .filter(([, places]) => places.length > 1)
    .map(([key, places]) => ({ lines: key.split('\n').length, places }))
    .sort((a, b) => b.lines - a.lines);
}

/** 跑完全部分析，返回结构化报告。不打印、不退出，方便被门禁运行器复用。 */
function analyzeAll() {
  const results = FILES.map(analyze);
  const raw = FILES.map(file => ({ file, ...loadSource(file) }));
  const duplicates = findDuplication(raw);

  const allFunctions = results.flatMap(r => r.functions.map(fn => ({ ...fn, file: r.file })));
  const totalCode = results.reduce((sum, r) => sum + r.codeLines, 0);

  // 2 行以内、且复杂度为 1 的函数，几乎都是查表用的取值器（`() => ["jpn", 1]`）
  // 或数组回调。它们不该和真正的业务函数一起算中位数，否则"把 if 链改成数据表"
  // 这种好事反而会让函数总数上涨、看起来像退步。
  const isTrivial = fn => fn.length <= 2 && fn.complexity <= 1;
  const substantial = allFunctions.filter(fn => !isTrivial(fn));

  const summarize = numbers => {
    const sorted = [...numbers].sort((a, b) => a - b);
    const at = p => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] || 0;
    return { max: sorted.at(-1) || 0, p90: at(0.9), median: at(0.5) };
  };

  return {
    totalCodeLines: totalCode,
    vendoredLinesExcluded: results.reduce((sum, r) => sum + r.vendored, 0),
    functionCount: allFunctions.length,
    trivialFunctionCount: allFunctions.length - substantial.length,
    substantialFunctionCount: substantial.length,
    functionLength: summarize(substantial.map(f => f.length)),
    complexity: summarize(substantial.map(f => f.complexity)),
    emptyCatchCount: results.reduce((sum, r) => sum + r.emptyCatches.length, 0),
    emptyCatchUndocumented: results.reduce((sum, r) => sum + r.emptyCatches.filter(c => !c.documented).length, 0),
    emptyCatches: results.flatMap(r => r.emptyCatches.map(c => ({ file: r.file, line: c.line, documented: c.documented }))),
    duplicateBlocks: duplicates.length,
    worstByLength: [...substantial].sort((a, b) => b.length - a.length).slice(0, 12),
    worstByComplexity: [...substantial].sort((a, b) => b.complexity - a.complexity).slice(0, 12),
    perFile: results.map(r => ({
      file: r.file,
      codeLines: r.codeLines,
      functions: r.functions.length,
      longest: Math.max(0, ...r.functions.map(f => f.length)),
      mostComplex: Math.max(0, ...r.functions.map(f => f.complexity))
    })),
    duplication: duplicates.slice(0, 8)
  };
}

function printReport(report) {
  const pad = (value, width) => String(value).padEnd(width);
  console.log('=== 代码规模 ===');
  console.log(`自有代码行数（不含注释/空行/第三方）：${report.totalCodeLines}`);
  console.log(`已排除的第三方代码行数：${report.vendoredLinesExcluded}`);
  console.log(`函数总数：${report.functionCount}（其中 ${report.trivialFunctionCount} 个是 2 行以内的取值器/回调，不计入下面的分布）`);
  console.log(`计入统计的函数：${report.substantialFunctionCount}`);
  console.log();
  console.log('=== 函数长度（行） ===');
  console.log(`最长 ${report.functionLength.max} / P90 ${report.functionLength.p90} / 中位数 ${report.functionLength.median}`);
  console.log();
  console.log('=== 圈复杂度 ===');
  console.log(`最高 ${report.complexity.max} / P90 ${report.complexity.p90} / 中位数 ${report.complexity.median}`);
  console.log();
  console.log('=== 按文件 ===');
  console.log(pad('文件', 16), pad('有效行', 8), pad('函数', 6), pad('最长', 6), '最复杂');
  for (const row of report.perFile) {
    console.log(pad(row.file, 16), pad(row.codeLines, 8), pad(row.functions, 6), pad(row.longest, 6), row.mostComplex);
  }
  console.log();
  console.log('=== 最长的 12 个函数 ===');
  for (const fn of report.worstByLength) {
    console.log(pad(`${fn.file}:${fn.line}`, 26), pad(fn.name, 32), `${fn.length} 行`);
  }
  console.log();
  console.log('=== 最复杂的 12 个函数 ===');
  for (const fn of report.worstByComplexity) {
    console.log(pad(`${fn.file}:${fn.line}`, 26), pad(fn.name, 32), `复杂度 ${fn.complexity}`);
  }
  console.log();
  console.log(`=== 空 catch 块：${report.emptyCatchCount} 处（其中 ${report.emptyCatchUndocumented} 处没有说明为什么可以吞） ===`);
  for (const item of report.emptyCatches) {
    console.log(`  ${pad(`${item.file}:${item.line}`, 26)} ${item.documented ? '已说明' : '← 无说明'}`);
  }
  console.log(`=== 连续 6 行以上的重复代码块：${report.duplicateBlocks} 组 ===`);
  for (const dup of report.duplication) {
    console.log(`  ${dup.lines} 行雷同 → ${dup.places.join('  /  ')}`);
  }
}

/**
 * 全部函数（带 file 字段），不做 top-N 截断。
 * 质量预算门禁要用它逐个比对上限，不能只看前 12 个。
 */
function collectFunctions() {
  return FILES.flatMap(file => analyze(file).functions.map(fn => ({ ...fn, file })));
}

module.exports = { analyzeAll, collectFunctions, printReport };

if (require.main === module) {
  const report = analyzeAll();
  if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else printReport(report);
}
