/**
 * 变异测试：确认回归测试不是摆设。
 *
 * 做法很朴素 —— 故意把代码改坏，跑一遍回归测试，如果它还是绿的，
 * 说明这块代码根本没被测到。覆盖率只告诉你"这行被执行过"，
 * 变异测试才告诉你"这行改坏了会不会被发现"。两者不是一回事。
 *
 * 全程在进程内完成：借 regression-checks 的源码覆盖钩子把文件换成改坏的版本，
 * 不启动子进程，也不动磁盘上的任何文件。整轮约 1 秒，所以能当门禁跑。
 *
 * 用法：node temp/mutation-test.cjs [关键字]
 * 退出码非 0 表示有变异"存活"（改坏了测试却没红），或者锚点失效。
 *
 * 锚点失效也算失败：锚点是精确字符串，代码一改就可能对不上。
 * 如果这里放水，锚点会慢慢腐烂，最后整份变异测试变成空转 —— 那还不如没有。
 */
const fs = require('node:fs');
const path = require('node:path');
const { run: runRegression, setSourceOverrides } = require('./regression-checks.cjs');

const root = path.resolve(__dirname, '..');

/**
 * (标题, 文件, 原文, 改后, 提示关键字)
 *
 * 判定标准只有一条：改坏以后回归测试必须变红。末尾那个关键字不参与判定，
 * 只在失败信息里没出现时提醒你确认"是被对的用例抓住的"，
 * 避免出现"恰好被另一个测试兜住"的假阳性。
 */
const MUTATIONS = [
  // 批量出口必须经过统一的收口函数，否则结果形状会散开 ——
  // 这正是 v3.9.10 "AI 批量漏传参数、换个服务商就静默失效"那类事故的温床。
  // 由"聊天批量翻译的四条出口给出同一个结果形状"抓住（结构守卫 + 行为验证两道）。
  ['后台：批量出口绕过 toChatResult 自己拼对象', 'background.js',
    '.map((item) => toChatResult(item, byId.get(item.id) || ""))',
    '.map((item) => ({ id: item.clientId, text: byId.get(item.id) || "" }))',
    '四个出口都要经过 toChatResult'],
  // 下面这条锚点本身就是一行源码，里面的 ${clean} 是代码而不是模板占位符，
  // 所以整条写成一行，让豁免注释正好落在含该字符串的那行上。
  // eslint-disable-next-line no-template-curly-in-string
  ['弹窗：停用本站不再覆盖子域名', 'popup.js', 'host.endsWith(`.${clean}`)', 'false', '子域名'],
  ['聊天：语言缓存不再看置信度门槛', 'timezone.js',
    '&& freshLanguage.confidence >= 60', '&& freshLanguage.confidence >= 0', '置信度'],
  ['号码：手动填写的值不再优先', 'timezone.js',
    'const phone = manualPhone || detectedPhone || cachedPhone || null;',
    'const phone = detectedPhone || cachedPhone || null;',
    '手动值必须压过页面扫描值'],
  ['号码：自动识别值又把手动值冲掉', 'timezone.js',
    'if (detectedPhone && !manualPhone && cachedPhone !== detectedPhone) {',
    'if (detectedPhone && cachedPhone !== detectedPhone) {',
    '手动值会被冲掉'],
  ['后台：长输入不再预检（又把注定失败的请求发出去）', 'background.js',
    'if (source.length > MAX_TRANSLATION_INPUT) {', 'if (false) {',
    '不该把注定失败的请求发出去'],
  ['后台：推理模型的输出预算不再抬高', 'background.js',
    'const floor = reasoning ? minimum * REASONING_MINIMUM_FACTOR : minimum;',
    'const floor = minimum;',
    '输出预算必须高于普通模型'],
  // 下面三条来自 v3.9.12 修掉的缺陷。它们的共同点是"不报错，只是白花钱或功能静默失效"，
  // 最容易在后续重构里被顺手改回去，所以放进变异测试常驻看护。
  ['聊天翻译：中文原文不再被跳过（白花钱 + 重复气泡）', 'timezone.js',
    'if (/^zh-(?:tw|hk|mo|hant)\\b/i.test(normalizedTarget)) return false;',
    'if (targetBase === "zh" && normalizedTarget.includes("-")) return false;',
    'zh-CN 下中文不该再送去翻译'],
  ['设置页：数字输入框清空后存成 0 而不是默认值', 'options.js',
    'if (!raw) return fallback;', 'if (false) return fallback;',
    '空串要返回 fallback'],
  ['后台：批量翻译的数字 id 再次连坐整批', 'background.js',
    'typeof row !== "object" || typeof row.text !== "string"',
    'typeof row !== "object" || typeof row.id !== "string" || typeof row.text !== "string"',
    '批量翻译包含无效项目']
];

const read = file => fs.readFileSync(path.join(root, file), 'utf8');

/** 取第一条断言信息，供人判断"是被对的用例抓住的吗"。 */
function firstFailure(error) {
  const line = String(error?.message || error).split('\n').find(text => text.trim());
  return (line || '（没有错误信息）').trim().slice(0, 150);
}

async function run(keyword = '') {
  const selected = MUTATIONS.filter(([title, file]) => !keyword || file.includes(keyword) || title.includes(keyword));
  const problems = [];
  const lines = [];

  const originals = new Map();
  for (const [, file] of selected) {
    if (!originals.has(file)) originals.set(file, read(file));
  }

  // 先确认未改动的代码是绿的。基线就是红的，后面所有结论都不成立。
  try {
    await runRegression();
  } catch (error) {
    return {
      ok: false, caught: 0, total: selected.length,
      problems: [`基线回归测试就没通过，先把它修绿再谈变异：${firstFailure(error)}`],
      lines
    };
  }

  let caught = 0;
  for (const [title, file, before, after, hint] of selected) {
    const original = originals.get(file);
    const occurrences = original.split(before).length - 1;
    if (occurrences !== 1) {
      problems.push(`${title}：锚点在 ${file} 里出现 ${occurrences} 次（需要恰好 1 次）—— 代码改过就同步更新锚点`);
      lines.push(`[失效] ${title}`);
      continue;
    }

    let error = null;
    setSourceOverrides({ [file]: original.replace(before, after) });
    try {
      await runRegression();
    } catch (failure) {
      error = failure;
    } finally {
      setSourceOverrides(null);
    }

    if (!error) {
      problems.push(`${title}：改坏了但回归测试仍然全绿 —— ${file} 这块逻辑没有被任何用例覆盖`);
      lines.push(`[漏掉] ${title}`);
      continue;
    }

    caught += 1;
    lines.push(`[抓住] ${title}`);
    lines.push(`       ${firstFailure(error)}`);
    if (!String(error.message).includes(hint)) {
      lines.push(`       注意：失败信息里没有出现“${hint}”，确认一下是被对的用例抓住的`);
    }
  }

  return { ok: problems.length === 0, caught, total: selected.length, problems, lines };
}

module.exports = { run, MUTATIONS };

if (require.main === module) {
  run(process.argv[2] || '').then(result => {
    for (const line of result.lines) console.log(line);
    console.log();
    if (result.ok) {
      console.log(`${result.caught} / ${result.total} 个变异全部被抓住`);
      return;
    }
    console.log(`${result.total - result.caught} / ${result.total} 个变异没被抓住 —— 对应的测试需要补：`);
    for (const problem of result.problems) console.log('  - ' + problem);
    process.exitCode = 1;
  }).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
