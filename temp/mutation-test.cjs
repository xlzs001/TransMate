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
  ['硬信息：柜型 HC 不再归一到 HQ', 'verify.js',
    'type === "HC" ? "HQ" : type', 'type', '40HC'],
  ['硬信息：数字丢失不再折算中文数字', 'verify.js',
    'for (const value of chineseNumeralsAsDigits(translatedText)) translatedNumbers.add(value);',
    'for (const value of []) translatedNumbers.add(value);',
    '没有出现在译文里'],
  ['硬信息：原文有中文数字时仍报“多出数字”', 'verify.js',
    'if (source.hasChineseNumerals) return;', 'if (false) return;',
    '出现了原文没有的数字'],
  ['硬信息：货币候选从“任一命中”改成“全部命中”', 'verify.js',
    '[...source.currencies].some((code) => target.currencies.has(code))',
    '[...source.currencies].every((code) => target.currencies.has(code))',
    'currency'],
  ['硬信息：不再排除 USD12 这类“金额+数字”', 'verify.js',
    'if (NON_MODEL_PREFIXES.has(match[1])) continue;', 'if (false) continue;',
    'USD12'],
  ['硬信息：数字抽取退回 \\d[\\d, ]*（会把 HR-2400, 20GP 读成一个数）', 'verify.js',
    'const NUMBER_PATTERN = /\\d{1,3}(?:[,\\u00a0 ]\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?/g;',
    'const NUMBER_PATTERN = /\\d[\\d,\\u00a0 ]*/g;',
    '240020'],
  ['后台：译文出口丢掉 warnings', 'background.js',
    'return { text: output, targetLanguage: target.code, warnings: TLP_VERIFY.verifyTranslation(text, output) };',
    'return { text: output, targetLanguage: target.code };',
    'warnings'],
  ['后台：批量出口绕过 withWarnings 自己拼对象', 'background.js',
    '.map((item) => withWarnings(item, byId.get(item.id) || ""))',
    '.map((item) => ({ id: item.clientId, text: byId.get(item.id) || "" }))',
    'withWarnings'],
  // 下面这条锚点本身就是一行源码，里面的 ${clean} 是代码而不是模板占位符，
  // 所以整条写成一行，让豁免注释正好落在含该字符串的那行上。
  // eslint-disable-next-line no-template-curly-in-string
  ['弹窗：停用本站不再覆盖子域名', 'popup.js', 'host.endsWith(`.${clean}`)', 'false', '子域名'],
  ['聊天：语言缓存不再看置信度门槛', 'timezone.js',
    '&& freshLanguage.confidence >= 60', '&& freshLanguage.confidence >= 0', '置信度']
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
