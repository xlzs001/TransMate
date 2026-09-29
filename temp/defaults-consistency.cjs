/**
 * 默认值一致性门禁
 *
 * 背景：本项目同一份"设置默认值"被手写了 5 份 ——
 *   options.js  : DEFAULTS（权威全集）
 *   options.js  : APPEARANCE_DEFAULTS（子集）
 *   options.js  : CHAT_DEFAULTS（子集）
 *   popup.js    : DEFAULTS（子集）
 *   timezone.js : DISPLAY_DEFAULTS（content script 侧的另一份）
 *
 * 加一个新设置就要人工同步 5 处，漏掉任何一处都不会报错，只会静默用错默认值。
 * 这个脚本把它变成机器能查的不变量：
 *
 *   R1  options.js:DEFAULTS 是唯一权威；其余 4 份都必须是它的子集
 *   R2  同名键的默认值必须逐字相同（类型 + 值）
 *   R3  DISPLAY_DEFAULTS 必须覆盖 DEFAULTS 里的全部键（content script 要读全部）
 *   R4  键名必须落在已知前缀里，避免拼写错误悄悄新增一个"孤儿设置"
 *
 * 用法：node temp/defaults-consistency.cjs
 * 退出码非 0 表示门禁不通过。
 */
const fs = require('node:fs');
const path = require('node:path');
const acorn = require('acorn');

const root = path.resolve(__dirname, '..');

const SOURCES = {
  'options.js:DEFAULTS': { file: 'options.js', name: 'DEFAULTS' },
  'options.js:APPEARANCE_DEFAULTS': { file: 'options.js', name: 'APPEARANCE_DEFAULTS' },
  'options.js:CHAT_DEFAULTS': { file: 'options.js', name: 'CHAT_DEFAULTS' },
  'popup.js:DEFAULTS': { file: 'popup.js', name: 'DEFAULTS' },
  'timezone.js:DISPLAY_DEFAULTS': { file: 'timezone.js', name: 'DISPLAY_DEFAULTS' }
};

/** 允许出现的前缀。写错的键名会在这里被拦下。 */
const KEY_PREFIXES = ['provider', 'api', 'model', 'enabled', 'trigger', 'direction',
  'translation', 'customer', 'disabled', 'wat'];

/** 已知且允许的例外：只存在于某一侧的键。每一条都要写理由。 */
const ALLOWED_EXTRA = {
  // content script 自己维护的拖拽坐标，不需要进设置页
  'timezone.js:DISPLAY_DEFAULTS': ['watCustomX', 'watCustomY']
};

/**
 * DISPLAY_DEFAULTS 除了全部 wat* 键之外，还必须带上这几个非 wat 键。
 * 理由：timezone.js 的 applyChatTranslationConfig / providerFingerprint 会读它们
 * （见 timezone.js:3899-3901、4033-4035），缺了就会算出错误的缓存指纹。
 * apiKey / enabled / triggerCount 等是 content.js 的设置，这里刻意不要求。
 */
const DISPLAY_REQUIRED_NON_WAT = [
  'provider', 'providerConfigs', 'providerModelCache', 'model', 'translationProfile'
];

function parseObjectLiteral(file, varName) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const ast = acorn.parse(source, { ecmaVersion: 2023, sourceType: 'script', locations: true });

  let found = null;
  const stack = [ast];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node.type !== 'string') continue;
    if (node.type === 'VariableDeclarator'
      && node.id?.name === varName
      && node.init?.type === 'ObjectExpression') {
      found = node.init;
      break;
    }
    for (const key of Object.keys(node)) {
      if (key === 'type' || key === 'start' || key === 'end') continue;
      const value = node[key];
      if (Array.isArray(value)) {
        for (const child of value) if (child && typeof child.type === 'string') stack.push(child);
      } else if (value && typeof value.type === 'string') stack.push(value);
    }
  }
  if (!found) throw new Error(`在 ${file} 里找不到对象字面量 ${varName}`);

  const entries = new Map();
  for (const property of found.properties) {
    if (property.type !== 'Property') continue;
    const key = property.key.name ?? property.key.value;
    entries.set(String(key), {
      line: property.loc.start.line,
      literal: property.value.type === 'Literal' ? property.value.value : undefined,
      isLiteral: property.value.type === 'Literal'
    });
  }
  return entries;
}

/**
 * 执行全部规则。
 * 返回 { sources, problems }，不直接打印、不调 process.exit —— 交给调用方决定怎么呈现。
 */
function run() {
  const problems = [];
  const load = {};
  for (const [label, { file, name }] of Object.entries(SOURCES)) {
    load[label] = parseObjectLiteral(file, name);
  }

  const authority = load['options.js:DEFAULTS'];

  // R4：键名前缀
  for (const [label, entries] of Object.entries(load)) {
    for (const [key, meta] of entries) {
      if (!KEY_PREFIXES.some(prefix => key.startsWith(prefix))) {
        problems.push(`${label} 第 ${meta.line} 行：键名 ${key} 不在已知前缀里（疑似拼写错误或忘了归类）`);
      }
    }
  }

  for (const [label, entries] of Object.entries(load)) {
    if (label === 'options.js:DEFAULTS') continue;
    const allowedExtra = ALLOWED_EXTRA[label] || [];

    // R1：子集关系
    for (const key of entries.keys()) {
      if (authority.has(key)) continue;
      if (allowedExtra.includes(key)) continue;
      problems.push(`${label} 有键 ${key}，但权威 DEFAULTS 里没有（要么补进 DEFAULTS，要么加进 ALLOWED_EXTRA 并写明理由）`);
    }

    // R2：同名键的值必须一致
    for (const [key, meta] of entries) {
      const ref = authority.get(key);
      if (!ref) continue;
      if (!meta.isLiteral || !ref.isLiteral) continue;         // 对象/数组不比较字面量
      if (meta.literal !== ref.literal) {
        problems.push(`${label} 第 ${meta.line} 行：${key} 默认值 ${JSON.stringify(meta.literal)} 与 DEFAULTS 的 ${JSON.stringify(ref.literal)} 不一致`);
      }
    }
  }

  // R3：DISPLAY_DEFAULTS 必须覆盖 content script 真正要读的键
  const display = load['timezone.js:DISPLAY_DEFAULTS'];
  const requiredInDisplay = [
    ...[...authority.keys()].filter(key => key.startsWith('wat')),
    ...DISPLAY_REQUIRED_NON_WAT
  ];
  for (const key of requiredInDisplay) {
    if (!display.has(key)) {
      problems.push(`timezone.js:DISPLAY_DEFAULTS 缺少 ${key}（content script 读不到这个设置，会静默用错默认值）`);
    }
  }

  const sources = Object.entries(load).map(([label, entries]) => ({ label, keys: entries.size }));
  return { sources, problems, authoritySize: authority.size };
}

module.exports = { run };

if (require.main === module) {
  const { sources, problems, authoritySize } = run();
  console.log('=== 默认值一致性检查 ===');
  console.log('权威来源：options.js:DEFAULTS，共 ' + authoritySize + ' 个键');
  for (const source of sources) {
    console.log(`  ${source.label.padEnd(30)} ${String(source.keys).padStart(3)} 个键`);
  }
  console.log();
  if (problems.length === 0) {
    console.log('通过：5 份默认值定义彼此一致。');
    process.exit(0);
  }
  console.log(`发现 ${problems.length} 个问题：`);
  for (const problem of problems) console.log('  - ' + problem);
  process.exit(1);
}
