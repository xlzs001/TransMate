// ---------------------------------------------------------------------------
// 硬信息一致性校验（翻译后比对原文与译文）
//
// 大模型翻译时偶尔会"顺手"改写不该变的东西：40HQ 写成 40GP、CIF 写成 CFR、
// USD 12.5 写成 12.50、型号少一位、数量从 500 变成 5,000。这类错误人眼扫一遍
// 几乎发现不了，但外贸里错一位就是事故。
//
// 只做高置信、低误报的检查，命中一律表述为"请核对"，不做任何自动修改。
// 全部是本地字符串处理：不增加 API 调用、不增加网络延迟。
//
// 误报与漏报的取舍：这里的取向是"宁可多提醒一次，也不要漏掉一次改写"。
// 所以中文容器写法、货币的中文说法与符号都做了归一，尽量不因为换了写法就误报。
//
// 结构：抽取（extract）与比对（compare）两段，各自按"事实类型"拆成独立函数。
// 新增一类硬信息，两边各加一个函数、各往一张表里加一行即可。
// ---------------------------------------------------------------------------

(function () {
  "use strict";

  const INCOTERMS = ["EXW", "FCA", "FAS", "FOB", "CFR", "CIF", "CPT", "CIP", "DAP", "DPU", "DDP"];
  const INCOTERM_PATTERN = /(?<![A-Z])(EXW|FCA|FAS|FOB|CFR|CIF|CPT|CIP|DAP|DPU|DDP)(?![A-Z])/g;

  // 模型经常把术语直接意译成中文：EXW → 出厂价、FOB → 离岸价。
  // 这时英文缩写确实"消失"了，但意思完全正确，属于翻译得好，不能报。
  // 反过来也一样：原文写"出厂价"、译文写 EXW，同样不该报"多出术语"。
  const INCOTERM_CN_ALIASES = {
    EXW: ["出厂价", "出厂价格", "工厂交货", "工厂交货价", "出厂交货", "出厂交货价"],
    FCA: ["货交承运人", "交承运人"],
    FAS: ["船边交货", "装运港船边交货"],
    FOB: ["离岸价", "离岸价格", "船上交货", "装运港船上交货"],
    CFR: ["成本加运费", "运费在内"],
    CIF: ["到岸价", "到岸价格", "成本加保险费加运费", "成本、保险费加运费", "成本保险费加运费", "成本加保险及运费"],
    CPT: ["运费付至"],
    CIP: ["运费和保险费付至", "运费保险费付至", "运费及保险费付至"],
    DAP: ["目的地交货"],
    DPU: ["卸货地交货", "目的地卸货交货"],
    DDP: ["完税后交货", "含税交货", "完税交货"]
  };

  // 货币统一到一个规范代码。RMB 归到 CNY，避免"人民币/RMB/CNY/￥"四种写法互相误报。
  const CURRENCY_CODE_SET = new Set([
    "USD", "EUR", "CNY", "RMB", "JPY", "GBP", "HKD", "AUD", "CAD", "KRW", "SGD",
    "INR", "RUB", "BRL", "MXN", "THB", "VND", "IDR", "MYR", "PHP", "TRY", "ZAR",
    "AED", "SAR", "PLN", "SEK", "NOK", "DKK", "CHF", "NZD", "TWD", "KZT", "UAH",
    "EGP", "NGN", "PKR", "BDT", "LKR"
  ]);
  const CURRENCY_WORDS = {
    "新加坡元": "SGD", "人民币": "CNY", "雷亚尔": "BRL", "迪拉姆": "AED",
    "美元": "USD", "美金": "USD", "美刀": "USD", "欧元": "EUR", "日元": "JPY",
    "日圆": "JPY", "英镑": "GBP", "港币": "HKD", "港元": "HKD", "澳元": "AUD",
    "澳币": "AUD", "加元": "CAD", "加币": "CAD", "韩元": "KRW", "新元": "SGD",
    "卢比": "INR", "卢布": "RUB", "比索": "MXN", "泰铢": "THB", "兰特": "ZAR",
    "里拉": "TRY", "兹罗提": "PLN", "块钱": "CNY", "元": "CNY"
  };
  // 符号存在多义（$ 可能是 USD / AUD / CAD / HKD ...），所以映射到一组候选，
  // 与另一侧只要有一个候选相同就算一致。
  const CURRENCY_SYMBOLS = {
    "$": ["USD", "AUD", "CAD", "HKD", "SGD", "NZD", "MXN"],
    "€": ["EUR"], "£": ["GBP"], "¥": ["CNY", "JPY"], "￥": ["CNY", "JPY"],
    "₩": ["KRW"], "₹": ["INR"], "₽": ["RUB"], "฿": ["THB"]
  };

  // 型号：字母在前、数字在后，例如 HR-2400、ABC1234、ISO9001。
  // 字母部分要排除货币代码、贸易术语和常见单位缩写，否则 USD12、FOB1000 会被误判成型号。
  const MODEL_PATTERN = /(?<![A-Z0-9])([A-Z]{2,8})[-/]?(\d{2,6})([A-Z]{0,6})(?![A-Z0-9])/g;
  const NON_MODEL_PREFIXES = new Set([
    ...INCOTERMS, ...CURRENCY_CODE_SET,
    "PCS", "SET", "SETS", "KGS", "MMS", "CMS", "CTN", "CTNS", "PKG", "PKGS",
    "CBM", "MOQ", "QTY", "TTL", "NOS", "GWS", "NWS", "INC", "LTD", "CO", "REF",
    "NO", "QTY", "PCT", "PCS"
  ]);

  // 柜型：40HQ / 40'HQ / 40 HC / 40 尺高柜。HC 与 HQ 是同一规格，统一成 HQ。
  const CONTAINER_PATTERN = /(?<![\d.])(20|40|45)\s*['’]?\s*(GP|HQ|HC|OT|FR|RF|TK|PF)\b/gi;
  const CONTAINER_CN_PATTERN = /(?<![\d.])(20|40|45)\s*(?:尺|英尺|呎)\s*(高柜|高箱|普柜|平柜|普通柜|标准柜|开顶柜|开顶|框架柜|框架)?/g;
  const CONTAINER_CN_TYPES = {
    "高柜": "HQ", "高箱": "HQ", "普柜": "GP", "平柜": "GP", "普通柜": "GP",
    "标准柜": "GP", "开顶柜": "OT", "开顶": "OT", "框架柜": "FR", "框架": "FR"
  };

  const CHINESE_NUMERALS = /[零一二三四五六七八九十百千万亿两壹贰叁肆伍陆柒捌玖拾佰仟]/;
  const CN_NUMERAL_PATTERN = /[零〇一二三四五六七八九两壹贰叁肆伍陆柒捌玖十拾百佰千仟万亿]+/g;
  const CN_DIGITS = {
    "零": 0, "〇": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5,
    "六": 6, "七": 7, "八": 8, "九": 9,
    "壹": 1, "贰": 2, "叁": 3, "肆": 4, "伍": 5, "陆": 6, "柒": 7, "捌": 8, "玖": 9
  };
  const CN_SMALL_UNITS = { "十": 10, "拾": 10, "百": 100, "佰": 100, "千": 1000, "仟": 1000 };
  const CN_BIG_UNITS = { "万": 1e4, "亿": 1e8 };

  // 只认规范千分位分组（1,200 / 1 200 / 12,345,678）或普通数字。
  // 不能写成 \d[\d, ]*：那样 "HR-2400, 20GP" 会被读成一个数 240020。
  const NUMBER_PATTERN = /\d{1,3}(?:[,\u00a0 ]\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g;
  const CURRENCY_CODE_PATTERN = /(?<![A-Z])([A-Z]{3})(?![A-Z])/g;
  // 长词优先：否则"新元"会先被"元"匹配走，记成 CNY 而不是 SGD。
  const CURRENCY_WORD_PATTERN = new RegExp(
    Object.keys(CURRENCY_WORDS).sort((a, b) => b.length - a.length).join("|"),
    "g"
  );

  /** 解析一段连续的中文数字（"六" → 6、"二十三" → 23、"三万" → 30000）。 */
  function parseChineseNumber(run) {
    let total = 0;
    let section = 0;
    let digit = 0;
    let seen = false;
    for (const char of run) {
      if (char in CN_DIGITS) {
        digit = CN_DIGITS[char];
        seen = true;
      } else if (char in CN_SMALL_UNITS) {
        section += (digit || 1) * CN_SMALL_UNITS[char];
        digit = 0;
        seen = true;
      } else if (char in CN_BIG_UNITS) {
        section = (section + digit) * CN_BIG_UNITS[char];
        total += section;
        section = 0;
        digit = 0;
        seen = true;
      }
    }
    const value = total + section + digit;
    return seen && Number.isFinite(value) ? value : 0;
  }

  /**
   * 把译文里的中文数字还原成阿拉伯数字，只在"数字丢失"这个方向上做补偿。
   *
   * 模型经常把 "6-layer" 顺手写成"六层"，这类改写完全正确，但阿拉伯数字就"消失"了，
   * 于是误报"原文的数字 6 没有出现在译文里"。
   * 反向（译文多出数字）仍然只看阿拉伯数字——否则"一共""一些""一直"里的"一"
   * 会凭空造出一堆数字，全是误报。
   */
  function chineseNumeralsAsDigits(text) {
    const found = new Set();
    for (const match of String(text || "").matchAll(CN_NUMERAL_PATTERN)) {
      const value = parseChineseNumber(match[0]);
      if (value > 0) found.add(String(value));
    }
    return found;
  }

  /** 术语是否出现在文本里：英文缩写按词边界匹配，中文意译按别名匹配。 */
  function incotermAppearsIn(text, term) {
    const value = String(text || "");
    if (new RegExp(`(?<![A-Z])${term}(?![A-Z])`).test(value.toUpperCase())) return true;
    return (INCOTERM_CN_ALIASES[term] || []).some((alias) => value.includes(alias));
  }

  /** 去掉千分位与首尾零，让 1,200 / 1200 / 01200 视为同一个数，12.50 与 12.5 也视为相同。 */
  function normalizeNumber(raw) {
    let value = String(raw || "").replace(/[,\u00a0\s]/g, "");
    value = value.replace(/\.$/, "");
    if (value.includes(".")) {
      value = value.replace(/0+$/, "").replace(/\.$/, "");
    } else {
      value = value.replace(/^0+(?=\d)/, "");
    }
    return value;
  }

  // -------------------------------------------------------------------------
  // 抽取
  //
  // 每类事实一个函数，签名统一 (source, upper, facts)：
  // source 是原文，upper 是原文大写（避免每个函数各转一次），facts 是累加目标。
  // 用不到 source 或 upper 的函数保持同样的签名，是为了能放进 FACT_COLLECTORS
  // 里统一驱动 —— 加一类事实只需要加一个函数和一行表项。
  // -------------------------------------------------------------------------

  function collectNumbers(source, upper, facts) {
    for (const match of source.matchAll(NUMBER_PATTERN)) {
      const value = normalizeNumber(match[0]);
      if (value) facts.numbers.add(value);
    }
  }

  function collectIncoterms(source, upper, facts) {
    for (const match of upper.matchAll(INCOTERM_PATTERN)) facts.incoterms.add(match[1]);
  }

  function collectCurrencies(source, upper, facts) {
    // 中文说法：三千美元 里的"美元"。
    for (const match of source.matchAll(CURRENCY_WORD_PATTERN)) {
      facts.currencies.add(CURRENCY_WORDS[match[0]]);
    }
    // 符号：$ 有多义，命中就把所有候选都记上，与另一侧有一个相同即算一致。
    for (const [symbol, codes] of Object.entries(CURRENCY_SYMBOLS)) {
      if (source.includes(symbol)) codes.forEach((code) => facts.currencies.add(code));
    }
    // 三字母代码：RMB 归一到 CNY。
    for (const match of upper.matchAll(CURRENCY_CODE_PATTERN)) {
      if (!CURRENCY_CODE_SET.has(match[1])) continue;
      facts.currencies.add(match[1] === "RMB" ? "CNY" : match[1]);
    }
  }

  function collectContainers(source, upper, facts) {
    for (const match of upper.matchAll(CONTAINER_PATTERN)) {
      const type = match[2].toUpperCase();
      facts.containers.add(`${match[1]}${type === "HC" ? "HQ" : type}`);
    }
    for (const match of source.matchAll(CONTAINER_CN_PATTERN)) {
      facts.containers.add(`${match[1]}${CONTAINER_CN_TYPES[match[2]] || "GP"}`);
    }
  }

  function collectModels(source, upper, facts) {
    for (const match of upper.matchAll(MODEL_PATTERN)) {
      if (NON_MODEL_PREFIXES.has(match[1])) continue;
      facts.models.add(`${match[1]}${match[2]}${match[3]}`);
    }
  }

  const FACT_COLLECTORS = [collectNumbers, collectIncoterms, collectCurrencies, collectContainers, collectModels];

  function extractHardFacts(text) {
    const source = String(text || "");
    const upper = source.toUpperCase();
    const facts = {
      numbers: new Set(),
      incoterms: new Set(),
      currencies: new Set(),
      containers: new Set(),
      models: new Set(),
      // 原文里如果出现中文数字（"三千套"），译文的阿拉伯数字就无法与原文一一对应，
      // 这种情况下只报"数字丢失"，不报"多出数字"，否则全是误报。
      hasChineseNumerals: CHINESE_NUMERALS.test(source)
    };

    for (const collect of FACT_COLLECTORS) collect(source, upper, facts);
    return facts;
  }

  // -------------------------------------------------------------------------
  // 比对
  // -------------------------------------------------------------------------

  const join = (set) => [...set].join(" / ");

  /**
   * 数字：译文允许把数字写成中文，所以"丢失"方向要先把中文数字折算进来。
   * "多出"方向反过来只看阿拉伯数字 —— 见 chineseNumeralsAsDigits 的说明。
   */
  function compareNumbers(source, target, translatedText, push) {
    const translatedNumbers = new Set(target.numbers);
    for (const value of chineseNumeralsAsDigits(translatedText)) translatedNumbers.add(value);

    for (const value of source.numbers) {
      if (!translatedNumbers.has(value)) push("number", value, `原文的数字 ${value} 没有出现在译文里`);
    }
    if (source.hasChineseNumerals) return;
    for (const value of target.numbers) {
      if (!source.numbers.has(value)) push("number", value, `译文出现了原文没有的数字 ${value}`);
    }
  }

  /**
   * 需要"双向比对"的三类事实。每类只描述三件事：取哪一组、报什么 kind、
   * 怎么判断"它在文本里"。之前这三类各手写了两段一模一样的循环，
   * 改一次措辞要同步改六处，漏一处就是文案不一致。
   */
  const BIDIRECTIONAL_FACTS = [
    {
      field: "incoterms",
      kind: "incoterm",
      label: "贸易术语",
      // 术语可能被意译成中文（EXW → 出厂价），所以必须回到文本里找，不能只看抽取结果。
      appearsIn: (facts, text, token) => incotermAppearsIn(text, token)
    },
    {
      field: "containers",
      kind: "container",
      label: "柜型",
      // 抽取时已把 HC 归一到 HQ、中文柜型归一到 GP，所以直接比集合就够了。
      appearsIn: (facts, text, token) => facts.containers.has(token)
    },
    {
      field: "models",
      kind: "model",
      label: "型号",
      appearsIn: (facts, text, token) => facts.models.has(token)
    }
  ];

  function compareBidirectionalFacts(source, target, sourceText, translatedText, push) {
    for (const fact of BIDIRECTIONAL_FACTS) {
      for (const token of source[fact.field]) {
        if (!fact.appearsIn(target, translatedText, token)) {
          push(fact.kind, token, `${fact.label} ${token} 在译文里丢失或被改写`);
        }
      }
      for (const token of target[fact.field]) {
        if (!fact.appearsIn(source, sourceText, token)) {
          push(fact.kind, token, `译文出现了原文没有的${fact.label} ${token}`);
        }
      }
    }
  }

  /**
   * 货币不按"逐个比对"处理：符号与中文说法都会展开成一组候选，
   * 只要两边有一个共同代码就算一致，全都对不上才提示"可能不一致"。
   */
  function compareCurrencies(source, target, push) {
    if (!source.currencies.size) return;
    if (!target.currencies.size) {
      push("currency", join(source.currencies), `译文里没有出现货币单位（原文为 ${join(source.currencies)}）`);
      return;
    }
    const shared = [...source.currencies].some((code) => target.currencies.has(code));
    if (!shared) {
      push("currency", join(source.currencies), `货币单位可能不一致：原文 ${join(source.currencies)}，译文 ${join(target.currencies)}`);
    }
  }

  function compareHardFacts(sourceText, translatedText) {
    const source = extractHardFacts(sourceText);
    const target = extractHardFacts(translatedText);
    const warnings = [];
    const push = (kind, token, message) => warnings.push({ kind, token, message });

    // 顺序决定截断时谁先被留下：数字 -> 术语/柜型/型号 -> 货币。
    // 数字与型号是最容易出事故的，所以排在最前面。
    compareNumbers(source, target, translatedText, push);
    compareBidirectionalFacts(source, target, sourceText, translatedText, push);
    compareCurrencies(source, target, push);

    // 单条消息最多报 6 条，避免长文本刷屏把真正重要的一条淹掉。
    return warnings.slice(0, 6);
  }

  /** 对外入口：任何异常都不应该让翻译本身失败，所以这里兜底返回空数组。 */
  function verifyTranslation(sourceText, translatedText) {
    if (!sourceText || !translatedText) return [];
    try {
      return compareHardFacts(String(sourceText), String(translatedText));
    } catch (_) {
      return [];
    }
  }

  globalThis.TLP_VERIFY = Object.freeze({
    extractHardFacts,
    compareHardFacts,
    verifyTranslation,
    normalizeNumber,
    parseChineseNumber,
    chineseNumeralsAsDigits,
    incotermAppearsIn
  });
})();
