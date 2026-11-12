/* =========================================================================
 * BOSS 直聘 · 批量投递助手  (Content Script)
 * -------------------------------------------------------------------------
 * 设计原则：
 *   1. 硬条件先筛 —— 城市 / 薪资 / 专业 / 编程语言 / 关键词，不满足直接跳过
 *   2. 手填条件评分 —— 目标岗位 / 技能词算匹配分，低于阈值不投
 *   3. 节奏可控 —— 间隔 8-15 秒随机，绝不快速连点
 *   4. 本地去重 —— 同一岗位永不重复投递
 *   5. 全自动 —— 自动翻页、自动跳过、达到上限自动停
 *   6. 随时可停 —— 面板 / 弹窗 / ESC 都能立即中断
 * ========================================================================= */
(function () {
  'use strict';

  if (window.__BAA_LOADED__) return;
  window.__BAA_LOADED__ = true;

  /* ------------------------------------------------------------------ *
   * 常量
   * ------------------------------------------------------------------ */
  const CFG_KEY = 'baa_cfg_v1';
  const STORE_KEY = 'baa_store_v1';

  const DEFAULT_CFG = {
    /* ---- 我的条件（全部手填，不再识别简历） ---- */
    sweepMode: false,                              // 海投模式：跳过软筛选，但硬条件仍生效
    goalJob: '',                                   // 目标岗位，如「前端开发」
    skills: '',                                    // 技能标签，逗号分隔
    years: '3',                                    // 工作年限
    edu: '本科',                                    // 最高学历
    cities: '',                                    // 期望城市，逗号分隔（硬筛选）
    useResume: true,                               // 兼容旧配置：语义 = 按手填条件算匹配分
    recruitType: '',                               // '' = 自动识别；social / campus / intern

    /* ---- 专业 / 编程语言：用户自己填，作为硬条件 ---- */
    major: '',                                     // 我的专业，逗号分隔；例「计算机相关」
    majorFilter: true,                            // 填了才生效：JD 限专业且不匹配 → 跳过
    langOwned: '',                                 // 我勾选会的编程语言，逗号分隔
    langFilter: true,                             // 勾了才生效：JD 硬要求没勾的语言 → 跳过

    /* ---- 硬筛选 ---- */
    include: '',                                   // 必含关键词
    exclude: '销售,保险,中介,外包,驻场',             // 排除关键词
    useInclude: false,                             // 必含关键词开关（默认关：填了也不生效，要自己打开）
    useExclude: true,                              // 排除关键词开关
    minSalary: 0,                                  // 最低月薪 K（0 = 不限）
    maxSalary: 0,                                  // 最高月薪 K（0 = 不限）
    minScore: 60,                                  // 匹配分阈值
    freshMax: 0,                                   // 只要多久内发布/活跃的（小时，0=不限）
    passVague: true,                               // 信息模糊的岗位放行（不按分数杀）

    /* ---- 证书 ---- */
    certFilter: true,                              // 硬性要求未持有证书的岗位跳过
    certOwned: '',                                 // 我持有的证书，逗号分隔

    /* ---- 岗位详情（JD）硬性要求 ---- */
    jdScan: true,                                  // 点开详情后读取 JD 全文并结构化识别要求
    jdBlock: true,                                 // 按识别出的明确硬性要求自动跳过（关掉=只记录不拦）
    fetchDetail: false,                            // 主动补一次详情接口（额外请求，默认关）
    jdReject: '',                                  // 我不能接受的工作条件，逗号分隔
    strictCity: true,                              // 地点确认不了就不投（防止选杭州投到南京）
    companyIdDedup: true,                          // 用 BOSS 公司 ID 去重，同公司不同 HR 也算一家

    /* ---- 大模型语义判断（把 JD 全文交给模型读，默认关） ---- */
    aiEnabled: false,                             // 关掉时行为与旧版完全一致
    aiProvider: 'deepseek',                        // OpenAI 兼容服务商预设 id
    aiBaseUrl: 'https://api.deepseek.com/v1',
    aiModel: 'deepseek-chat',
    aiApiKey: '',                                  // 只存本地 chrome.storage.local，发给用户自己选的服务商
    aiMode: 'veto',                                // veto=只拦硬性不符 / score=按分阈值 / log=只记录
    aiMinScore: 60,
    aiTimeout: 20,                                 // 单次调用超时（秒）
    aiMaxChars: 12000,                            // JD 全文最多送多少字
    aiExtra: '',                                   // 我补充的判断要求
    aiSendProfile: true,                           // 是否把技能/目标岗位等补充条件一起发给模型
    aiFailOpen: true,                              // 调用失败时按原规则放行（绝不卡死海投）

    /* ---- 公司筛选 ---- */
    scaleList: '',                                 // 公司规模，如 "100-499,500-999"
    financeList: '',                               // 融资阶段，如 "已上市,C轮"
    companyInclude: '',                            // 公司名必含（限投这些公司）
    companyExclude: '',                            // 公司名排除
    companyDedup: true,                            // 同一公司只投一次（跨岗位）

    /* ---- 节奏 ---- */
    dailyLimit: 150,                               // 每日上限
    gapMin: 8,                                     // 最小间隔（秒）
    gapMax: 15,                                    // 最大间隔（秒）
    detailClick: true,                             // 逐条点开卡片，用右侧详情面板里的沟通按钮
    detailWait: 3,                                 // 切换职位后等详情加载的最长秒数（网慢调大）
    detailRetry: 3,                                // 详情没加载出来时，换位置重新点卡片的次数
    scrollWait: 1.4,                               // 滚动后等新卡片加载的秒数
    forceOpenDetail: true,                         // 逐个点开当前岗位卡片、读完 JD 再判断（1.12.0）
    strictDetail: true,                            // 详情没切到本岗位就绝不点旧按钮
    jdScroll: true,                                // JD 卡片内展开 + 逐屏滚动加载全文
    jdScrollWait: 160,                             // JD 每滚一屏等待的毫秒
    jdScrollSteps: 12,                             // JD 最多滚多少屏
    jdMaxChars: 12000,                             // JD 全文最多保留多少字
    autoScroll: true,
    onlyNew: true,
    freshFirst: false,                             // 优先投最新发布/活跃的
    dryRun: false,                                 // 全自动：默认正式投递

    ack: false                                     // 是否已确认过风险提示
  };

  /** 面板用的服务商预设。请与 background/ai-core.js 的 AI_PRESETS 保持一致，
   *  tests/ai.test.js 会断言两边同步，避免改了一边忘了另一边。 */
  const AI_PROVIDERS = [
    { id: 'deepseek', label: 'DeepSeek（便宜、推荐）', base: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    { id: 'moonshot', label: 'Kimi / Moonshot', base: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
    { id: 'dashscope', label: '通义千问（阿里）', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
    { id: 'zhipu', label: '智谱 GLM', base: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
    { id: 'siliconflow', label: '硅基流动', base: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct' },
    { id: 'openai', label: 'OpenAI', base: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    { id: 'hunyuan', label: '腾讯混元', base: 'https://api.hunyuan.cloud.tencent.com/v1', model: 'hunyuan-turbo' },
    { id: 'volcengine', label: '火山方舟（豆包）', base: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-1-5-lite-32k-250115' },
    { id: 'custom', label: '自定义（OpenAI 兼容）', base: '', model: '' }
  ];

  const EDU_LEVEL = { 不限: 0, 大专: 1, 本科: 2, 硕士: 3, 博士: 4 };

  /** 公司规模区间（与 BOSS 展示口径一致） */
  const SCALE_RANGES = [
    { id: '0-20', min: 0, max: 20, label: '0-20人' },
    { id: '20-99', min: 20, max: 99, label: '20-99人' },
    { id: '100-499', min: 100, max: 499, label: '100-499人' },
    { id: '500-999', min: 500, max: 999, label: '500-999人' },
    { id: '1000-9999', min: 1000, max: 9999, label: '1000-9999人' },
    { id: '10000+', min: 10000, max: Infinity, label: '10000人以上' }
  ];

  /** 融资阶段 */
  const FINANCE_STAGES = ['未融资', '天使轮', 'A轮', 'B轮', 'C轮', 'D轮及以上', '已上市', '不需要融资'];

  /** 发布时间档位（hours = 允许的最大年龄，0 = 不限） */
  const FRESH_OPTIONS = [
    { id: 'all', hours: 0, label: '不限' },
    { id: '24h', hours: 24, label: '24小时内' },
    { id: '3d', hours: 72, label: '3天内' },
    { id: '7d', hours: 168, label: '7天内' },
    { id: '15d', hours: 360, label: '15天内' },
    { id: '30d', hours: 720, label: '30天内' }
  ];

  const CARD_SELECTORS = [
    '.job-card-wrapper',
    '.job-card-box',
    '.job-list-box .job-card-body',
    '.search-job-result .job-card-wrapper',
    'li.job-card-wrapper'
  ];

  /* ------------------------------------------------------------------ *
   * 状态
   * ------------------------------------------------------------------ */
  let cfg = Object.assign({}, DEFAULT_CFG);
  let store = { applied: {}, daily: {}, companies: {} };

  const st = {
    running: false,
    stop: false,
    scanned: 0,
    skipped: 0,
    applied: 0,                                    // 本轮真正投出去的
    today: 0,
    logs: [],
    lastTop: -1,
    stuck: 0,
    skipReasons: {},                               // { code: { n, label } }
    runCompanies: new Set(),                       // 本轮已投公司（名字归一化 key）
    runCompanyIds: new Set(),                      // 本轮已投公司（BOSS 公司 ID，跨 HR 精确）
    lastReq: '',                                   // 最近一份岗位识别出的硬性要求
    jdLogged: 0
  };

  /** 跳过原因的短标签，用于面板统计 */
  const SKIP_LABEL = {
    no_title: '未解析职位名',
    no_include: '未命中关键词',
    exclude: '命中排除词',
    cert: '要求证书',
    company_not_in: '不在公司白名单',
    company_black: '公司黑名单',
    scale: '公司规模不符',
    finance: '融资阶段不符',
    city: '城市不符',
    salary: '薪资不符',
    edu: '学历不够',
    type: '招聘类型不符',
    years: '经验要求过高',
    fresh: '发布太久',
    chatted: '已沟通过',
    no_btn: '找不到沟通按钮',
    detail_timeout: '详情加载超时',
    detail_stale: '详情仍停在上一份岗位',
    detail_off: '逐条点开职位已关闭',
    score: '匹配分不够',
    dup_job: '岗位已投过',
    dup_company: '公司已投过',
    city_unknown: '地点无法确认',
    jd_cert: 'JD 要求证书',
    jd_edu: 'JD 学历不够',
    jd_years: 'JD 经验过高',
    jd_reject: 'JD 含不接受条件',
    jd_major: 'JD 限专业',
    jd_lang: 'JD 要求不会的语言',
    ai_hard: 'AI 判定硬性不符',
    ai_score: 'AI 匹配分低',
    ai_error: 'AI 调用失败'
  };

  function bumpSkip(code, detail) {
    if (!code) return;
    const cur = st.skipReasons[code] || { n: 0, label: SKIP_LABEL[code] || code, detail: '' };
    cur.n++;
    if (detail) cur.detail = detail;
    st.skipReasons[code] = cur;
  }

  /** 按次数排序的跳过原因 */
  function topSkips(limit) {
    return Object.keys(st.skipReasons)
      .map((k) => Object.assign({ code: k }, st.skipReasons[k]))
      .sort((a, b) => b.n - a.n)
      .slice(0, limit || 99);
  }

  /** 针对主因给出「下一步改哪个开关」，而不是只说数字 */
  function adviceFor(code) {
    const n = (st.skipReasons[code] || {}).n || 0;
    switch (code) {
      case 'no_include':
        return '「必含关键词」把岗位全挡住了。取消它的「启用」勾选，或只留一个最宽泛的词。';
      case 'score':
        return (
          '匹配分阈值 ' + cfg.minScore + ' 太高，或目标岗位和当前搜索结果不是一类。' +
          '把阈值降到 30–40，或点「一键放宽筛选」。'
        );
      case 'chatted':
        return '这些岗位都已经沟通过了。换一批搜索结果，或关掉「只投未沟通的」。';
      case 'dup_company':
        return (
          '公司去重已锁了 ' + Object.keys(store.companies || {}).filter((k) => k.indexOf('id:') !== 0).length +
          ' 家公司，它们旗下岗位全跳过。想放开就关掉「同一公司只投一次」，或点去重区的「清空」。'
        );
      case 'dup_job':
        return '这些岗位之前投过，属于正常去重。换搜索词或换城市能找到新岗位。';
      case 'cert':
        return '证书过滤开着，但你没勾任何证书，所有提到证书的岗位都被挡了。勾上你有的证，或关掉「硬性要求证书的不投」。';
      case 'city':
        return '城市不匹配。区名（西湖区、滨江区等）现在会自动按城市识别；若仍被拦，清空「期望城市」，或确认填的是城市名而不是区名 / 拼音。';
      case 'salary':
        return '薪资区间把岗位挡掉了：多半是下限设太高（实习日薪会折算成月薪，特别容易踩）。';
      case 'years':
        return '经验要求过高。校招 / 实习模式会跳过要求 2 年以上的岗位，切回社招试试。';
      case 'edu':
        return '岗位学历要求高于面板里填的学历。把「学历」改成你的实际最高学历。';
      case 'exclude':
        return '排除词命中太多：检查「排除关键词」里有没有过于宽泛的词，比如「外包」「驻场」会误伤很多正常岗位。';
      case 'city_unknown':
        return '卡片和详情都没写出地点，按「地点确认不了就不投」跳过了。想放开就关掉这个开关；更推荐在 BOSS 上把搜索城市选准。';
      case 'jd_cert':
        return 'JD 里明确要求你没有的证书。勾上你持有的证书，或关掉「硬性要求证书的不投」，或关掉 JD 自动拦截。';
      case 'jd_edu':
      case 'jd_years':
        return '岗位 JD 里的学历 / 经验门槛高于你填的条件。确认面板上「最高学历」「工作年限」填的是真实情况，或关掉 JD 自动拦截。';
      case 'jd_major':
        return 'JD 明确限专业，和你填的「' + (cfg.major || '空') + '」对不上。把「我的专业」写得宽一点（例：计算机相关），或关掉「专业不符就跳过」。';
      case 'jd_lang':
        return 'JD 硬性要求你没勾的编程语言。到「我会的编程语言」里勾上会的，或关掉「语言不符就跳过」。';
      case 'jd_reject':
        return '岗位 JD 命中了你勾选的「不接受条件」。不想拦就取消对应勾选。';
      case 'ai_hard':
        return '大模型从 JD 全文里读出了你明确不满足的硬性要求。先确认面板里「学历 / 年限 / 证书」填的是真实情况；不想让 AI 拦，把判断方式改成「只记录不拦截」。';
      case 'ai_score':
        return 'AI 匹配分低于阈值。把「AI 最低分」调低，或把判断方式改成「只拦硬性不符」。';
      case 'ai_error':
        return '大模型调用失败，而且你关掉了「失败时按原规则放行」。检查 API Key / 网络，或勾回失败放行。';
      case 'no_btn':
        return '多数岗位找不到「立即沟通」按钮：确认「逐条点开职位再投」是开着的（列表+右侧详情布局必须开），再把日志里「↳ 卡片上的文字」那一行发我。';
      case 'detail_timeout':
        return '点开卡片后右侧详情没加载出来：网络慢就把「详情加载等待」调到 6–10 秒，重试次数调到 3；「滚动加载等待」也一起调大。';
      case 'fresh':
        return '发布时间档位太严，改成「不限」或「30 天内」。';
      case 'scale':
      case 'finance':
        return '公司规模 / 融资筛选太窄，先把这两项清空试试。';
      case 'type':
        return '招聘类型不符：换回社招，或改成你要的那几种。';
      default:
        return '看面板顶部那排跳过原因标签，占比最高的那个就是主因（共 ' + n + ' 个）。';
    }
  }

  let ui = null;
  let saveTimer = null;

  /* ------------------------------------------------------------------ *
   * 基础工具
   * ------------------------------------------------------------------ */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (a, b) => {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    return Math.floor(Math.random() * (hi - lo + 1)) + lo;
  };

  function todayKey() {
    const d = new Date();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + day;
  }

  const splitList = (s) =>
    String(s || '')
      .split(/[,，\n\r;；]/)
      .map((x) => x.trim())
      .filter(Boolean);

  /** 判断当前处于社招 / 校招 / 实习 频道 */
  function detectRecruitType() {
    const u = (location.href || '').toLowerCase();
    if (/intern|shixi/.test(u)) return 'intern';
    if (/campus|xiaozhao|student|school/.test(u)) return 'campus';

    const t = document.title || '';
    if (/实习/.test(t)) return 'intern';
    if (/校园招聘|校招/.test(t)) return 'campus';

    const nav = document.querySelector('.menu-list, .nav-bar, header, .header');
    if (nav) {
      const nt = nav.textContent || '';
      if (/实习/.test(nt)) return 'intern';
      if (/校园招聘|校招/.test(nt)) return 'campus';
    }

    return 'social';
  }

  function isVisible(el) {
    if (!el || typeof el.getBoundingClientRect !== 'function') return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) return false;
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none') return false;
    if (s.opacity === '0') return false;
    return true;
  }

  function hash(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return 'h' + Math.abs(h).toString(36);
  }

  /** 数值夹取：等待秒数允许小数，且必须挡住 NaN / 越界，避免死循环或 0 等待 */
  function clampNum(v, def, min, max) {
    const n = parseFloat(v);
    if (!isFinite(n)) return def;
    return Math.min(max, Math.max(min, n));
  }

  /* ------------------------------------------------------------------ *
   * BOSS 字体反混淆
   * ------------------------------------------------------------------ *
   * BOSS 把薪资等数字用自定义字体重映射成私用区码点（U+E000–U+F8FF …）。
   * 页面上靠 @font-face 正常显示数字，但 textContent 拿到的是缺字方框，
   * 直接存进投递记录就变成 "□□-□□K"。这里在页面内用 canvas 把字形比对回 0-9，
   * 映射表存进 storage，记录页拿它连历史数据一起还原。
   * ------------------------------------------------------------------ */
  const FONT_MAP_KEY = 'baa_font_map_v1';
  let fontDigitMap = {};

  function isPuaChar(ch) {
    const cp = String(ch).codePointAt(0);
    return (
      (cp >= 0xe000 && cp <= 0xf8ff) ||
      (cp >= 0xf0000 && cp <= 0xffffd) ||
      (cp >= 0x100000 && cp <= 0x10fffd)
    );
  }

  function hasBossCipher(s) {
    for (const ch of String(s || '')) {
      if (isPuaChar(ch) || ch === '\ufffd') return true;
    }
    return false;
  }

  /** 有映射就还原；没映射保留原字符，等映射表建好后再解。
   *  不能提前替换成 ?，否则已经存进历史的数据就永远救不回来了。 */
  function decodeBossText(text, map) {
    const m = map || fontDigitMap;
    let out = '';
    for (const ch of String(text || '')) out += m && m[ch] ? m[ch] : ch;
    return out;
  }

  /** 纯展示用：还原不了的加密字符统一显示成 ?，界面上不再出现缺字方框 */
  function safeText(text, map) {
    const m = map || fontDigitMap;
    let out = '';
    for (const ch of String(text || '')) {
      if (m && m[ch]) out += m[ch];
      else if (isPuaChar(ch) || ch === '\ufffd') out += '?';
      else out += ch;
    }
    return out;
  }

  /** 取元素上真正生效的自定义字体名（通用字体族不算） */
  function cipherFontFamily(el) {
    if (typeof getComputedStyle !== 'function' || !el) return '';
    try {
      const ff = getComputedStyle(el).fontFamily || '';
      const first = ff.split(',')[0].trim().replace(/^['"]|['"]$/g, '');
      if (!first) return '';
      if (/^(sans-serif|serif|monospace|system-ui|inherit|initial|unset|arial|helvetica|microsoft yahei|pingfang sc|times new roman)$/i.test(first)) {
        return '';
      }
      return first;
    } catch (e) {
      return '';
    }
  }

  /** canvas 字形比对：用同一个字体分别画「加密字符」和 0-9，取像素最像的那个数字 */
  async function buildFontDigitMap(seedEl) {
    if (typeof document === 'undefined' || !document.createElement) return {};
    try {
      // 字体加载慢也要放行，不能让「开始投递」卡在这一步
      if (document.fonts && document.fonts.ready) {
        await Promise.race([
          document.fonts.ready,
          new Promise((r) => setTimeout(r, 1500))
        ]);
      }
      let el = seedEl;
      if (!el) {
        const list = document.querySelectorAll('.salary, [class*="salary"]');
        el = list && list[0];
      }
      if (!el || !el.textContent) return {};
      let fam = cipherFontFamily(el);
      // 有些版本把加密字体挂在数字的内层 span 上，而不是 salary 容器
      if (!fam && el.querySelectorAll) {
        for (const k of el.querySelectorAll('*')) {
          fam = cipherFontFamily(k);
          if (fam) break;
        }
      }
      if (!fam) return {};
      const chars = Array.from(new Set(Array.from(el.textContent).filter(isPuaChar)));
      if (!chars.length) return {};

      const W = 64;
      const G = 4;
      const cv = document.createElement('canvas');
      cv.width = W;
      cv.height = W;
      const ctx = cv.getContext && cv.getContext('2d');
      if (!ctx || !ctx.getImageData) return {};

      const bitmap = (ch, font) => {
        ctx.clearRect(0, 0, W, W);
        try {
          ctx.font = '48px ' + font;
        } catch (e) {
          return null;
        }
        ctx.fillStyle = '#000';
        ctx.textBaseline = 'middle';
        ctx.fillText(ch, 2, W / 2);
        const data = ctx.getImageData(0, 0, W, W).data;
        const bits = [];
        for (let by = 0; by < W; by += G) {
          for (let bx = 0; bx < W; bx += G) {
            let a = 0;
            let n = 0;
            for (let y = by; y < by + G; y++) {
              for (let x = bx; x < bx + G; x++) {
                a += data[(y * W + x) * 4 + 3];
                n++;
              }
            }
            bits.push(a / (n || 1) > 40 ? 1 : 0);
          }
        }
        return bits;
      };
      const diff = (a, b) => {
        let d = 0;
        for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
        return d;
      };

      let best = {};
      // 优先用加密字体自己画基准数字（字形通常就是直接复制的，几乎 100% 重合）
      for (const font of ['"' + fam + '", sans-serif', 'sans-serif']) {
        const refs = [];
        for (let d = 0; d <= 9; d++) refs.push(bitmap(String(d), font));
        if (refs.some((r) => !r)) continue;
        const trial = {};
        for (const ch of chars) {
          const bits = bitmap(ch, font);
          if (!bits) continue;
          let bi = -1;
          let bd = Infinity;
          refs.forEach((r, i) => {
            const d = diff(bits, r);
            if (d < bd) {
              bd = d;
              bi = i;
            }
          });
          if (bi >= 0 && bd < bits.length * 0.28) trial[ch] = String(bi);
        }
        if (Object.keys(trial).length > Object.keys(best).length) best = trial;
        if (Object.keys(best).length === chars.length) break;
      }
      return best;
    } catch (e) {
      return {};
    }
  }

  /** 启动时探测一次，并把映射表共享给记录页（历史记录也能还原） */
  async function ensureFontDigitMap() {
    try {
      const saved = await storageGet(FONT_MAP_KEY);
      if (saved && typeof saved === 'object') fontDigitMap = Object.assign({}, saved);
    } catch (e) {}
    try {
      const fresh = await buildFontDigitMap();
      if (Object.keys(fresh).length) {
        fontDigitMap = Object.assign({}, fontDigitMap, fresh);
        await storageSet(FONT_MAP_KEY, fontDigitMap);
      }
    } catch (e) {}
    try {
      if (Object.keys(fontDigitMap).length) {
        log('已识别 BOSS 加密数字字体（' + Object.keys(fontDigitMap).length + ' 个字形），薪资不再显示成方框。', 'dim');
      }
    } catch (e) {}
  }

  /* ------------------------------------------------------------------ *
   * 存储
   * ------------------------------------------------------------------ */
  const storageGet = (key) =>
    new Promise((res) => chrome.storage.local.get(key, (r) => res(r[key])));
  const storageSet = (key, val) =>
    new Promise((res) => chrome.storage.local.set({ [key]: val }, res));

  async function loadAll() {
    const r = await chrome.storage.local.get([CFG_KEY, STORE_KEY]);
    if (r[CFG_KEY]) cfg = Object.assign({}, DEFAULT_CFG, r[CFG_KEY]);

    // 旧版默认排除词里带「实习」，会让实习岗全军覆没，迁移掉
    if (cfg.exclude === '销售,保险,中介,外包,驻场,实习') {
      cfg.exclude = '销售,保险,中介,外包,驻场';
    }
    if (r[STORE_KEY]) {
      store = Object.assign({ applied: {}, daily: {}, companies: {} }, r[STORE_KEY]);
      if (!store.applied) store.applied = {};
      if (!store.daily) store.daily = {};
      if (!store.companies) store.companies = {};
    }
    buildCompanyIndex();
    st.today = store.daily[todayKey()] || 0;
  }

  function saveCfg() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => storageSet(CFG_KEY, cfg), 250);
  }

  async function saveStore() {
    try {
      await storageSet(STORE_KEY, store);
    } catch (e) {
      log('配置写入失败：' + e.message, 'err');
    }
  }

  /* ------------------------------------------------------------------ *
   * 页面接口数据源（明文，优先级高于 DOM 猜测）
   * ------------------------------------------------------------------ *
   * bridge-inject.js 在 document_start 注入 page-bridge.js，被动读取 BOSS
   * 自己收到的 joblist / job.detail 响应。这里有：
   *   salaryDesc   明文薪资（不用再破解加密字体）
   *   companyName  公司全称（记录表不会再是「—」）
   *   encryptBrandId 公司唯一 ID（同公司不同 HR 也能精确去重）
   *   cityName / areaDistrict  准确城市（选杭州不会再投到南京）
   *   jobLabels / jobDegree / jobExperience / jobInfo  岗位要求
   * ------------------------------------------------------------------ */
  const PAGE_JOBS_KEY = '__baa_page_jobs__';
  let pageJobs = {};

  function absorbPageJobs(list) {
    (list || []).forEach((j) => {
      if (!j || typeof j !== 'object') return;
      const id = j.encryptJobId || (j.jobName + '|' + j.companyName);
      if (!id) return;
      pageJobs[id] = Object.assign({}, pageJobs[id] || {}, j);
    });
  }

  function loadPageJobs() {
    try {
      const raw = window.sessionStorage && sessionStorage.getItem(PAGE_JOBS_KEY);
      if (raw) {
        const m = JSON.parse(raw);
        absorbPageJobs(Object.keys(m || {}).map((k) => m[k]));
      }
    } catch (e) {}
    window.addEventListener('message', (e) => {
      const d = e && e.data;
      if (!d || d.__baa !== 1 || d.kind !== 'jobs') return;
      absorbPageJobs(d.jobs);
    });
  }

  function lookupPageJob(info) {
    const keys = Object.keys(pageJobs);
    if (!keys.length) return null;
    if (info.key && pageJobs[info.key]) return pageJobs[info.key];
    const t = String(info.title || '').replace(/\s/g, '');
    if (!t) return null;
    const hits = keys
      .map((k) => pageJobs[k])
      .filter((j) => String(j.jobName || '').replace(/\s/g, '') === t);
    if (!hits.length) return null;
    if (hits.length === 1) return hits[0];
    const c = String(info.company || '').replace(/\s/g, '');
    if (c) {
      const exact = hits.find(
        (j) => String(j.companyName || '').replace(/\s/g, '') === c
      );
      if (exact) return exact;
    }
    return hits[0];
  }

  /** 接口明文覆盖 DOM 猜测。返回 true 表示这份岗位拿到了结构化数据 */
  function applyPageJob(info) {
    const j = lookupPageJob(info);
    if (!j) return false;
    info.fromApi = true;
    if (j.encryptBrandId) info.companyId = String(j.encryptBrandId);
    if (j.companyName && !info.company) info.company = decodeBossText(j.companyName);
    if (j.salaryDesc && (!info.salary || hasBossCipher(info.salary))) {
      info.salary = decodeBossText(j.salaryDesc);
    }
    const parts = [j.cityName, j.areaDistrict, j.businessDistrict, j.jobArea].filter(Boolean);
    if (parts.length) info.apiArea = decodeBossText(parts.join('·'));
    const labels = Array.isArray(j.jobLabels) ? j.jobLabels : [];
    if (labels.length) {
      const merged = (info.tags || []).concat(labels.map((x) => decodeBossText(String(x))));
      info.tags = merged.filter((x, i) => x && merged.indexOf(x) === i);
    }
    if (j.jobInfo) {
      info.jd = ((info.jd || '') + ' ' + decodeBossText(j.jobInfo)).trim().slice(0, 8000);
    }
    if (j.jobDegree) info.apiEdu = String(j.jobDegree);
    if (j.jobExperience) info.apiYears = String(j.jobExperience);
    if (j.securityId) info.securityId = String(j.securityId);
    if (j.lid) info.lid = String(j.lid);
    return true;
  }

  /** 可选：主动补一次岗位详情（只在点开岗位时、且用户明确开启才发请求）。
   *  默认关闭 —— 被动拦截已经够用，额外请求可能触发 BOSS 风控。 */
  async function fetchJobDetail(info) {
    if (cfg.fetchDetail !== true || !info.key) return false;
    try {
      const q = ['jobId=' + encodeURIComponent(info.key)];
      if (info.securityId) q.push('securityId=' + encodeURIComponent(info.securityId));
      if (info.lid) q.push('lid=' + encodeURIComponent(info.lid));
      const res = await fetch(
        'https://www.zhipin.com/wapi/zpgeek/job/detail.json?' + q.join('&'),
        { credentials: 'include' }
      );
      const d = await res.json();
      const j = d && d.data && d.data.jobInfo;
      if (!j) return false;
      absorbPageJobs([Object.assign({ encryptJobId: info.key }, j)]);
      return applyPageJob(info);
    } catch (e) {
      return false;
    }
  }

  /* ------------------------------------------------------------------ *
   * 岗位卡片解析
   * ------------------------------------------------------------------ */
  function getCards() {
    const seen = new Set();
    const out = [];

    for (const sel of CARD_SELECTORS) {
      let nodes;
      try {
        nodes = Array.from(document.querySelectorAll(sel));
      } catch (e) {
        continue;
      }
      nodes = nodes.filter(isVisible);
      if (nodes.length) {
        nodes.forEach((n) => {
          if (!seen.has(n)) {
            seen.add(n);
            out.push(n);
          }
        });
        if (out.length >= 3) break;
      }
    }

    // 兜底：以「立即沟通 / 继续沟通」按钮反查卡片
    if (!out.length) {
      const btns = Array.from(document.querySelectorAll('a, button, span')).filter(
        (el) => isVisible(el) && /^(立即沟通|继续沟通|开聊)$/.test((el.textContent || '').trim())
      );
      btns.forEach((b) => {
        let n = b;
        for (let i = 0; i < 8 && n; i++) {
          n = n.parentElement;
          if (!n) break;
          if (n.querySelector('[class*="job-name"], .salary')) {
            if (!seen.has(n)) {
              seen.add(n);
              out.push(n);
            }
            break;
          }
        }
      });
    }

    return out;
  }

  function pickText(root, selectors, maxLen) {
    for (const s of selectors) {
      let els;
      try {
        els = root.querySelectorAll(s);
      } catch (e) {
        continue;
      }
      for (const el of els) {
        const t = decodeBossText((el.textContent || '').trim());
        // 泛选择器（如 [class*="area"]）容易抓到整块容器，用长度挡掉
        if (t && (!maxLen || t.length <= maxLen)) return t;
      }
    }
    return '';
  }

  /** 收集公司元信息文本（规模 / 融资阶段通常在这几个容器里） */
  function companyMetaText(card) {
    const sels = [
      '.company-tag-list',
      '[class*="company-tag"]',
      '.company-info',
      '.boss-info-attr',
      '.company-text'
    ];
    let t = '';
    for (const s of sels) {
      let els;
      try {
        els = card.querySelectorAll(s);
      } catch (e) {
        continue;
      }
      els.forEach((el) => {
        if (isVisible(el)) t += ' ' + (el.textContent || '');
      });
    }
    return t || (card.textContent || '');
  }

  /* ------------------------------------------------------------------ *
   * 发布时间 / 新鲜度
   * ------------------------------------------------------------------ *
   * 说明：BOSS 列表页大多不给精确发布日，只给两种线索——
   *   1) 「最新发布」「3天前发布」这类发布标识（部分卡片有）
   *   2) 「刚刚活跃」「3日内活跃」「本周活跃」这类 HR 活跃度（几乎每张卡都有）
   * 两者统一折算成"距今天数"，作为新鲜度阈值判定依据。
   * 有发布标识就优先用它，没有才退化成活跃度。
   * ------------------------------------------------------------------ */

  /** 收集卡片里的时间线索文本 */
  function freshText(card) {
    const sels = [
      '.job-card-footer',
      '[class*="job-card-footer"]',
      '[class*="info-publicize"]',
      '[class*="job-time"]',
      '[class*="publish"]',
      '[class*="active"]',
      '[class*="published"]'
    ];
    let t = '';
    for (const s of sels) {
      let els;
      try {
        els = card.querySelectorAll(s);
      } catch (e) {
        continue;
      }
      els.forEach((el) => {
        if (isVisible(el)) t += ' ' + (el.textContent || '');
      });
    }
    if (t.trim()) return t;

    // 兜底：整卡文本（正则足够具体，不会误吃"3-5年经验"）
    return card.textContent || '';
  }

  /**
   * 解析新鲜度 → { h, raw, kind }（纯文本版，方便单测）
   *   h    距今年龄（小时）
   *   raw  原始文案，写进记录表
   *   kind 'publish' 发布时间 / 'active' HR 活跃度
   * 解析不到返回 null
   */
  function parseFreshText(text) {
    if (!text) return null;
    const s = String(text).replace(/\s+/g, ' ').trim();
    if (!s) return null;
    const mk = (h, kind, raw) => ({ h, raw: raw || s.slice(0, 16), kind });
    let m;

    /* ---- 1) 明确的发布 / 更新标识 ---- */
    if (/(刚刚发布|刚刚更新|最新发布|今日发布)/.test(s)) {
      const raw = (s.match(/(刚刚发布|刚刚更新|最新发布|今日发布)/) || [])[0];
      return mk(0, 'publish', raw);
    }
    if ((m = s.match(/(\d+)\s*分钟前/))) return mk(parseInt(m[1], 10) / 60, 'publish', m[0]);
    if ((m = s.match(/(\d+)\s*小时前/))) return mk(parseInt(m[1], 10), 'publish', m[0]);
    if ((m = s.match(/(\d+)\s*天前/))) return mk(parseInt(m[1], 10) * 24, 'publish', m[0]);
    if (/昨天/.test(s)) return mk(24, 'publish', '昨天');
    if (/前天/.test(s)) return mk(48, 'publish', '前天');

    /* ---- 2) HR 活跃度（退化信号，多数卡片只有这个） ---- */
    if (/刚刚活跃|在线/.test(s)) return mk(0, 'active', '刚刚活跃');
    if ((m = s.match(/(\d+)\s*日内活跃/))) return mk(parseInt(m[1], 10) * 24, 'active', m[0]);
    if (/今日活跃|今天活跃/.test(s)) return mk(12, 'active', '今日活跃');
    if (/本周活跃/.test(s)) return mk(96, 'active', '本周活跃');
    if (/本月活跃/.test(s)) return mk(360, 'active', '本月活跃');
    if (/半年前/.test(s)) return mk(4320, 'active', '半年前');

    return null;
  }

  /** 从卡片提取新鲜度 */
  function parseFresh(card) {
    return parseFreshText(freshText(card));
  }

  /** 把小时数翻译成人话，用于日志 */
  function freshLabel(h) {
    if (!h) return '不限';
    if (h <= 24) return '24小时内';
    if (h % 24 === 0) return h / 24 + '天内';
    return Math.round(h / 24) + '天内';
  }

  /** 卡片整段文本兜底：新版搜索页把地区写成「杭州·西湖区」这种格式 */
  function guessAreaFromText(text) {
    const t = String(text || '').replace(/\s+/g, ' ');
    const m = t.match(/([\u4e00-\u9fa5]{2,6}(?:市)?)·([\u4e00-\u9fa5]{2,8}(?:区|县|新区))/);
    if (m) return m[0];
    // 只写区名时，必须在辖区表里，且排除「高新 / 经开」这类到处都有的泛词
    for (const d of Object.keys(DISTRICT_OWNERS)) {
      if (d.length < 2 || DISTRICT_OWNERS[d].length >= 4) continue;
      if (t.indexOf(d + '区') >= 0) return d + '区';
    }
    return '';
  }

  /** 公司名兜底：只认明确的公司后缀，避免把 JD 里的描述当公司 */
  function guessCompanyFromText(text) {
    const t = String(text || '');
    let m = t.match(/[\u4e00-\u9fa5A-Za-z0-9（）()·]{2,28}(?:有限公司|股份有限公司|集团|研究院|事务所)/);
    if (m) return m[0];
    // BOSS 上很多公司只显示品牌简称（「字节跳动」「某某科技」），没有工商后缀
    m = t.match(/[\u4e00-\u9fa5A-Za-z0-9]{2,16}(?:科技|网络|信息|智能|数据|软件|数字|云|传媒|咨询|实业|电子|生物|医疗|教育|文化|贸易|汽车|金融|设计|工程)/);
    return m ? m[0] : '';
  }

  function extract(card) {
    const title = pickText(card, [
      '.job-name',
      '[class*="job-name"]',
      '.job-title',
      '[class*="job-title"]',
      'a[href*="job_detail"]'
    ], 60);
    let company = pickText(card, [
      '.company-name',
      '[class*="company-name"]',
      '[class*="company-title"]',
      '[class*="company-info"] h3',
      'h3',
      '[class*="company"] a'
    ], 40);
    const salary = pickText(card, ['.salary', '[class*="salary"]'], 24);
    let area = pickText(card, [
      '.job-area',
      '[class*="job-area"]',
      '.job-area-wrapper',
      '[class*="job-location"]',
      '[class*="location"]',
      '[class*="area"]'
    ], 24);

    // 新版 /web/geek/jobs 的卡片里经常找不到公司 / 地区节点，用整卡文本兜一层
    const flat = decodeBossText(
      String((card.innerText || card.textContent || '')).replace(/\s+/g, ' ')
    );
    if (!company) company = guessCompanyFromText(flat);
    if (!area) area = guessAreaFromText(flat);

    const tags = Array.from(card.querySelectorAll('.tag-list li, [class*="tag-list"] li, .job-labels span'))
      .map((el) => decodeBossText((el.textContent || '').trim()))
      .filter(Boolean);

    // 公司元信息（规模 / 融资）
    const metaText = companyMetaText(card);
    const scale = parseCompanyScale(metaText);
    const finance = parseFinance(metaText);

    // 唯一 ID：优先取详情链接里的 jobId
    let key = '';
    const link = card.querySelector('a[href*="job_detail"]');
    if (link) {
      const m = (link.getAttribute('href') || '').match(/job_detail\/([^\/?#]+)/);
      if (m) key = m[1];
    }
    if (!key) key = hash(company + '|' + title + '|' + area);

    const btn = findBtn(card);
    const btnText = btn ? (btn.textContent || '').trim() : '';

    // 发布时间 / 新鲜度
    let fresh = null;
    try {
      fresh = parseFresh(card);
    } catch (e) {
      fresh = null;
    }
    if (!fresh || !fresh.raw) {
      const fm = flat.match(
        /刚刚活跃|今日活跃|今天活跃|\d+\s*日内活跃|本周活跃|本月活跃|最新发布|今天发布|昨日发布|昨天发布|\d+\s*天前发布|半年前活跃/
      );
      if (fm) fresh = Object.assign({}, fresh || {}, { raw: fm[0] });
    }

    const info = {
      el: card, key, title, company, salary, area, tags, scale, finance, fresh, btn, btnText
    };

    // 接口明文优先：薪资 / 公司 / 地区 / 标签 / JD 摘要全用页面自己的结构化数据
    applyPageJob(info);
    if (!info.area && info.apiArea) info.area = info.apiArea;
    if (needJdAnalysis() && info.jd) info.req = analyzeJD(info.jd, info);

    return info;
  }

  /** 按钮文案：BOSS 前后换过好几套，全收进来按文本找，比按 class 找稳 */
  const BTN_STRICT = /^(立即沟通|继续沟通|开聊|立即开聊|聊一聊|打招呼|立即投递|投递简历|我要沟通)$/;
  const BTN_LOOSE = ['立即沟通', '继续沟通', '开聊', '聊一聊', '打招呼', '投递简历', '立即投递', '我要沟通'];

  function nodeDepth(el) {
    let d = 0;
    let p = el;
    while (p) {
      d++;
      p = p.parentElement;
    }
    return d;
  }

  /**
   * 找沟通按钮
   * 关键教训：旧版限制 `children.length <= 1`，BOSS 的按钮内部套了图标 + 文字两层，
   * 直接被过滤掉 → 全都报「找不到沟通按钮」。现在不限制层级，改为按文案找最深的那个。
   */
  function findBtn(card) {
    const all = Array.from(card.querySelectorAll('a, button, span, div, i, em, strong'));
    const cands = all.filter(isVisible);
    if (!cands.length) return null;

    // 1) 文案完全匹配，取层级最深的（文本相同时，最深的才是真正可点的）
    const strict = cands.filter((el) => BTN_STRICT.test((el.textContent || '').trim()));
    if (strict.length) {
      strict.sort((a, b) => nodeDepth(b) - nodeDepth(a));
      return strict[0];
    }

    // 2) 文案包含，限制长度，避免把整块卡片当成按钮
    const loose = cands.filter((el) => {
      const t = (el.textContent || '').trim();
      if (!t || t.length > 20) return false;
      return BTN_LOOSE.some((w) => t.indexOf(w) >= 0);
    });
    if (loose.length) {
      loose.sort((a, b) => nodeDepth(b) - nodeDepth(a));
      return loose[0];
    }

    // 3) 属性兜底：BOSS 用 ka 埋点，类名也换过多次
    const byAttr =
      cands.find((el) => {
        const ka = el.getAttribute('ka') || '';
        const href = el.getAttribute('href') || '';
        const cls = el.getAttribute('class') || '';
        return /chat/i.test(ka) || /chat/i.test(href) || /chat/i.test(cls);
      }) || null;
    if (byAttr) return byAttr;

    // 4) 位置兜底：按钮可能被渲染到卡片容器外层，靠屏幕位置找最近的。
    //    但「左侧列表 + 右侧详情」布局里，右侧详情的按钮会被误认成第一张卡片的按钮，
    //    后续卡片又完全找不到 —— 表现就是「只能投一个」。开启逐条点开详情时停用这条兜底。
    if (cfg.detailClick === false) return findBtnByPosition(card);
    return null;
  }

  /** 全页沟通按钮缓存，避免每张卡片都做一次全文档查询 */
  let chatBtnCache = { at: 0, list: [] };

  function allChatBtns() {
    const now = Date.now();
    if (now - chatBtnCache.at < 3000) return chatBtnCache.list;
    const list = [];
    document.querySelectorAll('a, button, span').forEach((el) => {
      const t = (el.textContent || '').trim();
      if (!t || t.length > 12 || !BTN_STRICT.test(t)) return;
      if (!isVisible(el)) return;
      list.push(el);
    });
    chatBtnCache = { at: now, list };
    return list;
  }

  /**
   * 按屏幕位置找卡片对应的按钮
   * 只接受垂直中心落在卡片范围内的按钮，避免点到相邻卡片的按钮。
   */
  function findBtnByPosition(card) {
    const r = card.getBoundingClientRect();
    if (!r.width || !r.height) return null;

    const midY = r.top + r.height / 2;
    let best = null;
    let bestD = Infinity;

    for (const el of allChatBtns()) {
      const b = el.getBoundingClientRect();
      const cy = b.top + b.height / 2;
      if (cy < r.top - 8 || cy > r.bottom + 8) continue;
      // 垂直越接近卡片中线、水平越靠右，越像是这张卡片的按钮
      const d = Math.abs(cy - midY) + Math.abs(b.left - r.right) * 0.15;
      if (d < bestD) {
        bestD = d;
        best = el;
      }
    }
    return best;
  }

  /** 诊断：把卡片里所有短文案列出来，找不到按钮时写进日志，便于定位真实文案 */
  function btnProbe(card) {
    const out = [];
    const els = card.querySelectorAll('a, button, span');
    for (const el of els) {
      if (!isVisible(el)) continue;
      const t = (el.textContent || '').trim();
      if (!t || t.length > 12 || out.indexOf(t) >= 0) continue;
      out.push(t);
      if (out.length >= 8) break;
    }
    return out.join(' / ');
  }

  /* ------------------------------------------------------------------ *
   * 筛选引擎
   * ------------------------------------------------------------------ */

  /** 解析薪资 → {min, max}，统一折算成「月薪 K」；解析失败返回 null */
  function parseSalary(text) {
    if (!text) return null;
    const s = String(text);

    // 15-25K·14薪
    let m = s.match(/(\d+(?:\.\d+)?)\s*[-~－]\s*(\d+(?:\.\d+)?)\s*[Kk千]/);
    if (m) return { min: parseFloat(m[1]), max: parseFloat(m[2]) };

    // 20K 以上 / 20K+
    m = s.match(/(\d+(?:\.\d+)?)\s*[Kk千]\s*(?:以上|\+)/);
    if (m) return { min: parseFloat(m[1]), max: parseFloat(m[1]) * 1.6 };

    // 1.5-2.5万
    m = s.match(/(\d+(?:\.\d+)?)\s*[-~－]\s*(\d+(?:\.\d+)?)\s*万/);
    if (m) return { min: parseFloat(m[1]) * 10, max: parseFloat(m[2]) * 10 };

    // 单个 20K
    m = s.match(/(\d+(?:\.\d+)?)\s*[Kk千]/);
    if (m) return { min: parseFloat(m[1]), max: parseFloat(m[1]) };

    // 150-200元/天（实习岗）：按 21.75 个工作日/月折算成 K
    const dayToK = (v) => Math.round(((v * 21.75) / 1000) * 100) / 100;
    m = s.match(/(\d+(?:\.\d+)?)\s*[-~－]\s*(\d+(?:\.\d+)?)\s*元?\s*\/\s*(?:天|日)/);
    if (m) return { min: dayToK(parseFloat(m[1])), max: dayToK(parseFloat(m[2])) };

    m = s.match(/(\d+(?:\.\d+)?)\s*元?\s*\/\s*(?:天|日)/);
    if (m) return { min: dayToK(parseFloat(m[1])), max: dayToK(parseFloat(m[1])) };

    // 30元/时
    m = s.match(/(\d+(?:\.\d+)?)\s*元?\s*\/\s*(?:小时|时|h)/);
    if (m) {
      const k = dayToK(parseFloat(m[1]) * 8);
      return { min: k, max: k };
    }

    // 面议
    return null;
  }

  /** 解析经验要求 → {min, max} 年；解析失败返回 null */
  function parseYears(text) {
    const s = String(text || '');
    if (/经验不限|不限经验|无经验/.test(s)) return { min: 0, max: 99 };
    if (/应届|在校|实习生/.test(s)) return { min: 0, max: 1 };

    let m = s.match(/(\d+)\s*[-~－]\s*(\d+)\s*年/);
    if (m) return { min: parseInt(m[1], 10), max: parseInt(m[2], 10) };

    m = s.match(/(\d+)\s*年以上/);
    if (m) return { min: parseInt(m[1], 10), max: 99 };

    m = s.match(/(\d+)\s*年以内/);
    if (m) return { min: 0, max: parseInt(m[1], 10) };

    return null;
  }

  /** 解析学历要求 → 等级数字；解析失败返回 null */
  function parseEdu(text) {
    const s = String(text || '');
    if (/博士/.test(s)) return 4;
    if (/硕士|研究生/.test(s)) return 3;
    if (/本科/.test(s)) return 2;
    if (/大专|专科/.test(s)) return 1;
    if (/学历不限/.test(s)) return 0;
    return null;
  }

  /** 解析公司规模 → {min, max} 人数；解析失败返回 null */
  function parseCompanyScale(text) {
    const s = String(text || '');

    let m = s.match(/(\d+)\s*[-~－]\s*(\d+)\s*人/);
    if (m) return { min: parseInt(m[1], 10), max: parseInt(m[2], 10) };

    m = s.match(/(\d+)\s*人以上/);
    if (m) return { min: parseInt(m[1], 10), max: Infinity };

    m = s.match(/(\d+)\s*人以下/);
    if (m) return { min: 0, max: parseInt(m[1], 10) };

    m = s.match(/(\d+)\s*人/);
    if (m) return { min: parseInt(m[1], 10), max: parseInt(m[1], 10) };

    return null;
  }

  /** 公司名归一化用的尾部词表（法律后缀 + 常见行业泛词） */
  const COMPANY_TAIL = [
    '股份有限公司',
    '有限责任公司',
    '有限公司',
    '分公司',
    '子公司',
    '集团',
    '控股',
    '公司',
    '科技',
    '信息技术',
    '信息科技',
    '网络科技',
    '网络',
    '软件'
  ];

  /** 公司全称常见的注册地前缀 */
  const CITY_PREFIX = [
    '北京', '上海', '广州', '深圳', '杭州', '成都', '武汉', '南京', '西安', '苏州',
    '天津', '重庆', '长沙', '郑州', '青岛', '厦门', '福州', '合肥', '济南', '大连',
    '宁波', '无锡', '东莞', '佛山', '珠海', '中山', '昆明', '南昌', '贵阳', '太原',
    '石家庄', '哈尔滨', '沈阳', '长春', '兰州', '南宁', '海口', '乌鲁木齐', '呼和浩特'
  ];

  /**
   * 公司名归一化 —— 用于「同一公司只投一次」的判定
   *   "腾讯科技（深圳）有限公司"  → "腾讯"
   *   "北京字节跳动科技有限公司"  → "字节跳动"   （与列表页的「字节跳动」判为同一家）
   *   "北京汽车股份有限公司"      → "北京汽车"   （剩 2 字，不剥前缀，"北京汽车" ≠ "上海汽车"）
   * 处理：去括号备注 → 去标点空白 → 剥注册地前缀 → 循环剥尾部后缀
   */
  function normCompany(name) {
    let s = String(name || '');
    if (!s.trim()) return '';

    // 括号里通常是城市 / 分部 / 曾用名备注
    s = s.replace(/[（(【\[][^）)】\]]*[）)】\]]/g, '');
    // 去空白与各类标点符号
    s = s.replace(/[\s·・.。,，、\-—_/\\|:：;；'"“”‘’!！?？#&+*~]/g, '');
    s = s.toLowerCase();
    if (!s) return '';

    /** 循环剥尾部后缀，直到不再变化 */
    const stripTail = (x) => {
      let prev = '';
      while (prev !== x) {
        prev = x;
        for (const w of COMPANY_TAIL) {
          // 至少留 2 个字的核心，避免把公司名剥空
          if (x.length > w.length + 1 && x.endsWith(w)) {
            x = x.slice(0, -w.length);
            break;
          }
        }
      }
      return x;
    };

    // 先剥后缀（"北京汽车股份有限公司" → "北京汽车"）
    s = stripTail(s);

    // 再剥注册地前缀：只有剩下 4 个字以上才剥
    // 这样 "北京汽车" 不会被削成 "汽车" 而与 "上海汽车" 合并
    for (const city of CITY_PREFIX) {
      if (s.startsWith(city) && s.length - city.length >= 4) {
        s = stripTail(s.slice(city.length));
        break;
      }
    }

    return s;
  }

  /** 解析融资阶段；解析失败返回 null */
  function parseFinance(text) {
    const s = String(text || '');
    if (/不需要融资/.test(s)) return '不需要融资';
    if (/已上市|上市/.test(s)) return '已上市';
    if (/D轮|E轮|F轮|战略投资/.test(s)) return 'D轮及以上';
    if (/C轮/.test(s)) return 'C轮';
    if (/B轮/.test(s)) return 'B轮';
    if (/A轮/.test(s)) return 'A轮';
    if (/天使轮|天使/.test(s)) return '天使轮';
    if (/未融资/.test(s)) return '未融资';
    return null;
  }

  /** 卡片层文字：关键词 / 排除词只看这里。
   *  JD 正文里可能顺带出现「外包」「销售」等词，拿它做排除会整批误杀。 */
  function cardHay(info) {
    return [info.title, info.company, info.area, ...(info.tags || [])]
      .join(' ')
      .toLowerCase();
  }

  /** 岗位全文（含 JD）：用于按手填条件算匹配分，信息越全打分越准。 */
  function haystackOf(info) {
    return [
      cardHay(info),
      info.apiEdu || '',
      info.apiYears || '',
      String(info.jd || '').slice(0, 6000)
    ]
      .join(' ')
      .toLowerCase();
  }

  /* ------------------------------------------------------------------ *
   * 城市匹配：BOSS 卡片上常常只写区名（「西湖区」「滨江区」），
   * 直接拿期望城市做 includes 会把整座城市的岗位全判成「城市不符」。
   * ------------------------------------------------------------------ */

  /** 城市词表：用于判断地点文字里是否明确写了「另一个城市」。
   *  只在硬证据比对时用，不会拿它去模糊推断城市（避免选杭州投到南京）。
   *  1.11.0：简历识别模块已删除，这个常量改放在城市匹配区，不再混在简历代码里。 */
  const CITY_WORDS = [
    '北京', '上海', '广州', '深圳', '杭州', '成都', '武汉', '南京', '苏州', '西安',
    '天津', '重庆', '长沙', '郑州', '合肥', '厦门', '福州', '济南', '青岛', '大连',
    '沈阳', '哈尔滨', '长春', '石家庄', '太原', '南昌', '昆明', '贵阳', '南宁', '海口',
    '兰州', '银川', '西宁', '乌鲁木齐', '呼和浩特', '无锡', '宁波', '东莞', '佛山',
    '珠海', '中山', '常州', '温州', '嘉兴', '绍兴', '泉州', '烟台', '潍坊', '徐州',
    '洛阳', '保定', '唐山', '台州', '金华', '惠州', '江门', '扬州', '盐城', '泰州',
    '威海', '淄博', '临沂', '芜湖', '株洲', '湘潭', '衡阳', '宜昌', '襄阳', '绵阳'
  ];

  /** 城市 → 常见辖区 / 区域名（空格分隔）。用于从区名反查城市。 */
  const CITY_DISTRICTS = {
    北京: '朝阳 海淀 东城 西城 丰台 石景山 通州 昌平 大兴 顺义 房山 门头沟 怀柔 平谷 密云 延庆 亦庄 经济技术开发区',
    上海: '浦东 徐汇 长宁 静安 普陀 虹口 杨浦 黄浦 闵行 宝山 嘉定 松江 青浦 奉贤 金山 崇明 临港 张江',
    广州: '天河 越秀 海珠 荔湾 白云 黄埔 番禺 花都 南沙 增城 从化',
    深圳: '南山 福田 罗湖 宝安 龙岗 龙华 坪山 光明 盐田 大鹏',
    杭州: '西湖 上城 拱墅 滨江 余杭 萧山 富阳 临安 钱塘 临平 桐庐 淳安 建德 下城 江干',
    成都: '武侯 锦江 青羊 金牛 成华 龙泉驿 青白江 新都 温江 双流 郫都 新津 都江堰 彭州 邛崃 崇州 金堂 大邑 蒲江',
    武汉: '武昌 汉口 汉阳 江岸 江汉 硚口 青山 洪山 东西湖 汉南 蔡甸 江夏 黄陂 新洲 光谷',
    南京: '玄武 鼓楼 建邺 白下 秦淮 下关 浦口 栖霞 雨花台 江宁 六合 溧水 高淳',
    苏州: '姑苏 虎丘 吴中 相城 吴江 常熟 张家港 昆山 太仓 园区 工业园',
    西安: '雁塔 碑林 莲湖 新城 未央 灞桥 长安 高陵 鄠邑 临潼 阎良 蓝田 周至 高新 曲江',
    天津: '和平 河东 河西 南开 河北 红桥 东丽 西青 津南 北辰 武清 宝坻 滨海 宁河 静海 蓟州',
    重庆: '渝中 江北 沙坪坝 九龙坡 南岸 北碚 渝北 巴南 大渡口 长寿 江津 合川 永川 南川 綦江 万盛',
    长沙: '芙蓉 天心 岳麓 开福 雨花 望城 长沙县 宁乡 浏阳',
    郑州: '金水 二七 管城 中原 惠济 郑东 高新 经开 航空港 新郑 巩义 荥阳',
    合肥: '蜀山 庐阳 包河 瑶海 政务 高新 经开 新站 滨湖 肥西 肥东 长丰 巢湖',
    厦门: '思明 湖里 集美 海沧 翔安 同安 火炬',
    福州: '鼓楼 台江 仓山 马尾 晋安 长乐 闽侯 福清 连江',
    济南: '历下 市中 槐荫 天桥 历城 长清 章丘 济阳 高新 经开',
    青岛: '市南 市北 李沧 崂山 城阳 黄岛 胶州 平度 莱西 即墨 高新',
    大连: '中山 西岗 沙河口 甘井子 旅顺口 金州 普兰店 瓦房店 庄河 高新',
    沈阳: '和平 沈河 皇姑 铁西 大东 浑南 于洪 苏家屯 沈北 辽中 新民 法库 康平',
    哈尔滨: '道里 南岗 道外 香坊 平房 松北 呼兰 阿城 双城',
    长春: '朝阳 南关 宽城 二道 绿园 净月 高新 经开 汽开 双阳 九台 榆树 农安 德惠',
    石家庄: '长安 桥西 新华 裕华 井陉 正定 栾城 鹿泉 藁城',
    太原: '小店 迎泽 杏花岭 尖草坪 万柏林 晋源 清徐 阳曲 娄烦 古交',
    南昌: '东湖 青云谱 青山湖 新建 红谷滩 经开 高新 南昌县 进贤 安义',
    昆明: '五华 盘龙 官渡 西山 呈贡 晋宁 安宁 富民 宜良 嵩明 石林',
    贵阳: '南明 云岩 花溪 乌当 白云 观山湖 清镇 修文 息烽 开阳',
    南宁: '兴宁 青秀 江南 西乡塘 良庆 邕宁 武鸣 横州 宾阳',
    海口: '秀英 龙华 琼山 美兰 澄迈 文昌 琼海',
    无锡: '崇安 南长 北塘 滨湖 锡山 惠山 新吴 江阴 宜兴',
    宁波: '海曙 江东 江北 鄞州 镇海 北仑 奉化 余姚 慈溪 象山 宁海',
    东莞: '莞城 南城 东城 万江 厚街 虎门 长安 塘厦 常平 松山湖 凤岗 清溪',
    佛山: '禅城 南海 顺德 三水 高明 容桂 大良 北滘',
    珠海: '香洲 斗门 金湾 高新 横琴',
    中山: '石岐 东区 西区 南区 火炬 小榄 古镇 坦洲',
    常州: '天宁 钟楼 新北 武进 金坛 溧阳',
    温州: '鹿城 龙湾 瓯海 洞头 瑞安 乐清 永嘉 苍南 平阳 泰顺 文成',
    嘉兴: '南湖 秀洲 嘉善 海盐 海宁 平湖 桐乡',
    绍兴: '越城 柯桥 上虞 新昌 诸暨 嵊州',
    泉州: '鲤城 丰泽 洛江 泉港 台商 晋江 石狮 南安 惠安 安溪 永春 德化',
    烟台: '芝罘 福山 牟平 莱山 蓬莱 栖霞 海阳 龙口 莱州 招远 莱阳',
    潍坊: '潍城 寒亭 坊子 奎文 滨海 诸城 寿光 安丘 高密 昌邑 青州',
    徐州: '云龙 鼓楼 贾汪 泉山 铜山 丰县 沛县 邳州 新沂',
    洛阳: '老城 西工 瀍河 涧西 吉利 洛龙 偃师 孟津 新安 栾川 嵩县 汝阳 宜阳 洛宁 伊川',
    保定: '竞秀 莲池 满城 清苑 徐水 涿州 定州 高碑店 安新 容城 雄县',
    唐山: '路南 路北 古冶 开平 丰南 丰润 曹妃甸 迁西 玉田 遵化 迁安 滦南 乐亭',
    台州: '椒江 黄岩 路桥 临海 温岭 玉环 天台 仙居 三门',
    金华: '婺城 金东 兰溪 义乌 东阳 永康 浦江 武义 磐安',
    惠州: '惠城 惠阳 博罗 惠东 龙门 大亚湾 仲恺',
    江门: '蓬江 江海 新会 台山 开平 鹤山 恩平',
    扬州: '广陵 邗江 江都 仪征 高邮 宝应',
    盐城: '亭湖 盐都 大丰 东台 响水 滨海 阜宁 射阳 建湖',
    泰州: '海陵 高港 姜堰 靖江 泰兴 兴化',
    威海: '环翠 文登 荣成 乳山 经区 高区',
    淄博: '张店 淄川 博山 周村 临淄 桓台 高青 沂源',
    临沂: '兰山 罗庄 河东 沂南 郯城 沂水 莒南 蒙阴 平邑 费县 临沭',
    芜湖: '镜湖 弋江 鸠江 三山 繁昌 南陵 无为 当涂',
    株洲: '荷塘 芦淞 石峰 天元 渌口 攸县 茶陵 炎陵 醴陵',
    湘潭: '雨湖 岳塘 湘乡 韶山',
    衡阳: '珠晖 雁峰 石鼓 蒸湘 南岳 衡南 衡山 衡东 祁东 耒阳 常宁',
    宜昌: '西陵 伍家岗 点军 猇亭 夷陵 远安 兴山 秭归 长阳 五峰 当阳 枝江',
    襄阳: '襄城 樊城 襄州 枣阳 宜城 南漳 谷城 保康 老河口',
    绵阳: '涪城 游仙 安州 江油 三台 盐亭 梓潼 北川 平武'
  };

  /** BOSS URL 里的城市码（只收常用的；拿不到还有页面文本兜底） */
  const CITY_CODE = {
    '101010100': '北京', '101020100': '上海', '101280100': '广州', '101280600': '深圳',
    '101210100': '杭州', '101270100': '成都', '101200100': '武汉', '101190100': '南京',
    '101190400': '苏州', '101110100': '西安', '101030100': '天津', '101040100': '重庆',
    '101250100': '长沙', '101180100': '郑州', '101220100': '合肥', '101230200': '厦门',
    '101230100': '福州', '101120100': '济南', '101120200': '青岛'
  };

  const normCityWord = (s) => String(s || '').trim().replace(/[市地区]$/, '').toLowerCase();

  /** 区名 → 拥有它的城市列表。「鼓楼」南京 / 福州都有，「高新」几乎每城都有 */
  const DISTRICT_OWNERS = (() => {
    const m = {};
    Object.keys(CITY_DISTRICTS).forEach((city) => {
      CITY_DISTRICTS[city].split(/\s+/).forEach((d) => {
        if (!d) return;
        (m[d] = m[d] || []).push(city);
      });
    });
    return m;
  })();

  /** 当前搜索页所在城市，缓存 8 秒；读不到就返回空串 */
  let pageCityCache = { at: 0, city: '' };
  function pageCity() {
    const now = Date.now();
    if (now - pageCityCache.at < 8000) return pageCityCache.city;
    let city = '';
    try {
      if (typeof location !== 'undefined') {
        const m = (location.search || '').match(/[?&]city=([^&]+)/);
        if (m) city = CITY_CODE[m[1]] || '';
      }
    } catch (e) {}
    if (!city && typeof document !== 'undefined' && document.querySelectorAll) {
      try {
        const els = document.querySelectorAll('[class*="city"], [class*="area-select"]');
        for (const el of els) {
          const t = (el.textContent || '').trim();
          if (!t || t.length > 16) continue;
          const hit = CITY_WORDS.find((c) => t.indexOf(c) >= 0);
          if (hit) { city = hit; break; }
        }
      } catch (e) {}
    }
    pageCityCache = { at: now, city };
    return city;
  }

  /** 地点文字里是否明确指向「另一个城市」。
   *  杭州搜索页也会混进南京 / 上海的岗位，页面城市兜底绝不能盖掉这种硬证据。 */
  function otherCityEvidence(a, w) {
    if (!a) return false;

    // 1) 明确写了别的城市名。「中山区」这类「城市名 + 区」不算城市，不能误杀大连中山区
    for (const c of CITY_WORDS) {
      const cw = normCityWord(c);
      if (!cw || cw === w) continue;
      let from = 0;
      let idx;
      while ((idx = a.indexOf(cw, from)) >= 0) {
        const next = a.charAt(idx + cw.length);
        if (!/[区县镇街道]/.test(next)) return true;
        from = idx + cw.length;
      }
    }

    // 2) 写了别的城市独有的区名
    for (const d of Object.keys(DISTRICT_OWNERS)) {
      const owners = DISTRICT_OWNERS[d];
      if (owners.some((o) => normCityWord(o) === w)) continue; // 期望城市也有这个区
      // 「高新 / 经开」这类到处都有的园区名不算证据；但「鼓楼」虽然南京 / 福州 /
      // 徐州都有，仍然是明确的行政区，不能因为重名就放过南京岗位
      if (owners.length >= 4 && d.length <= 2) continue;
      if (a.indexOf(d.toLowerCase()) >= 0) return true;
    }
    return false;
  }

  /** 地点证据的三种结论：yes 明确在期望城市 / no 明确不在 / unknown 没写或认不出来。
   *  以前只有 yes|no，unknown 被当成 yes 用页面城市兜底，南京岗位就这么混进杭州。 */
  function cityStatus(area, wanted) {
    const a = String(area || '').toLowerCase();
    const w = normCityWord(wanted);
    if (!w) return 'yes';

    if (otherCityEvidence(a, w)) return 'no';
    if (a.indexOf(w) >= 0) return 'yes';

    const key = Object.keys(CITY_DISTRICTS).find(
      (c) => c === wanted || normCityWord(c) === w
    );
    if (key) {
      const ds = CITY_DISTRICTS[key].split(/\s+/);
      if (ds.some((d) => d && a.indexOf(d.toLowerCase()) >= 0)) return 'yes';
    }

    if (!a) return 'unknown';
    // 写了地名（xx区 / xx市 / xx镇）却认不出属于期望城市 → 明确拦，不再靠页面城市兜底
    if (/[区县市镇]/.test(a)) return 'no';
    return 'unknown';
  }

  /** 兼容旧调用：unknown 时按当前搜索页城市兜底。硬筛选一律走 cityVerdict，不用这个。 */
  function cityMatches(area, wanted) {
    const s = cityStatus(area, wanted);
    if (s === 'no') return false;
    if (s === 'yes') return true;
    const pc = pageCity();
    return !!pc && normCityWord(pc) === normCityWord(wanted);
  }

  /** 综合卡片 / 接口 / 详情 / JD 的地点证据，给出城市硬判定 */
  function cityVerdict(info) {
    const cities = splitList(cfg.cities);
    if (!cities.length) return null;
    const evidence = [info.area, info.apiArea, info.detailArea, info.jdArea]
      .filter(Boolean)
      .map((x) => String(x));
    let sawNo = false;
    let sawYes = false;
    let last = '';
    for (const a of evidence) {
      const yes = cities.some((c) => cityStatus(a, c) === 'yes');
      const no = cities.every((c) => cityStatus(a, c) === 'no');
      if (no) { sawNo = true; last = a; }
      else if (yes) sawYes = true;
    }
    if (sawNo) {
      return {
        ok: false, code: 'city',
        why: '地点「' + (safeText(last) || '未知') + '」不在期望城市 ' + cities.join('/')
      };
    }
    if (sawYes) return null;
    // 一个地点都没解析出来：默认不投（用户明确要求别投错城市），可开关放开
    if (cfg.strictCity !== false) {
      return {
        ok: false, code: 'city_unknown',
        why: '地点无法确认在 ' + cities.join('/') + '，按「确认不了就不投」跳过'
      };
    }
    const pc = pageCity();
    if (!pc || !cities.some((c) => normCityWord(pc) === normCityWord(c))) {
      return {
        ok: false, code: 'city',
        why: '地点未知且搜索页城市不是 ' + cities.join('/')
      };
    }
    return null;
  }

  /** 用户显式填过的硬条件：城市 + 薪资上下限。海投模式也必须遵守 */
  function hardLimitVerdict(info) {
    const cv = cityVerdict(info);
    if (cv) return cv;
    const sal = parseSalary(info.salary);
    if (sal) {
      if (cfg.minSalary > 0 && sal.max < cfg.minSalary) {
        return {
          ok: false,
          code: 'salary',
          why: '薪资 ' + safeText(info.salary) + ' 低于 ' + cfg.minSalary + 'K'
        };
      }
      if (cfg.maxSalary > 0 && sal.min > cfg.maxSalary) {
        return {
          ok: false,
          code: 'salary',
          why: '薪资 ' + safeText(info.salary) + ' 高于 ' + cfg.maxSalary + 'K'
        };
      }
    }
    return null;
  }

  /**
   * 手填条件匹配分（0-100）
   * 只对「已配置」的维度计分，最后按已配置维度的总权重归一化。
   * 返回 null 表示没配手填条件、不参与评分。
   */
  function scoreJob(info) {
    if (cfg.sweepMode) return null;                 // 海投模式不打分，绝不因分数拦岗位
    if (!cfg.useResume) return null;

    const skills = splitList(cfg.skills);
    const goalJob = (cfg.goalJob || '').trim();
    if (!skills.length && !goalJob) return null;

    const hay = haystackOf(info);
    const titleLower = (info.title || '').toLowerCase();

    let got = 0;
    let total = 0;
    let titleHit = false;

    // 1) 目标岗位（权重 28）
    if (goalJob) {
      total += 28;
      const g = goalJob.toLowerCase();
      const core = jobCore(goalJob);
      if (titleLower.includes(g)) {
        got += 28;
        titleHit = true;
      } else if (core && titleLower.includes(core)) {
        // 「测试工程师」投「软件测试」也算命中 —— 招聘市场上这是同一类岗
        got += 24;
        titleHit = true;
      } else {
        const parts = g.split(/[\s,，/、]+/).filter((x) => x.length > 1);
        if (parts.some((p) => titleLower.includes(p))) got += 17;
      }
    }

    // 2) 技能命中（权重 32）：命中前 4 个即算满配
    if (skills.length) {
      total += 32;
      const hitCount = skills.filter((s) => hasSkill(hay, s)).length;
      if (hitCount === 0 && titleHit) {
        // 岗位卡片没标技术栈时不能判死，按标题匹配给 30% 保底
        got += 32 * 0.3;
      } else {
        got += Math.min(1, hitCount / Math.min(skills.length, 4)) * 32;
      }
    }

    // 3) 经验年限（权重 15）—— 校招 / 实习不看年限
    const skipYears = cfg.recruitType === 'campus' || cfg.recruitType === 'intern';
    const userYears = parseInt(cfg.years, 10);
    if (!skipYears && !isNaN(userYears) && userYears >= 0) {
      total += 15;
      const req = parseYears(hay);
      if (!req) {
        got += 10;                                  // 岗位没写，给中性分
      } else if (userYears === 0 && req.min <= 2) {
        // 零经验的普通本科生投「1-3 年」的岗位是常态 —— BOSS 上这类岗大量收应届，
        // 按「年限不足」给 2 分等于把最主流的投递机会全砍掉
        got += 11;
      } else if (userYears >= req.min - 1 && userYears <= req.max + 2) {
        got += 15;
      } else if (userYears < req.min) {
        got += 2;
      } else {
        got += 8;                                   // 资历远超要求，略降
      }
    }

    // 4) 学历（权重 5）
    const userEdu = EDU_LEVEL[cfg.edu];
    if (userEdu !== undefined) {
      total += 5;
      const req = parseEdu(hay);
      if (req === null || req === 0 || userEdu >= req) got += 5;
    }

    // 5) 城市（权重 12）
    const cities = splitList(cfg.cities);
    if (cities.length) {
      total += 12;
      if (cities.some((c) => cityMatches(info.area, c))) got += 12;
    }

    // 6) 薪资区间（权重 8）
    if (cfg.minSalary > 0 || cfg.maxSalary > 0) {
      total += 8;
      const sal = parseSalary(info.salary);
      if (sal) {
        const lo = cfg.minSalary > 0 ? cfg.minSalary : 0;
        const hi = cfg.maxSalary > 0 ? cfg.maxSalary : 999;
        if (sal.max >= lo && sal.min <= hi) got += 8;
      } else {
        got += 4;                                  // 面议，中性
      }
    }

    if (!total) return null;
    return Math.round((got / total) * 100);
  }

  /* ------------------------------------------------------------------ *
   * 证书 / 资质要求识别
   * ------------------------------------------------------------------ *
   * 只在「明确要求」时拦截；写了"优先/加分"的放行。
   * 判断以分句为单位：同一个分句里既有证书又有硬性词才算。
   * ------------------------------------------------------------------ */
  const CERT_WORDS = [
    '教师资格证', '教师证', '注册会计师', 'CPA', '法律职业资格', '司法考试', '律师执业证',
    '执业医师', '医师资格', '护士执业证', '执业药师', '药师证', '规培证',
    '一级建造师', '二级建造师', '建造师', '造价工程师', '监理工程师', '注册消防工程师',
    '注册电气工程师', '结构工程师', '注会',
    '电工证', '焊工证', '特种作业操作证', '叉车证', '高处作业证', '安全员证',
    '驾驶证', 'C1驾照', '驾照',
    '证券从业资格', '基金从业资格', '期货从业资格', '保荐代表人',
    '人力资源管理师', '心理咨询师', '会计从业资格', '初级会计', '中级会计',
    '报关员', '报检员', '翻译资格', 'PMP', 'CFA', 'FRM', 'ACCA'
  ];

  /** 面板上可勾选的证书（常用的一部分，识别用的词表是全量的） */
  const CERT_CHOICES = [
    '教师资格证', '注册会计师', '法律职业资格', '执业医师', '执业药师', '护士执业证',
    '一级建造师', '二级建造师', '造价工程师', '注册消防工程师',
    '电工证', '焊工证', '驾驶证', '安全员证',
    '证券从业资格', '基金从业资格', '人力资源管理师', '心理咨询师',
    '初级会计', '中级会计', '报关员', 'PMP', 'CFA'
  ];
  /** 软化词：出现这些说明不是硬性要求 */
  const CERT_SOFT = /优先|加分|更佳|最好|有则|择优|非必须|不作要求|不要求|不限|可选/;
  /** 硬性词 */
  const CERT_HARD = /必须|须持|需持|要求|持有|持证|具备|上岗|资格证|证书|须有|持有有效/;

  /**
   * 检测岗位是否硬性要求某个证书
   * 返回证书名（要跳过）或 null（放行）
   */
  function detectCert(hay) {
    const s = String(hay || '');
    if (!s) return null;

    // 按分句切，避免"必须A证，B证优先"被整体判成软性
    const clauses = s.split(/[，。；、！？\n\r,.;!?|/]+/);
    for (const clause of clauses) {
      if (!clause) continue;
      const hit = CERT_WORDS.find((w) => clause.indexOf(w) >= 0);
      if (!hit) continue;
      if (CERT_SOFT.test(clause)) continue;      // 有"优先"字样 → 放行
      if (CERT_HARD.test(clause)) return hit;    // 明确要求 → 拦截
      // 既没软化词也没硬性词 → 不确定，放行
    }
    return null;
  }

  /* ================================================================== *
   * 手填专业 / 勾选编程语言 → 硬条件（1.11.0 起，取代简历识别）
   * ================================================================== *
   * 简历解析不可靠，专业尤其认不准，导致「仅限计算机专业」这类岗位照样投。
   * 现在改成用户自己写专业、自己勾会哪些语言；规则只做一件事：
   * JD 里明确写了专业 / 语言门槛时，按用户填的硬比对，不猜、不推断。
   * 没填专业 / 没勾语言 = 不按这一项拦，避免又变成「一个都投不了」。
   * ------------------------------------------------------------------ */

  /** 专业大类：用户写「计算机相关」要能覆盖 JD 写的「计算机科学与技术」 */
  const MAJOR_GROUPS = [
    { id: 'cs', keys: ['计算机', '软件', '网络工程', '信息安全', '物联网', '人工智能', '智能科学', '数据科学', '大数据', '数字媒体技术', '信息与计算科学', '区块链', '网络空间安全', '密码学', '计算机应用', '计算科学'] },
    { id: 'ee', keys: ['电子信息', '通信工程', '电子科学', '微电子', '集成电路', '电气', '自动化', '控制工程', '测控', '仪器', '光电'] },
    { id: 'mech', keys: ['机械', '车辆', '机电', '材料成型', '智能制造', '模具', '工业工程'] },
    { id: 'civil', keys: ['土木', '建筑', '工程造价', '工程管理', '城乡规划', '水利', '测绘', '给排水'] },
    { id: 'finance', keys: ['会计', '财务', '金融', '经济', '审计', '税务', '财政', '国际贸易', '保险', '投资'] },
    { id: 'biz', keys: ['工商管理', '市场营销', '管理', '人力资源', '行政管理', '物流管理', '电子商务', '旅游管理', '酒店管理'] },
    { id: 'law', keys: ['法学', '法律', '知识产权', '政治学', '社会学', '公共管理'] },
    { id: 'media', keys: ['汉语言', '中文', '新闻', '传播', '广告学', '编辑出版', '广播电视', '戏剧影视', '动画', '视觉传达', '设计', '美术', '音乐', '数字媒体艺术'] },
    { id: 'lang', keys: ['英语', '日语', '法语', '德语', '西班牙语', '俄语', '翻译', '商务英语', '外语', '小语种'] },
    { id: 'math', keys: ['数学', '统计', '运筹', '精算'] },
    { id: 'chem', keys: ['化学', '化工', '材料', '高分子', '应用化学', '冶金'] },
    { id: 'bio', keys: ['生物', '食品', '药学', '临床', '医学', '护理', '口腔', '中医', '农学', '园艺', '动物医学', '检验'] },
    { id: 'edu', keys: ['教育', '师范', '学前教育', '心理学', '小学教育', '体育'] },
    { id: 'phys', keys: ['物理', '力学', '航空航天', '天文', '地球物理'] },
    { id: 'energy', keys: ['能源', '新能源', '环境工程', '环境科学', '安全工程', '核工程'] }
  ];

  /** 把「计算机相关专业」「软件工程」这类写法归一成可比的核心词 */
  function normMajor(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/[\s,，、;；/()（）]+/g, '')
      .replace(/专业|方向|门类|学科|类|相关|等|及以上|以上|背景|毕业|学历|出身|学位/g, '')
      .trim();
  }

  function majorGroupIds(s) {
    const t = normMajor(s);
    if (!t) return [];
    const out = [];
    for (const g of MAJOR_GROUPS) {
      if (g.keys.some((k) => t.indexOf(normMajor(k)) >= 0)) out.push(g.id);
    }
    return out;
  }

  /** 用户填的专业串 是否覆盖 JD 要求的某个专业短语。纯函数，可单测。 */
  function majorMatch(userText, reqPhrase) {
    const users = splitList(userText).map(normMajor).filter(Boolean);
    if (!users.length) return true;                 // 没填专业 = 不限制
    const req = normMajor(reqPhrase);
    if (!req) return true;                         // 没读出具体专业名 = 不拦
    const ug = majorGroupIds(userText);
    const rg = majorGroupIds(reqPhrase);
    if (rg.length && ug.some((x) => rg.indexOf(x) >= 0)) return true;
    return users.some((u) => req.indexOf(u) >= 0 || u.indexOf(req) >= 0);
  }

  const MAJOR_HARD = /仅限|只招|只接受|限|须|必须|要求|需|对口|专业[:：]/;
  const MAJOR_PREFIX = /^(?:须|需|必须|要求|具备|具有|仅限|限|只招|只接受|为|是|及|和|与|拥有|接受|认可|须为|应为|招聘|面向|毕业|学历|至少|以上|以及|等|的|须是|具有)+/;
  const MAJOR_VAGUE = /不限|对口|相关|各类|相应|对应|其它|其他|同类|相近/;

  /** 从 JD 分句里读出「明确限制的专业」。写「优先 / 专业不限」的一律不算。 */
  function detectMajorNeeds(clauses) {
    const out = [];
    for (const c of clauses) {
      if (!/专业/.test(c)) continue;
      if (JD_SOFT.test(c) || JD_NEGATE.test(c)) continue;   // 优先 / 不限 / 不限制
      if (!MAJOR_HARD.test(c)) continue;                    // 「我们是专业的团队」不算
      let phrase = '';
      const m1 = c.match(/专业(?:要求|背景)?\s*[:：]\s*([^，。；、\s]{2,20})/);
      const m2 = c.match(/(?:仅限|限|只招|只接受|须为|要求|需|必须为)\s*([^，。；、\s]{2,16}?)(?:类|相关)?专业/);
      const m3 = c.match(/([^，。；、\s]{2,16}?)(?:类|相关)?专业(?:毕业|背景|出身|及以上)?/);
      if (m1) phrase = m1[1];
      else if (m2) phrase = m2[1];
      else if (m3) phrase = m3[1];
      phrase = normMajor(String(phrase || '').replace(MAJOR_PREFIX, ''));
      if (phrase.length < 2 || MAJOR_VAGUE.test(phrase)) continue;
      if (out.indexOf(phrase) < 0) out.push(phrase);
    }
    return out;
  }

  /** 面板可勾选的编程语言。id 直接存进 cfg.langOwned */
  const LANG_CHOICES = [
    'Java', 'Python', 'Go', 'JavaScript', 'TypeScript', 'C', 'C++', 'C#',
    'PHP', 'Ruby', 'Rust', 'Swift', 'Kotlin', 'Objective-C', 'Scala',
    'R', 'SQL', 'Shell', 'MATLAB', 'Dart', 'Perl', 'Lua', 'VB.NET', '汇编'
  ];

  /** 别名按「长词优先」排列；命中后把该片段抹掉，避免 Java 命中 JavaScript、C 命中 C++ */
  const LANG_ALIASES = [
    ['Objective-C', /\bobjective-c\b|\bobjc\b/i],
    ['JavaScript', /\bjavascript\b|\bjs\b/i],
    ['TypeScript', /\btypescript\b|\bts\b/i],
    ['C++', /c\+\+|\bcpp\b/i],
    ['C#', /c#|c\s*sharp/i],
    ['VB.NET', /\bvb\.net\b|\bvisual\s*basic\b/i],
    ['MATLAB', /\bmatlab\b/i],
    ['Python', /\bpython\d?\b/i],
    ['Go', /\bgolang\b|\bgo\s*语言\b|\bgo\b/i],
    ['Java', /\bjava\b/i],
    ['Kotlin', /\bkotlin\b/i],
    ['Swift', /\bswift\b/i],
    ['Scala', /\bscala\b/i],
    ['Rust', /\brust\b/i],
    ['Ruby', /\bruby\b/i],
    ['Shell', /\bshell\b|\bbash\b/i],
    ['PHP', /\bphp\b/i],
    ['SQL', /\bsql\b/i],
    ['Dart', /\bdart\b/i],
    ['Perl', /\bperl\b/i],
    ['Lua', /\blua\b/i],
    ['汇编', /汇编/],
    // 中文后面没有 \b，别在这里写尾部 \b，否则「R语言」认不出来
    ['R', /\br\s*语言|\br\s*编程|\br\s*开发/i],
    ['C', /\bc\s*语言\b|(^|[^a-z0-9+#])c(?![a-z0-9+#])/i]
  ];

  function normLang(s) {
    const t = String(s || '').trim();
    const hit = LANG_CHOICES.find((x) => x.toLowerCase() === t.toLowerCase());
    if (hit) return hit;
    for (const [id, re] of LANG_ALIASES) if (re.test(t)) return id;
    return '';
  }

  /** 一个分句里出现了哪些语言（返回规范 id） */
  function langsInClause(clause) {
    let s = ' ' + String(clause || '') + ' ';
    const found = [];
    for (const [id, re] of LANG_ALIASES) {
      const m = s.match(re);
      if (!m) continue;
      if (found.indexOf(id) < 0) found.push(id);
      s = s.slice(0, m.index) + ' '.repeat(m[0].length) + s.slice(m.index + m[0].length);
    }
    return found;
  }

  const LANG_CTX = /必须|要求|需|须|至少|精通|熟练|掌握|具备|熟悉|开发|编程|语言|技术栈|技能|会用|使用|经验/;
  const LANG_ANY = /或|任一|至少|之一|其中|\/|either/i;
  const LANG_ALL = /和|及|并且|同时|、|以及|且/i;

  /** JD 里的语言硬要求 → 若干组，每组「会任意一种」即算满足；不同组都要满足 */
  function detectLangGroups(clauses) {
    const groups = [];
    const seen = {};
    for (const c of clauses) {
      if (JD_SOFT.test(c) || JD_NEGATE.test(c)) continue;   // 优先 / 不限 / 不需要
      if (!LANG_CTX.test(c)) continue;
      const langs = langsInClause(c);
      if (!langs.length) continue;
      const chunks = (!LANG_ANY.test(c) && LANG_ALL.test(c) && langs.length > 1)
        ? langs.map((l) => [l])
        : [langs.slice(0, 4)];
      for (const g of chunks) {
        const key = g.join('|');
        if (seen[key]) continue;
        seen[key] = 1;
        groups.push(g);
      }
    }
    return groups;
  }

  /** 手填专业 / 勾的语言 与 JD 硬要求比对。返回拦截结论或 null（放行）。 */
  function majorLangVerdict(req) {
    if (!req) return null;
    const mine = String(cfg.major || '').trim();
    if (cfg.majorFilter !== false && mine && (req.majors || []).length) {
      const bad = (req.majors || []).find((m) => !majorMatch(mine, m));
      if (bad) {
        return {
          ok: false,
          code: 'jd_major',
          why: 'JD 限「' + bad + '」专业，你填的是「' + mine + '」'
        };
      }
    }
    const owned = splitList(cfg.langOwned).map(normLang).filter(Boolean);
    if (cfg.langFilter !== false && owned.length && (req.langGroups || []).length) {
      const bad = (req.langGroups || []).find(
        (g) => !g.some((l) => owned.indexOf(l) >= 0)
      );
      if (bad) {
        return {
          ok: false,
          code: 'jd_lang',
          why: 'JD 硬性要求「' + bad.join(' / ') + '」，你没勾这些编程语言'
        };
      }
    }
    return null;
  }

  /* ------------------------------------------------------------------ *
   * 评分 / 岗位名匹配用的小工具（原来混在简历模块里，保留）
   * ------------------------------------------------------------------ */

  const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /**
   * 技能词匹配
   * 纯英文/数字词按「字母边界」判断，避免 Go 命中 Google、Java 命中 JavaScript。
   * 中文词直接子串匹配。
   */
  function hasSkill(text, kw) {
    const k = String(kw || '').toLowerCase();
    if (!k) return false;
    const t = String(text || '').toLowerCase();
    if (/^[a-z0-9+#._\- ]+$/.test(k)) {
      return new RegExp('(^|[^a-z])' + escRe(k) + '([^a-z]|$)').test(t);
    }
    return t.indexOf(k) >= 0;
  }

  /**
   * 岗位名核心词 —— 用于放宽匹配
   *   「测试工程师」→ 测试，「Java 开发工程师」→ java，「UI 设计师」→ ui
   * 不这么做的话，目标岗位写「测试工程师」就投不到「软件测试」这种岗位，
   * 而这两个在招聘市场上是同一类岗。
   */
  function jobCore(title) {
    let s = String(title || '');
    s = s.replace(/[（(][^)）]*[)）]/g, '');
    s = s.replace(/(高级|资深|初级|中级|首席|实习|兼职|全职|急招|诚聘|长期)/g, '');
    s = s.replace(/(工程师|专员|经理|助理|主管|顾问|设计师|分析师|开发|岗位|岗)/g, '');
    s = s.replace(/[\s\-_/、,，]/g, '');
    s = s.toLowerCase();
    // 只剩一两个字时太宽（比如「师」），宁可不用
    return s.length >= 2 ? s : '';
  }

  /* ------------------------------------------------------------------ *
   * 岗位详情 JD → 结构化硬性要求
   * ------------------------------------------------------------------ *
   * 目标不是「看起来智能」，而是把要求真的读出来、显示出来、按你自己的条件比对。
   * 只认明确分句，写「优先 / 加分 / 不需要」的一律不算硬性门槛，避免误杀。
   * ------------------------------------------------------------------ */
  const JD_REJECT_CHOICES = [
    { id: '驻场', re: /驻场|客户现场办公|甲方现场|需在客户现场/ },
    { id: '长期出差', re: /长期出差|频繁出差|经常出差|每月出差|常驻外地/ },
    { id: '倒班夜班', re: /倒班|夜班|轮班|三班倒|值夜班/ },
    { id: '单休', re: /单休|大小周|做六休一|每周六天|单双休/ },
    { id: '需驾照', re: /C1|驾驶证|驾照/ },
    { id: '限专业', re: /仅限[^，。；]{0,12}专业|专业(?:必须|要求|限)|须[^，。；]{0,8}专业(?:毕业|背景)|对口专业/ },
    { id: '限年龄', re: /年龄(?:要求|限制|不超过)|[23]\d周岁以下|[23]\d岁以下/ },
    { id: '限户籍', re: /本地户口|本市户籍|户籍(?:要求|限制)|须[^，。；]{0,4}户口/ },
    { id: '外派', re: /外派|派驻|海外常驻|长期驻外/ },
    { id: '销售性质', re: /销售性质|带销售指标|业绩考核|需完成[^，。；]{0,6}业绩/ }
  ];
  const JD_SOFT = /优先|加分|更佳|最好|有则|择优|非必须|不作要求|不要求|不限|可选|欢迎/;
  const JD_NEGATE = /不(?:需要|用|含|涉及|要求|接受|限|强制)|无需|没有|免于|杜绝|拒绝/;

  /** 解析 JD 全文 → { edu, years, certs, conditions, summary } */
  /** 是否需要对 JD 做结构化分析。
   *  专业 / 编程语言是用户设的硬条件，独立于「岗位要求识别」开关：
   *  只要填了专业或勾了语言，即使把 jdScan 关掉也必须读 JD ——
   *  否则 info.req 为空，jdVerdict 会直接放行，硬条件等于没设（1.11.0 修）。 */
  function needJdAnalysis() {
    if (cfg.jdScan) return true;
    if (cfg.majorFilter !== false && String(cfg.major || '').trim()) return true;
    if (cfg.langFilter !== false && splitList(cfg.langOwned).length) return true;
    return false;
  }

  function analyzeJD(text, info) {
    const s = String(text || '').replace(/\s+/g, ' ');
    const out = {
      edu: null, years: null, certs: [], conditions: [],
      majors: [], langGroups: [], summary: '', chars: s.length
    };
    if (s.length < 8) return out;
    const clauses = s.split(/[，。；、！？\n\r,.;!?|/]+/).filter(Boolean);
    const hardClauses = clauses.filter((c) => !JD_SOFT.test(c) && !JD_NEGATE.test(c));

    const eduText = hardClauses
      .filter((c) => /学历|本科|大专|专科|硕士|博士|研究生/.test(c))
      .join(' ');
    out.edu = eduText ? parseEdu(eduText) : null;

    const yearText = hardClauses.filter((c) => /\d\s*年|经验/.test(c)).join(' ');
    out.years = yearText ? parseYears(yearText) : null;

    // 接口给的学历 / 经验标签最可靠，优先采用
    if (info) {
      const ae = parseEdu(String(info.apiEdu || ''));
      if (ae !== null) out.edu = ae;
      const ay = parseYears(String(info.apiYears || ''));
      if (ay && (out.years === null || ay.min > out.years.min)) out.years = ay;
    }

    for (const c of hardClauses) {
      const hit = CERT_WORDS.find((w) => c.indexOf(w) >= 0);
      if (hit && out.certs.indexOf(hit) < 0) out.certs.push(hit);
    }
    for (const r of JD_REJECT_CHOICES) {
      for (const c of clauses) {
        if (!r.re.test(c) || JD_NEGATE.test(c)) continue;
        out.conditions.push(r.id);
        break;
      }
    }

    // 专业 / 编程语言：只在明确分句里认，写「优先 / 不限」的一律不算门槛。
    // 语言单独按「不切斜杠」的分句读：JD 常写「Java/Python/Go 任一」，
    // 若沿用上面的切分会把斜杠当分隔符，三个语言被拆成三组，
    // 变成「三门都得会」的误杀。保留斜杠才能识别成「任选其一」。
    const langClauses = s.split(/[，。；、！？\n\r,.;!?|]+/).filter(Boolean);
    out.majors = detectMajorNeeds(clauses);
    out.langGroups = detectLangGroups(langClauses);

    const bits = [];
    if (out.edu !== null) bits.push(['不限', '大专', '本科', '硕士', '博士'][out.edu] + '学历');
    if (out.years && out.years.min > 0) bits.push(out.years.min + '年以上经验');
    if (out.certs.length) bits.push('需' + out.certs.slice(0, 3).join('/'));
    if (out.conditions.length) bits.push(out.conditions.slice(0, 4).join('/'));
    if (out.majors.length) bits.push('限' + out.majors.slice(0, 2).join('/') + '专业');
    if (out.langGroups.length) {
      bits.push('需' + out.langGroups.slice(0, 2).map((g) => g.join('/')).join(' + '));
    }
    out.summary = bits.length ? bits.join(' · ') : '未识别到硬性要求';
    return out;
  }

  /** 按「我自己的条件」判断要不要跳过。默认只拦证据明确的项。 */
  function jdVerdict(info) {
    if (!info.req) return null;
    // 专业 / 编程语言是用户明确填过的硬条件，独立于「按硬性要求自动跳过」开关
    const ml = majorLangVerdict(info.req);
    if (ml) return ml;
    if (!cfg.jdScan || !cfg.jdBlock) return null;
    const r = info.req;

    const rejects = splitList(cfg.jdReject);
    const badCond = r.conditions.find((c) => rejects.indexOf(c) >= 0);
    if (badCond) {
      return { ok: false, code: 'jd_reject', why: '岗位要求「' + badCond + '」，你已勾选不接受' };
    }

    const userEdu = EDU_LEVEL[cfg.edu];
    if (cfg.edu !== '不限' && userEdu !== undefined && r.edu !== null && r.edu > userEdu) {
      return {
        ok: false,
        code: 'jd_edu',
        why: 'JD 要求 ' + ['不限', '大专', '本科', '硕士', '博士'][r.edu] + '学历，高于你填的 ' + cfg.edu
      };
    }

    const myYears = parseFloat(cfg.years);
    if (isFinite(myYears) && r.years && r.years.min > myYears + 0.5) {
      return {
        ok: false,
        code: 'jd_years',
        why: 'JD 要求 ' + r.years.min + ' 年以上经验，你填的是 ' + myYears + ' 年'
      };
    }

    if (cfg.certFilter && r.certs.length) {
      const owned = splitList(cfg.certOwned);
      const bad = r.certs.find(
        (c) => !owned.some((o) => c.indexOf(o) >= 0 || o.indexOf(c) >= 0)
      );
      if (bad) {
        return { ok: false, code: 'jd_cert', why: 'JD 硬性要求「' + bad + '」，你未勾选持有' };
      }
    }
    return null;
  }

  /** 硬筛选 + 评分 → { ok, why, code, score } */
  function judge(info) {
    if (!info.title) return { ok: false, code: 'no_title', why: '未解析到职位名' };

    /* 海投模式：真正的一次性全放行。
     * 之前 sweepMode 只写在配置里，judge 根本不读它 —— 于是点了「海投模式」/「一键放宽」
     * 之后，招聘类型、发布时间、公司白名单、排除词这些没被清掉的筛选依然在拦，
     * 表现就是「跑半天一个都投不了」。这里改成一条短路，只保留两条底线：
     *   1) 找得到沟通按钮  2) 只投未沟通（这个开关开着时）
     * 岗位去重 / 公司去重由主循环在 judge 之前处理，不受影响。 */
    if (cfg.sweepMode) {
      if (cfg.onlyNew && /继续沟通/.test(info.btnText || '')) {
        return { ok: false, code: 'chatted', why: '已沟通过' };
      }
      // detailMode：卡片本身没按钮，按钮在右侧详情面板里，要等点开卡片后才有
      if (!info.btn && !info.detailMode) {
        return { ok: false, code: 'no_btn', why: '找不到「立即沟通」按钮' };
      }
      // 海投只跳过「没填的条件」。用户自己填了杭州 / 薪资上下限，就是硬性要求，
      // 不能因为点了「一键海投」就被无视，否则南京岗位也会混进来。
      const hard = hardLimitVerdict(info);
      if (hard) return hard;
      // 海投也不越过用户明确勾选的「不接受条件」
      const jd = jdVerdict(info);
      if (jd) return jd;
      return { ok: true, score: -1, vague: true, sweep: true };
    }

    // 卡片层做关键词 / 证书 / 学历 / 年限判定；JD 层交给 jdVerdict（带软化词过滤），
    // 避免 JD 里顺带出现「外包」「销售」就把整批岗位误杀。
    const hay = cardHay(info);

    // 必含关键词（可关闭：开关关掉时即使填了词也不生效）
    const inc = splitList(cfg.include);
    if (cfg.useInclude && inc.length && !inc.some((k) => hay.includes(k.toLowerCase()))) {
      return { ok: false, code: 'no_include', why: '未命中关键词' };
    }

    // 排除关键词（可关闭）
    if (cfg.useExclude !== false) {
      const exc = splitList(cfg.exclude);
      const hitExc = exc.find((k) => hay.includes(k.toLowerCase()));
      if (hitExc) return { ok: false, code: 'exclude', why: '命中排除词「' + hitExc + '」' };
    }

    // 证书：硬性要求你没勾选的证书 → 跳过
    if (cfg.certFilter) {
      const cert = detectCert(hay);
      if (cert) {
        const owned = splitList(cfg.certOwned);
        const has = owned.some((o) => cert.indexOf(o) >= 0 || o.indexOf(cert) >= 0);
        if (!has) {
          return {
            ok: false,
            code: 'cert',
            why: '要求「' + cert + '」' + (owned.length ? '，不在你有证书列表' : '，你未勾选任何证书')
          };
        }
      }
    }

    // 公司名白名单（限投目标公司）
    const compInc = splitList(cfg.companyInclude);
    if (compInc.length) {
      const companyLower = (info.company || '').toLowerCase();
      if (!compInc.some((k) => companyLower.includes(k.toLowerCase()))) {
        return {
          ok: false,
          code: 'company_not_in',
          why: '公司「' + (info.company || '未知') + '」不在目标名单'
        };
      }
    }

    // 公司名黑名单
    const compExc = splitList(cfg.companyExclude);
    const hitComp = compExc.find((k) =>
      (info.company || '').toLowerCase().includes(k.toLowerCase())
    );
    if (hitComp) {
      return { ok: false, code: 'company_black', why: '公司名含「' + hitComp + '」' };
    }

    // 公司规模（解析不到 → 放行）
    const scaleIds = splitList(cfg.scaleList);
    if (scaleIds.length && info.scale) {
      const fmt = (s) => (s.max === Infinity ? s.min + '人以上' : s.min + '-' + s.max + '人');
      const hitScale = scaleIds.some((id) => {
        const r = SCALE_RANGES.find((x) => x.id === id);
        if (!r) return false;
        return info.scale.max >= r.min && info.scale.min <= r.max;
      });
      if (!hitScale) {
        return {
          ok: false,
          code: 'scale',
          why: '公司规模 ' + fmt(info.scale) + ' 不在所选范围'
        };
      }
    }

    // 融资阶段（解析不到 → 放行）
    const finList = splitList(cfg.financeList);
    if (finList.length && info.finance && !finList.includes(info.finance)) {
      return { ok: false, code: 'finance', why: '融资阶段「' + info.finance + '」不在所选范围' };
    }

    // 城市 + 薪资：用户显式填过的硬条件
    const hard = hardLimitVerdict(info);
    if (hard) return hard;

    // JD 正文里的硬性要求（接口数据可用时，卡片阶段就能拦；否则等点开详情后复判）
    const jd = jdVerdict(info);
    if (jd) return jd;

    // 学历（岗位没写学历要求 → 放行）
    const userEdu = EDU_LEVEL[cfg.edu];
    const reqEdu = parseEdu(hay);
    if (userEdu !== undefined && reqEdu !== null && reqEdu > userEdu) {
      return { ok: false, code: 'edu', why: '学历要求高于' + cfg.edu };
    }

    // 校招 / 实习：跳过要求过多经验的全职岗
    if (cfg.recruitType === 'campus' || cfg.recruitType === 'intern') {
      const req = parseYears(hay);
      const isIntern = cfg.recruitType === 'intern';
      const limit = isIntern ? 1 : 2;
      if (req && req.min >= limit) {
        return {
          ok: false,
          code: 'years',
          why: '要求 ' + req.min + ' 年以上经验，非' + (isIntern ? '实习' : '校招') + '岗'
        };
      }
    }

    // 发布时间 / 新鲜度（解析不到 → 放行）
    if (cfg.freshMax > 0 && info.fresh) {
      if (info.fresh.h > cfg.freshMax) {
        return {
          ok: false,
          code: 'fresh',
          why:
            (info.fresh.kind === 'publish' ? '发布于 ' : 'HR ') +
            info.fresh.raw +
            '，超出 ' +
            freshLabel(cfg.freshMax)
        };
      }
    }

    // 沟通状态
    if (cfg.onlyNew && /继续沟通/.test(info.btnText)) {
      return { ok: false, code: 'chatted', why: '已沟通过' };
    }
    // detailMode 时按钮由 applyTo 在「点开卡片 → 等详情加载」之后再找，这里不能提前判死
    if (!info.btn && !info.detailMode) {
      return { ok: false, code: 'no_btn', why: '找不到「立即沟通」按钮' };
    }

    // 按手填条件算匹配分
    const score = scoreJob(info);
    if (score !== null && score < cfg.minScore) {
      // 信息极少的岗位（没有标签、正文很短）不按分数拦截 ——
      // 这类"模糊岗位"往往只是没写技术栈，按分数筛会误杀
      const thin = (info.tags || []).length === 0 && hay.length < 60;
      if (thin && cfg.passVague !== false) {
        return { ok: true, score, vague: true };
      }
      return { ok: false, code: 'score', why: '匹配分 ' + score + ' < 阈值 ' + cfg.minScore };
    }

    return { ok: true, score: score === null ? -1 : score };
  }

  /* ------------------------------------------------------------------ *
   * 大模型语义判断：把 JD 全文交给模型读
   * ------------------------------------------------------------------ *
   * 只在「详情已点开、JD 全文已拿到、规则和结构化 JD 识别都放行」之后调用，
   * 不给明显不该投的岗位白花钱。任何失败都默认放行，绝不会让海投卡死。
   * ------------------------------------------------------------------ */
  function aiPayloadOf(info) {
    return {
      cfg: {
        aiEnabled: cfg.aiEnabled,
        aiProvider: cfg.aiProvider,
        aiBaseUrl: cfg.aiBaseUrl,
        aiModel: cfg.aiModel,
        aiApiKey: cfg.aiApiKey,
        aiMode: cfg.aiMode,
        aiMinScore: cfg.aiMinScore,
        aiTimeout: cfg.aiTimeout,
        aiMaxChars: cfg.aiMaxChars,
        aiExtra: cfg.aiExtra,
        aiSendProfile: cfg.aiSendProfile,
        goalJob: cfg.goalJob,
        skills: cfg.skills,
        years: cfg.years,
        edu: cfg.edu,
        cities: cfg.cities,
        minSalary: cfg.minSalary,
        maxSalary: cfg.maxSalary,
        certOwned: cfg.certOwned,
        jdReject: cfg.jdReject,
        recruitType: cfg.recruitType,
        major: cfg.major,
        majorFilter: cfg.majorFilter,
        langOwned: cfg.langOwned,
        langFilter: cfg.langFilter
      },
      info: {
        title: safeText(info.title),
        company: safeText(info.company),
        salary: safeText(info.salary),
        area: safeText(info.area || info.apiArea || ''),
        tags: (info.tags || []).map((x) => safeText(x)),
        jd: safeText(info.jd || ''),
        reqSummary: info.req ? safeText(info.req.summary) : ''
      }
    };
  }

  function aiSend(type, data) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(Object.assign({ type }, data), (res) => {
          if (chrome.runtime.lastError) return resolve(null);
          resolve(res || null);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  /** 返回 null = 放行；返回 {block:true,...} = 拦下这个岗位 */
  async function aiReview(info) {
    if (!cfg.aiEnabled || cfg.aiProvider === 'off') return null;
    const res = await aiSend('baa_ai_judge', { payload: aiPayloadOf(info) });
    const failOpen = cfg.aiFailOpen !== false;

    if (!res || !res.ok) {
      const reason = res
        ? (res.error || res.code || '未知错误')
        : '扩展后台没响应（刷新 BOSS 页面，或重新加载扩展）';
      st.aiFail = (st.aiFail || 0) + 1;
      if (res && res.code === 'no_jd') {
        if (st.aiFail <= 3) log('AI 跳过：这个岗位没读到 JD 全文，按原规则判断。', 'dim');
      } else if (st.aiFail <= 3) {
        log(
          'AI 判断失败：' + reason +
            (failOpen ? '，已按原规则放行。' : '，按你的设置跳过该岗位。'),
          failOpen ? 'dim' : 'err'
        );
      }
      if (failOpen) return null;
      return { block: true, code: 'ai_error', why: 'AI 调用失败：' + reason };
    }

    const v = res.verdict || {};
    info.ai = {
      score: v.score,
      fit: v.fit,
      hard: v.hardBlock,
      summary: v.summary,
      reasons: (v.hardReasons || []).concat(v.reasons || []).slice(0, 4),
      cached: !!res.cached,
      ms: res.elapsed || 0
    };
    st.aiCalls = (st.aiCalls || 0) + 1;
    st.lastAi = info.ai;
    st.aiChars = res.jdChars || 0;

    const tag = res.cached ? '缓存' : (res.elapsed || 0) + 'ms';
    if (st.aiCalls <= 5 || info.ai.hard) {
      log(
        'AI 语义判断 · ' + v.score + '分 · ' +
          (v.hardBlock ? '硬性不符' : v.fit ? '建议投' : '不太匹配') +
          ' · ' + safeText(v.summary) + ' [' + tag + ']',
        v.hardBlock ? 'err' : 'dim'
      );
    }
    if (typeof render === 'function') render();

    if (res.decision && res.decision.block) {
      return { block: true, code: res.decision.code, why: res.decision.why };
    }
    return null;
  }

  /* ------------------------------------------------------------------ *
   * 投递后的确认弹窗
   * ------------------------------------------------------------------ *
   * 点「立即沟通」后 BOSS 会弹「已向 BOSS 发送消息」，给「留在此页 / 去沟通」
   * 两个选项。旧版不点它，遮罩一直挂着，后面的卡片就再也找不到（或点不动）
   * 沟通按钮 —— 表现就是「投了一个之后再也投不了」。
   * ------------------------------------------------------------------ */
  const DIALOG_SEL = [
    '[role="dialog"]',
    '[class*="dialog"]',
    '[class*="modal"]',
    '[class*="popup"]',
    '[class*="mask"]'
  ].join(',');

  /** 想留在列表页的按钮文案；命中这类就点它，绝不能点「去沟通」跳走 */
  const STAY_BTN_RE = /留在(?:此|本|当前)页|继续留|暂不|稍后再说|稍后|取消|关闭|知道了|我知道了/;
  /** 弹窗专属文案：全页出现这些词就一定是投递确认框，可以直接点 */
  const STAY_STRONG_RE = /留在(?:此|本|当前)页|继续留|稍后再说/;
  const LEAVE_BTN_RE = /去沟通|去聊天|前往|立即沟通|查看|打开|进入|继续沟通/;

  /** 纯函数：从一组按钮文案里挑出该点的那个，返回下标或 -1 */
  function pickDialogStay(labels) {
    const arr = Array.from(labels || []).map((t) => String(t || '').trim());
    let i = arr.findIndex((t) => STAY_BTN_RE.test(t) && !LEAVE_BTN_RE.test(t));
    if (i >= 0) return i;
    i = arr.findIndex((t) => /^[×✕xX╳]$/.test(t) || /^关闭$/.test(t));
    return i;
  }

  /** 页面上所有可见的短文案可点元素 */
  function shortClickables() {
    try {
      return Array.from(document.querySelectorAll('button, a, span, div, [role="button"]'))
        .filter(isVisible)
        .map((el) => ({ el: el, t: (el.textContent || '').trim(), d: nodeDepth(el) }))
        .filter((x) => x.t && x.t.length <= 12);
    } catch (e) {
      return [];
    }
  }

  /** 关掉投递确认弹窗。返回 true 表示这次真的点了「留在此页」类按钮 */
  function dismissChatDialog() {
    if (typeof document === 'undefined' || !document.querySelectorAll) return false;
    let clicked = false;
    let roots = [];

    // 1) 强特征文案：「留在此页」这类词只可能出现在投递确认框里。
    //    弹窗可能挂在普通 div / portal 上，class 里根本没有 dialog，按容器找会漏。
    const strong = shortClickables().filter(
      (x) => STAY_STRONG_RE.test(x.t) && !LEAVE_BTN_RE.test(x.t)
    );
    if (strong.length) {
      strong.sort((a, b) => b.d - a.d);   // 点最深的那个，避免点到外层包裹
      fireClick(strong[0].el);
      clicked = true;
    }

    // 2) 容器兜底：按钮只写「取消 / 知道了 / ×」这类弱特征时，
    //    限定在可见弹窗容器内找，避免误点页面上其它按钮
    if (!clicked) {
      try {
        roots = Array.from(document.querySelectorAll(DIALOG_SEL)).filter(isVisible);
      } catch (e) {}
      for (const root of roots) {
        if (clicked) break;
        // 遮罩层里常常没有按钮，按钮在它的父容器或相邻层 —— 往上扩一层找
        const scope =
          root.parentElement && root.parentElement !== document.body
            ? root.parentElement
            : root;
        let items = [];
        try {
          items = Array.from(scope.querySelectorAll('button, a, span, div, [role="button"]'))
            .filter(isVisible)
            .map((el) => ({ el: el, t: (el.textContent || '').trim(), d: nodeDepth(el) }))
            .filter((x) => x.t && x.t.length <= 12);
        } catch (e) {
          continue;
        }
        const idx = pickDialogStay(items.map((x) => x.t));
        if (idx < 0) continue;
        const label = items[idx].t;
        const same = items.filter((x) => x.t === label).sort((a, b) => b.d - a.d);
        fireClick(same[0].el);
        clicked = true;
      }
    }

    // 页面上压根没有弹窗时什么都别做，别平白无故发 ESC
    if (!clicked && (strong.length || roots.length)) {
      // 有弹窗但找不到可点按钮时，用 ESC 兜底（BOSS 多数弹窗支持 ESC 关闭）
      try {
        document.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Escape', code: 'Escape', bubbles: true, cancelable: true
          })
        );
      } catch (e) {}
    }

    if (clicked) {
      st.dialogLogged = (st.dialogLogged || 0) + 1;
      if (st.dialogLogged <= 3) {
        log('已自动点「留在此页」关闭投递确认弹窗，继续投递。', 'dim');
      }
    }
    return clicked;
  }

  /* ------------------------------------------------------------------ *
   * 点击动作
   * ------------------------------------------------------------------ */
  /** 元素自己或祖先上是否挂着 href="javascript:..." 的链接。
   *  BOSS 部分卡片 / 按钮是 <a href="javascript:void(0)">，合成 click 会让浏览器
   *  去执行这个 URL，被页面 CSP 拦下并报
   *  "Running the JavaScript URL violates ... The action has been blocked"。 */
  function jsUrlAncestor(el) {
    let n = el;
    for (let i = 0; i < 8 && n; i++, n = n.parentElement) {
      const href = n.getAttribute && n.getAttribute('href');
      if (href && /^\s*javascript\s*:/i.test(href)) return n;
    }
    return null;
  }

  function fireClick(el) {
    const opts = { bubbles: true, cancelable: true, view: window };
    const jsNode = jsUrlAncestor(el);

    // 只在插件主动触发的这一次点击里挡掉 javascript: URL 的默认行为。
    // preventDefault 不会挡住 BOSS 自己的 onclick / React 事件，详情照常切换。
    const block = (e) => {
      if (!jsNode) return;
      let n = e.target;
      for (let i = 0; i < 8 && n; i++, n = n.parentElement) {
        if (n === jsNode) {
          try { e.preventDefault(); } catch (err) {}
          return;
        }
      }
    };
    try {
      if (jsNode && typeof document !== 'undefined' && document.addEventListener) {
        document.addEventListener('click', block, true);
      }
      try {
        el.dispatchEvent(new MouseEvent('mousedown', opts));
        el.dispatchEvent(new MouseEvent('mouseup', opts));
        el.dispatchEvent(new MouseEvent('click', opts));
      } catch (e) {
        if (typeof el.click === 'function') el.click();
      }
    } finally {
      if (jsNode && typeof document !== 'undefined' && document.removeEventListener) {
        try { document.removeEventListener('click', block, true); } catch (e) {}
      }
    }
  }

  /* ------------------------------------------------------------------ *
   * 「左侧列表 + 右侧详情」布局：逐条点开卡片再投
   * ------------------------------------------------------------------ *
   * BOSS 搜索页的「立即沟通」在右侧详情面板，不在列表卡片里。旧版只在卡片内找按钮，
   * 第一张卡片靠位置兜底碰巧命中详情按钮 → 投成功；第二张开始垂直位置对不上 →
   * 全部报「找不到沟通按钮」。这里改成：点卡片 → 等详情切换 → 点详情里的按钮。
   * ------------------------------------------------------------------ */

  /** 元素是否在某张岗位卡片内（详情面板是列表的兄弟节点，不在卡片内） */
  function insideAnyCard(el) {
    const RE = /job-card-(?:wrapper|box|body|left)|job-list-box|job-list-item/i;
    let n = el;
    for (let i = 0; i < 10 && n; i++, n = n.parentElement) {
      const cls = (n.getAttribute && n.getAttribute('class')) || '';
      if (RE.test(cls)) return true;
      if (typeof document !== 'undefined' && n === document.body) break;
    }
    return false;
  }

  /** 右侧详情面板里可见的沟通按钮；排除卡片内按钮和弹窗里的「去沟通」诱饵 */
  function detailChatBtns(card) {
    const out = [];
    let all = [];
    try {
      all = Array.from(document.querySelectorAll('a, button, span, div, [role="button"]'));
    } catch (e) {
      return out;
    }
    for (const el of all) {
      if (!isVisible(el)) continue;
      if (card && (el === card || (card.contains && card.contains(el)))) continue;
      const t = (el.textContent || '').trim();
      if (!t || t.length > 12) continue;
      if (!BTN_STRICT.test(t) && !BTN_LOOSE.some((w) => t.indexOf(w) >= 0)) continue;
      let d = el;
      let inDialog = false;
      for (let i = 0; i < 6 && d; i++, d = d.parentElement) {
        const cls = (d.getAttribute && d.getAttribute('class')) || '';
        const role = (d.getAttribute && d.getAttribute('role')) || '';
        if (/dialog|modal|popup|mask/i.test(cls) || role === 'dialog') {
          inDialog = true;
          break;
        }
      }
      if (inDialog || insideAnyCard(el)) continue;
      out.push(el);
    }
    // 同一文案常被 div/span/button 多层包裹，取最深的那个才是真按钮；右侧优先
    const byText = {};
    out.forEach((el) => {
      const t = (el.textContent || '').trim();
      if (!byText[t] || nodeDepth(el) > nodeDepth(byText[t])) byText[t] = el;
    });
    return Object.keys(byText)
      .map((k) => byText[k])
      .sort((a, b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left);
  }

  /** 详情面板的文本指纹：用来判断「点开卡片后详情到底切换了没有」。
   *  正文可能很长，只取开头 300 字（职位名就在开头），不能因为太长就整块跳过。 */
  function detailSig(btn, card) {
    if (!btn) return '';
    let n = btn;
    for (let i = 0; i < 9 && n; i++, n = n.parentElement) {
      // 走到「列表 + 详情」的共同祖先就停，再往上会拿到整页固定不变的导航文字
      if (card && n !== card && n.contains && n.contains(card)) break;
      const t = String(n.textContent || '').replace(/\s+/g, '');
      if (t.length >= 30) return t.slice(0, 300);
    }
    return '';
  }

  /** 详情面板里的职位名 / 公司名是否与当前卡片一致（防止点到上一份职位的按钮） */
  function detailMatches(btn, card, info) {
    const norm = (s) => String(s || '').replace(/[\s·｜|、,，/（）()]/g, '').toLowerCase();
    const t = norm(info && info.title);
    const c = norm(info && info.company);
    if (!t && !c) return false;
    let n = btn;
    for (let i = 0; i < 8 && n; i++, n = n.parentElement) {
      // 走到共同祖先就停，避免把整个列表里其它卡片的职位名算成命中
      if (card && n !== card && n.contains && n.contains(card)) break;
      const txt = norm(n.textContent || '').slice(0, 1500);
      if (!txt) continue;
      if (t && txt.indexOf(t) >= 0) return true;
      if (c && txt.indexOf(c) >= 0) return true;
    }
    return false;
  }

  /** 详情面板根容器：走到「列表 + 详情」共同祖先就停，别把整页文字算进来 */
  function detailRoot(card, btn) {
    let n = btn;
    let root = null;
    for (let i = 0; i < 9 && n; i++, n = n.parentElement) {
      if (card && n !== card && n.contains && n.contains(card)) break;
      const t = String(n.textContent || '').replace(/\s+/g, '');
      if (t.length >= 20) { root = n; break; }
    }
    return root;
  }

  /* ================================================================== *
   * 1.12.0：JD 以「去APP与BOSS随时沟通」为截止，按 DOM 顺序拼接全文
   * ================================================================== *
   * 旧版两个真 bug：
   *   1) 筛选发生在点开详情之前，用的是接口 JD 摘要 / 第一份岗位的详情，
   *      于是面板显示的「还是之前最初的岗位」；
   *   2) readDetailJD 只取「最长的一块」，而 JD 常被拆成「岗位职责」「任职
   *      要求」「公司介绍」多块 —— 专业、语言、证书硬条件恰恰写在被丢掉的
   *      「任职要求」里。
   * 现在：找到详情底部的 CTA 作为截止，把它上方的所有段落按 DOM 顺序拼接，
   * 再在 JD 卡片的可滚动容器里逐屏滚动，把懒加载的内容补进来。
   * ------------------------------------------------------------------ */

  /** 详情底部 CTA：JD 内容到它为止 */
  const JD_END_RE =
    /(?:去|打开|下载|前往)?\s*app.{0,16}(?:与|和)?\s*boss.{0,10}随时沟通|与\s*boss\s*随时沟通|boss\s*随时沟通|(?:去|打开)\s*app.{0,8}沟通|app\s*内(?:与\s*boss\s*)?沟通/i;
  const JD_UI_NOISE_RE =
    /^(?:立即沟通|继续沟通|开聊|立即开聊|聊一聊|打招呼|投递简历|立即投递|我要沟通|留在此页|去沟通|知道了|取消|关闭|收藏|分享|举报|更多|展开|展开全部|展开全文|查看更多|查看全文|查看全部|收起|公司简介|职位详情)$/;
  const JD_BLOCK_TAG = /^(DIV|P|LI|SECTION|SPAN|H[1-6]|UL|OL|PRE|ARTICLE|DD|DT)$/i;
  const JD_EXPAND_RE = /^(?:展开|展开全部|展开全文|展开更多|查看更多|查看全文|查看全部|更多详情)$/;

  function flatText(v) {
    return String(v || '').replace(/\s+/g, ' ').trim();
  }
  function normTitle(v) {
    return String(v || '').replace(/[\s·｜|、,，/（）()]/g, '').toLowerCase();
  }

  /** 这个元素是不是「去APP与BOSS随时沟通」这类 JD 结束标志 */
  function isJdEndEl(el) {
    if (!el || (el.nodeType && el.nodeType !== 1)) return false;
    const t = flatText(el.textContent || el.innerText || '').replace(/\s+/g, '');
    if (!t || t.length > 46) return false;
    return JD_END_RE.test(t);
  }

  /** 找详情面板里最靠下的截止按钮；卡片内 / 弹窗内的不算 */
  function findJdEnd(root, card) {
    if (!root || !root.querySelectorAll) return null;
    let els = [];
    try { els = Array.from(root.querySelectorAll('a,button,span,div,li,p,[role="button"]')); }
    catch (e) { return null; }
    let best = null;
    let bestTop = -Infinity;
    for (const el of els) {
      if (!isJdEndEl(el)) continue;
      if (!isVisible(el)) continue;
      if (card && (el === card || (card.contains && card.contains(el)))) continue;
      let d = el, inDialog = false;
      for (let i = 0; i < 6 && d; i++, d = d.parentElement) {
        const cls = String((d.getAttribute && d.getAttribute('class')) || '');
        if (/dialog|modal|popup|mask/i.test(cls)) { inDialog = true; break; }
      }
      if (inDialog) continue;
      const r = el.getBoundingClientRect && el.getBoundingClientRect();
      const top = r ? (Number(r.top) || 0) : 0;
      if (top >= bestTop) { bestTop = top; best = el; }
    }
    return best;
  }

  /** 按钮、弹窗、二维码、导航之类不是 JD 正文 */
  function isJdUiNoise(el) {
    const cls = String((el.getAttribute && el.getAttribute('class')) || '');
    if (/(dialog|modal|popup|mask|btn-wrap|button-wrap|qrcode|qr-code|app-download|app-tip|nav-bar|footer|icon)/i.test(cls)) return true;
    const t = flatText(el.textContent || '').replace(/\s+/g, '');
    // 空文本容器通常只是布局壳，里面才是 JD 段落 —— 不能当噪声整块跳过
    if (!t) return false;
    if (t.length < 40 && JD_UI_NOISE_RE.test(t)) return true;
    if (t.length < 32 && /(去APP|随时沟通|立即沟通|继续沟通|下载APP|扫码)/i.test(t)) return true;
    return false;
  }

  /** 按文档顺序收集「截止按钮之前」的 JD 段落。
   *  只收叶子块，避免父节点 textContent 把整块重复算进去。 */
  function collectJDBlocks(root, endEl, card) {
    const out = [];
    const seen = new Set();
    let stopped = false;
    const isEl = (n) => !!n && (!n.nodeType || n.nodeType === 1);
    const kidsOf = (n) => {
      if (n.children && n.children.length) {
        try { return Array.from(n.children); } catch (e) {}
      }
      if (n.__kids && n.__kids.length) return n.__kids.slice();
      return [];
    };

    function visit(n) {
      if (stopped || !isEl(n)) return;
      if ((endEl && n === endEl) || isJdEndEl(n)) { stopped = true; return; }
      if (card && n !== root && (n === card || (card.contains && card.contains(n)))) return;
      if (n !== root && isJdUiNoise(n)) return;

      const kids = kidsOf(n).filter(isEl);
      const blockKids = kids.filter((k) => JD_BLOCK_TAG.test(String(k.tagName || '')));
      if (blockKids.length) {
        for (const k of kids) {
          if (stopped) break;
          visit(k);
        }
        return;
      }
      const t = flatText(n.textContent || n.innerText || '');
      if (t.length >= 8 && !seen.has(t)) { seen.add(t); out.push(t); }
    }
    visit(root);
    return out;
  }

  /** 拼接：去掉被更长片段完整包含的短片段，解密 BOSS 字体私用区字符 */
  function joinJD(parts) {
    const arr = (parts || [])
      .map((x) => decodeBossText(flatText(x)))
      .filter((x) => x && x.length >= 8);
    const kept = arr.filter(
      (t, i) => !arr.some((u, j) => j !== i && u.length > t.length && u.indexOf(t) >= 0)
    );
    const max = Math.round(clampNum(cfg.jdMaxChars, 12000, 1000, 40000));
    return kept.join('\n').slice(0, max);
  }

  /** 详情容器：必须在「列表 + 详情」共同祖先之内，且不能是卡片内按钮 */
  function detailRootStrict(card, btn) {
    if (!btn) return null;
    if (card && (btn === card || (card.contains && card.contains(btn)))) return null;
    let n = btn;
    let root = null;
    for (let i = 0; i < 9 && n; i++, n = n.parentElement) {
      if (card && n !== card && n.contains && n.contains(card)) break;
      if (typeof document !== 'undefined' && n === document.body) break;
      const t = String(n.textContent || '').replace(/\s+/g, '');
      if (t.length >= 20) { root = n; break; }
    }
    if (!root) return null;
    if (card && root.contains && root.contains(card)) return null;
    if (String(root.textContent || '').length > 30000) return null;
    return root;
  }

  /** 详情必须真的属于当前卡片。
   *  旧版 detailMatches 往上一层可能拿到整个列表，任何职位名都「命中」，
   *  于是详情没切换也放行 —— 这就是「一直投最初那个岗位」的根因。 */
  function detailIdentity(root, card, info) {
    if (!root) return { ok: false, why: '没找到详情容器', title: '' };
    if (card && root.contains && root.contains(card)) {
      return { ok: false, why: '详情容器包含整个职位列表', title: '' };
    }
    let cardCount = 0;
    try {
      cardCount = root.querySelectorAll(
        '[class*="job-card-wrapper"], [class*="job-card-box"], li[class*="job-card"]'
      ).length;
    } catch (e) {}
    if (cardCount >= 2) {
      return { ok: false, why: '详情容器里有多张岗位卡片', title: '' };
    }
    const t = normTitle(info && info.title);
    const c = normTitle(info && info.company);
    let head = '';
    try {
      const sels = [
        '[class*="job-name"]', '[class*="job-title"]', '[class*="position-name"]',
        '[class*="position-title"]', 'h1', 'h2', '.name'
      ];
      for (const sel of sels) {
        const el = root.querySelector && root.querySelector(sel);
        if (!el) continue;
        const x = normTitle(el.textContent || '');
        if (x && x.length <= 60) { head = x; break; }
      }
    } catch (e) {}
    const all = normTitle(String(root.innerText || root.textContent || '')).slice(0, 4000);
    const titleOk = !!t && (head.indexOf(t) >= 0 || all.indexOf(t) >= 0);
    const companyOk = !!c && all.indexOf(c) >= 0;
    if (!titleOk && !(companyOk && !t)) {
      return {
        ok: false,
        why: '详情职位名与当前卡片不符（右侧可能还停在上一份岗位）',
        title: head
      };
    }
    // title 只返回「详情里真的读出来的职位名」，不能拿 info.title 兜底：
    // 否则 waitDetailSwitched 的「指纹没变时必须靠职位名节点确认」会被架空。
    return { ok: true, title: head, why: '' };
  }

  /** JD 卡片里可滚动的容器（BOSS 把长 JD 放在独立滚动区，不滚读不全） */
  function findJdScroller(root) {
    let els = [];
    try { els = Array.from(root.querySelectorAll('*')); } catch (e) { els = []; }
    const pool = [root].concat(els);
    let best = null, bestH = 0;
    for (const n of pool) {
      if (!n || !n.getBoundingClientRect) continue;
      let stl = null;
      try { stl = typeof getComputedStyle === 'function' ? getComputedStyle(n) : null; } catch (e) {}
      const oy = String((stl && stl.overflowY) || '');
      const sh = Number(n.scrollHeight) || 0;
      const ch = Number(n.clientHeight) || 0;
      if (sh <= ch + 30) continue;
      if (/(auto|scroll|overlay)/i.test(oy) && sh > bestH) { bestH = sh; best = n; }
    }
    if (best) return best;
    // 有些容器不写 overflow 但确实能滚
    for (const n of pool) {
      const sh = Number(n && n.scrollHeight) || 0;
      const ch = Number(n && n.clientHeight) || 0;
      if (sh > ch + 120 && ch > 100) return n;
    }
    return null;
  }

  /** 先点掉「展开全文 / 查看更多」，否则折叠的 JD 永远读不到 */
  function expandJD(root, endEl, card) {
    let els = [];
    try { els = Array.from(root.querySelectorAll('a,button,span,div')); } catch (e) { return 0; }
    let n = 0;
    for (const el of els) {
      if (n >= 2) break;
      // 「展开全文」有时排在截止按钮之后（DOM 顺序 ≠ 视觉顺序），
      // 遇到截止按钮只跳过它本身，别把后面的展开按钮一起漏掉。
      if (endEl && el === endEl) continue;
      if (!isVisible(el)) continue;
      const t = flatText(el.textContent || '').replace(/\s+/g, '');
      if (!JD_EXPAND_RE.test(t)) continue;
      if (card && (el === card || (card.contains && card.contains(el)))) continue;
      fireClick(el);
      n++;
    }
    return n;
  }

  /** 读完整 JD：展开 → 逐屏滚动 → 每屏把新段落并进来 → 滚回顶部 */
  async function readJobJD(root, btn, card) {
    const empty = { text: '', parts: [], endFound: false, scrolled: 0, expanded: 0 };
    if (!root) return empty;
    let endEl = findJdEnd(root, card);
    let parts = collectJDBlocks(root, endEl, card);
    const seen = new Set(parts);
    let scrolled = 0;
    let expanded = 0;

    if (cfg.jdScroll !== false) {
      expanded = expandJD(root, endEl, card);
      const scroller = findJdScroller(root);
      const steps = Math.round(clampNum(cfg.jdScrollSteps, 12, 0, 40));
      if (scroller && steps > 0) {
        for (let i = 0; i < steps; i++) {
          const before = Number(scroller.scrollTop) || 0;
          const step = Math.max(160, Math.round((Number(scroller.clientHeight) || 400) * 0.7));
          scroller.scrollTop = before + step;
          scrolled++;
          const waitMs = Math.round(clampNum(cfg.jdScrollWait, 160, 0, 1500));
          if (waitMs > 0) await sleep(waitMs);
          const after = Number(scroller.scrollTop) || 0;
          if (!endEl) endEl = findJdEnd(root, card);
          const more = collectJDBlocks(root, endEl, card);
          let added = 0;
          for (const t of more) {
            if (!seen.has(t)) { seen.add(t); parts.push(t); added++; }
          }
          if (after <= before + 2) break;             // 滚到底了
          if (endEl && added === 0 && i >= 1) break;  // 截止按钮出现且没有新内容
        }
        try { scroller.scrollTop = 0; } catch (e) {}
      }
    }
    if (!endEl) endEl = findJdEnd(root, card);
    return {
      text: joinJD(parts),
      parts,
      endFound: !!endEl,
      scrolled,
      expanded
    };
  }

  /** JD 正文（降级路径也用同一套拼接逻辑）：以截止按钮为界，
   *  按 DOM 顺序合并所有段落；找不到截止按钮时退回容器全文。 */
  function readDetailJD(root, card) {
    if (!root) return '';
    const endEl = findJdEnd(root, card || null);
    const parts = collectJDBlocks(root, endEl, card || null);
    const text = joinJD(parts);
    if (text.length >= 40) return text;
    return decodeBossText(
      String(root.innerText || root.textContent || '').replace(/\s+/g, ' ')
    ).slice(0, 8000);
  }

  /** 公司唯一 ID：BOSS 卡片 / 详情里的 data 属性或公司主页链接 */
  function findCompanyId(root, card) {
    const scopes = [card, root].filter(Boolean);
    const attrs = [
      'data-brand-id', 'data-brandid', 'data-company-id',
      'data-encrypt-brand-id', 'data-employer-id', 'brandid', 'companyid'
    ];
    for (const scope of scopes) {
      if (!scope || !scope.querySelectorAll) continue;
      for (const a of attrs) {
        let els = [];
        try { els = Array.from(scope.querySelectorAll('[' + a + ']')); } catch (e) { continue; }
        for (const el of els) {
          const v = (el.getAttribute && el.getAttribute(a)) || '';
          if (v && String(v).length >= 4) return String(v);
        }
      }
      let links = [];
      try { links = Array.from(scope.querySelectorAll('a[href]')); } catch (e) { continue; }
      for (const l of links) {
        const h = String((l.getAttribute && l.getAttribute('href')) || '');
        const m =
          h.match(/(?:gongsi|company|brand)[/_]([A-Za-z0-9_-]{6,})/) ||
          h.match(/[?&](?:brandId|companyId|encryptBrandId)=([A-Za-z0-9_-]{6,})/);
        if (m) return m[1];
      }
    }
    return '';
  }

  /** 点开详情后回填：公司 / 地区 / 薪资 / JD 全文，都会参与点按钮前的最终复判 */
  function enrichFromDetail(card, info, btn) {
    try {
      const root = detailRootStrict(card, btn) || detailRoot(card, btn);
      if (!root) return;
      const text = decodeBossText(
        String(root.innerText || root.textContent || '').replace(/\s+/g, ' ')
      );

      if (!info.companyId) info.companyId = findCompanyId(root, card);
      if (!info.company) {
        info.company =
          pickText(
            root,
            [
              '.company-name', '[class*="company-name"]', '[class*="company-title"]',
              'a[href*="gongsi"]', 'a[href*="company"]', '[class*="company"] h3', 'h3'
            ],
            40
          ) || guessCompanyFromText(text);
      }
      if (!info.area) {
        info.area =
          pickText(
            root,
            [
              '.job-area', '[class*="job-area"]', '[class*="job-location"]',
              '[class*="location"]', '[class*="city"]'
            ],
            24
          ) || guessAreaFromText(text);
      }
      // JD 里常写「工作地点：南京·雨花台区」，卡片上完全没有
      const jm = text.match(
        /(?:工作地点|办公地点|工作地址|办公地址|岗位地点)[:：\s]*([\u4e00-\u9fa5]{2,10}(?:[·\s][\u4e00-\u9fa5]{2,10})?)/
      );
      if (jm && jm[1]) info.jdArea = jm[1];
      if (!info.detailArea && info.jdArea) info.detailArea = info.jdArea;

      if (!info.salary || hasBossCipher(info.salary)) {
        const s = pickText(root, ['.salary', '[class*="salary"]'], 24);
        if (s && !hasBossCipher(s)) info.salary = s;
      }
      if (!info.fresh || !info.fresh.raw) {
        const fm = text.match(
          /刚刚活跃|今日活跃|今天活跃|\d+\s*日内活跃|本周活跃|本月活跃|最新发布|今天发布|昨日发布|昨天发布|\d+\s*天前发布|半年前活跃/
        );
        if (fm) info.fresh = Object.assign({}, info.fresh || {}, { raw: fm[0] });
      }

      // openJobDetail 已经按截止按钮 + 滚动读过完整 JD，别用降级读法覆盖掉
      if (!info.jdComplete) {
        const jd = readDetailJD(root, card);
        if (jd) info.jd = jd;
      }
    } catch (e) {}
  }

  /** 点卡片切详情：从卡片根元素开始，失败时依次换到标题等内层元素，
   *  最后才轮到带 href 的链接（由 fireClickKeepPage 挡住跳转）。 */
  function cardClickTarget(card, attempt) {
    const list = [card];
    const sels = [
      '[class*="job-name"]',
      '[class*="job-title"]',
      '[class*="job-card-body"]',
      '[class*="salary"]'
    ];
    for (const s of sels) {
      try {
        const el = card.querySelector(s);
        if (el && list.indexOf(el) < 0) list.push(el);
      } catch (e) {}
    }
    const risky = list.filter(
      (el) => el.tagName === 'A' && (el.getAttribute('href') || '').trim()
    );
    const safe = list.filter((el) => risky.indexOf(el) < 0);
    const pool = safe.concat(risky);
    return pool[Math.abs(attempt || 0) % (pool.length || 1)];
  }

  /** 点卡片但拦住 <a> 的默认跳转：只让前端的详情切换逻辑生效，不能整页跑掉 */
  function fireClickKeepPage(el) {
    if (!el) return;
    const prevent = (e) => {
      if (e && (e.target === el || (el.contains && el.contains(e.target)))) {
        e.preventDefault();
      }
    };
    try {
      if (document.addEventListener) document.addEventListener('click', prevent, true);
      fireClick(el);
    } finally {
      try {
        if (document.removeEventListener) document.removeEventListener('click', prevent, true);
      } catch (e) {}
    }
  }

  /** 轮询等详情加载出「立即沟通」；网络慢时由 detailWait 控制最长等待 */
  async function waitDetailBtn(card, info, sigBefore, hrefBefore) {
    const maxMs = Math.round(clampNum(cfg.detailWait, 3, 0.5, 30) * 1000);
    const deadline = Date.now() + maxMs;
    let sawBtn = false;
    while (Date.now() < deadline) {
      // 极少数版本点卡片会整页跳到职位详情页，退回列表继续
      if (
        hrefBefore && typeof location !== 'undefined' &&
        location.href !== hrefBefore && /job_detail/.test(location.href)
      ) {
        try { history.back(); } catch (e) {}
        await sleep(400);
      }
      dismissChatDialog();
      const btns = detailChatBtns(card);
      if (btns.length) sawBtn = true;
      for (const b of btns) {
        const sig = detailSig(b, card);
        const switched = !!(sig && sig !== sigBefore);
        const matched = detailMatches(b, card, info);
        // 详情还是上一份职位 → 绝不能点，否则投错岗位
        if (!switched && !matched) continue;
        const t = (b.textContent || '').trim();
        if (/继续沟通/.test(t)) return { btn: null, why: 'chatted' };
        return { btn: b, why: '' };
      }
      await sleep(250);
    }
    return { btn: null, why: sawBtn ? 'stale' : 'timeout' };
  }

  /* ------------------------------------------------------------------ *
   * 1.12.0：逐个点开当前岗位卡片，读完 JD 再判断
   * ------------------------------------------------------------------ *
   * 旧版主循环先 judge() 再 applyTo()，judge 用的是卡片文本 + 接口 JD 摘要，
   * 而完整 JD 只在 applyTo 点开详情之后才拿得到。结果就是「没一个一个点开
   * 卡片，显示的还是最初那个岗位」，专业 / 语言 / AI 全在判旧数据。
   * ------------------------------------------------------------------ */

  /** 严格等详情切到当前岗位：
   *  - 按钮必须真的在右侧详情面板里（卡片内按钮不算）
   *  - 详情容器的职位名必须匹配当前卡片，容器不能是整个列表
   *  - 指纹变化或职位名节点精确命中才算切换完成  */
  async function waitDetailSwitched(card, info, sigBefore, hrefBefore) {
    const maxMs = Math.round(clampNum(cfg.detailWait, 3, 0.5, 30) * 1000);
    const deadline = Date.now() + maxMs;
    let sawBtn = false;
    while (Date.now() < deadline) {
      if (hrefBefore && typeof location !== 'undefined' &&
          location.href !== hrefBefore && /job_detail/.test(location.href)) {
        try { history.back(); } catch (e) {}
        await sleep(400);
      }
      dismissChatDialog();
      const btns = detailChatBtns(card);
      if (btns.length) sawBtn = true;
      for (const b of btns) {
        const root = detailRootStrict(card, b);
        if (!root) continue;
        const id = detailIdentity(root, card, info);
        if (!id.ok) continue;                       // 右侧还停在上一份 → 绝不点
        const sig = detailSig(b, card);
        const switched = !!(sig && sig !== sigBefore);
        if (cfg.strictDetail !== false && !switched && !id.title) continue;
        const t = (b.textContent || '').trim();
        if (/继续沟通/.test(t)) {
          return { btn: null, why: 'chatted', title: id.title, root };
        }
        return { btn: b, why: '', title: id.title, root };
      }
      await sleep(250);
    }
    return { btn: null, why: sawBtn ? 'stale' : 'timeout', title: '', root: null };
  }

  /** 点开当前卡片 → 严格确认详情切换 → 展开/滚动读完 JD → 回填 info。
   *  返回 ok 时 info.btn / info.jd / info.req 全部属于「这一份岗位」。 */
  async function openJobDetail(card, info) {
    if (cfg.detailClick === false) {
      return { ok: false, code: 'detail_off', why: '「逐条点开职位」已关闭，拿不到当前岗位的 JD' };
    }
    const hrefBefore = typeof location !== 'undefined' ? location.href : '';
    const sigBefore = detailSig(detailChatBtns(card)[0], card);
    const tries = Math.round(clampNum(cfg.detailRetry, 3, 1, 5));
    let r = { btn: null, why: '' };

    for (let attempt = 0; attempt < tries && !r.btn; attempt++) {
      const idx = (st.cardClickHint || 0) + attempt;
      const target = cardClickTarget(card, idx);
      try { target.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) {}
      await sleep(200);
      fireClickKeepPage(target);
      r = await waitDetailSwitched(card, info, sigBefore, hrefBefore);
      if (r.btn) st.cardClickHint = idx;
      if (r.why === 'chatted') {
        return { ok: false, code: 'chatted', why: '已是沟通中状态' };
      }
    }

    if (!r.btn) {
      // 降级：卡片里本来就有按钮、页面压根没有右侧详情面板（旧布局）→
      // 不强求点开，用接口 JD 摘要继续，避免整轮「一个都投不了」。
      if (info.btn && !detailChatBtns(card).length) {
        info.btnText = (info.btn.textContent || '').trim();
        return { ok: true, degraded: true, title: info.title, why: '未检测到右侧详情面板，按卡片按钮模式判断' };
      }
      const secs = clampNum(cfg.detailWait, 3, 0.5, 30);
      return {
        ok: false,
        code: 'detail_timeout',
        why: '详情 ' + secs + ' 秒内没切到「' + safeText(info.title || '当前岗位') + '」' +
          (r.why === 'stale' ? '（右侧还停在上一份岗位）' : '（沟通按钮一直没出现）') +
          '，把「详情加载等待」调大再试'
      };
    }

    info.detailBtn = r.btn;
    info.detailRoot = r.root;
    info.btn = r.btn;
    info.btnText = (r.btn.textContent || '').trim();
    info.detailMode = true;
    info.detailTitle = r.title || info.title;

    // 公司 / 地区 / 薪资等仍走原来的详情回填；JD 随后用新读法覆盖成全文
    enrichFromDetail(card, info, r.btn);
    const root = r.root || detailRootStrict(card, r.btn);
    let read = { text: '', endFound: false, scrolled: 0, expanded: 0 };
    try { read = await readJobJD(root, r.btn, card); } catch (e) {}
    if (read.text && read.text.length >= 40) {
      info.jd = read.text;
      info.jdComplete = true;
    }
    info.jdEndFound = read.endFound;
    info.jdScrolled = read.scrolled;
    info.jdChars = String(info.jd || '').length;
    if (needJdAnalysis() && info.jd) info.req = analyzeJD(info.jd, info);

    st.lastReq = info.req ? info.req.summary : '';
    if (st.jdLogged < 5) {
      st.jdLogged++;
      log(
        '↳ ' + safeText(info.detailTitle) + '：JD ' + info.jdChars + ' 字' +
          (read.endFound ? '（读到「去APP与BOSS随时沟通」为止）' : '（按详情全文判断）') +
          (read.scrolled ? ' · JD 卡片滚了 ' + read.scrolled + ' 屏' : '') +
          (read.expanded ? ' · 已展开折叠内容' : ''),
        'dim'
      );
    }
    return {
      ok: true,
      title: info.detailTitle,
      jdChars: info.jdChars,
      endFound: read.endFound,
      scrolled: read.scrolled,
      degraded: false
    };
  }

  async function applyTo(card, info) {
    info = info || extract(card);
    dismissChatDialog();

    let btn = info.detailBtn || info.btn;
    if (info.detailBtn) {
      // 详情按钮可能在等待间隔里被重渲染掉，或者右侧已经切到别的岗位。
      // 任一情况都不能点旧按钮 —— 这正是「投到最初那个岗位」的直接原因。
      const alive = isVisible(btn) &&
        (typeof document.contains !== 'function' || document.contains(btn));
      const root = alive ? detailRootStrict(card, btn) : null;
      if (!root) {
        info.detailBtn = null;
        info.btn = null;
        btn = null;
      } else {
        const id = detailIdentity(root, card, info);
        if (!id.ok) {
          return {
            ok: false,
            code: 'detail_stale',
            why: '右侧详情已不是「' + safeText(info.title) + '」，拒绝点旧按钮（' + id.why + '）'
          };
        }
      }
    }
    if (!btn) {
      if (cfg.detailClick === false) {
        return { ok: false, code: 'no_btn', why: '未找到沟通按钮（逐条点开职位已关闭）' };
      }

      const hrefBefore = typeof location !== 'undefined' ? location.href : '';
      const sigBefore = detailSig(detailChatBtns(card)[0], card);
      const tries = Math.round(clampNum(cfg.detailRetry, 2, 1, 5));
      let r = { btn: null, why: '' };

      for (let attempt = 0; attempt < tries && !r.btn; attempt++) {
        // 记住「上一个岗位用哪种点法成功」，下一张直接从它开始，避免每张都试错 3 次
        const idx = (st.cardClickHint || 0) + attempt;
        const target = cardClickTarget(card, idx);
        try {
          target.scrollIntoView({ block: 'center', behavior: 'smooth' });
        } catch (e) {}
        await sleep(200);
        fireClickKeepPage(target);                  // 点卡片，切换右侧详情
        r = await waitDetailBtn(card, info, sigBefore, hrefBefore);
        if (r.btn) st.cardClickHint = idx;
        if (r.why === 'chatted') return { ok: false, code: 'chatted', why: '已是沟通中状态' };
      }

      if (!r.btn) {
        const secs = clampNum(cfg.detailWait, 3, 0.5, 30);
        return {
          ok: false,
          code: 'detail_timeout',
          why:
            '详情 ' + secs + ' 秒内没加载出沟通按钮（' +
            (r.why === 'stale' ? '详情还停在上一个职位' : '按钮一直没出现') +
            '），把「详情加载等待」调大再试'
        };
      }

      btn = r.btn;
      st.detailLogged = (st.detailLogged || 0) + 1;
      if (st.detailLogged <= 3) {
        log('已点开职位详情，找到「' + (btn.textContent || '').trim() + '」。', 'dim');
      }
    }

    /* 点按钮前的最后一道关。此时详情已加载，才真正拿得到 JD 全文、
     * 公司唯一 ID 和真实工作地点 —— 卡片阶段判不了的东西都在这里补判。 */
    enrichFromDetail(card, info, btn);
    if (cfg.fetchDetail) await fetchJobDetail(info);
    // openJobDetail 已用完整 JD 算过 req；只有降级路径（没点开详情）才在这里补算
    if (!info.jdComplete && needJdAnalysis() && info.jd) info.req = analyzeJD(info.jd, info);

    if (info.req) {
      st.lastReq = info.req.summary;
      if (st.jdLogged < 5) {
        st.jdLogged++;
        log(
          '↳ 岗位要求：' + safeText(info.req.summary) +
            (info.fromApi ? '（接口数据）' : '（详情正文）'),
          'dim'
        );
      }
      if (typeof render === 'function') render();
    }

    // 详情补回公司名 / 公司 ID 后再判一次去重，堵住「同公司不同 HR」
    const lock =
      cfg.companyDedup && typeof companyLocked === 'function' ? companyLocked(info) : null;
    if (lock) {
      return {
        ok: false,
        code: 'dup_company',
        why: '公司「' + (safeText(info.company) || '未知') + '」已投过（详情确认）'
      };
    }

    // 城市 / 薪资：用详情 + 接口 + JD 的全部地点证据重判
    const late = hardLimitVerdict(info);
    if (late) return { ok: false, code: late.code, why: late.why };

    // JD 里的硬性要求（学历 / 经验 / 证书 / 你勾选的不接受条件）
    const lateJd = jdVerdict(info);
    if (lateJd) return { ok: false, code: lateJd.code, why: lateJd.why };

    // 大模型语义判断：此刻 JD 全文才拿得到，正则读不出的「优先 / 必须 / 限专业」
    // 交给模型读。默认关闭；调用失败一律放行，不影响原有投递节奏。
    if (cfg.aiEnabled && cfg.aiProvider !== 'off') {
      const ai = await aiReview(info);
      if (st.stop || !st.running) return { ok: false, code: 'stopped', why: '已停止' };
      if (ai && ai.block) return { ok: false, code: ai.code, why: ai.why };
    }

    const btnText = (btn.textContent || '').trim();
    if (/继续沟通/.test(btnText)) return { ok: false, code: 'chatted', why: '已是沟通中状态' };

    try {
      btn.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } catch (e) {}
    await sleep(400);

    const urlBefore = location.href;
    fireClick(btn);

    // 弹窗常在点击后 0.3–1.5 秒才渲染出来，分几次检查，总时长仍是原来的 1.6 秒
    for (let i = 0; i < 3; i++) {
      await sleep(i === 0 ? 500 : 400);
      dismissChatDialog();
    }
    await sleep(300);
    dismissChatDialog();

    // 有些版本点击后会整页跳到聊天页，这时退回列表
    if (location.href !== urlBefore && /\/chat|conversation/.test(location.href)) {
      log('页面跳转到聊天页，正在返回列表…', 'skip');
      try {
        history.back();
      } catch (e) {}
      await sleep(2200);
      dismissChatDialog();
    }

    return { ok: true };
  }

  /* ------------------------------------------------------------------ *
   * 滚动加载
   * ------------------------------------------------------------------ */
  function findScroller(card) {
    let n = card;
    for (let i = 0; i < 12 && n && n !== document.body; i++) {
      const s = getComputedStyle(n);
      if (/(auto|scroll|overlay)/.test(s.overflowY) && n.scrollHeight > n.clientHeight + 40) {
        return n;
      }
      n = n.parentElement;
    }
    return null;
  }

  async function scrollNext() {
    const cards = getCards();
    if (!cards.length) return false;

    const scroller = findScroller(cards[cards.length - 1]);
    const before = scroller ? scroller.scrollTop : window.scrollY;

    if (scroller) {
      scroller.scrollTop = scroller.scrollTop + Math.round(scroller.clientHeight * 0.75);
    } else {
      window.scrollBy({ top: Math.round(window.innerHeight * 0.75), behavior: 'smooth' });
    }
    // 网慢时列表要更久才吐出新卡片，等待秒数可在面板「滚动加载等待」里调
    await sleep(Math.round(clampNum(cfg.scrollWait, 1.4, 0.2, 20) * 1000));

    const after = scroller ? scroller.scrollTop : window.scrollY;
    if (Math.abs(after - before) < 10) {
      st.stuck++;
    } else {
      st.stuck = 0;
    }
    return st.stuck < 2;
  }

  /* ------------------------------------------------------------------ *
   * 投递记录
   * ------------------------------------------------------------------ */
  function alreadyApplied(key) {
    return !!store.applied[key];
  }

  /** 从历史投递记录回填公司索引（老版本升级上来也能立刻生效） */
  function buildCompanyIndex() {
    if (!store.companies) store.companies = {};
    Object.keys(store.applied).forEach((k) => {
      const v = store.applied[k] || {};
      const n = normCompany(v.c);
      if (!n || store.companies[n]) return;
      store.companies[n] = { c: v.c || '', t: v.t || '', at: Number(v.at) || 0 };
    });
  }

  /** 该公司是否已投过 → 返回记录对象或 null */
  function companyApplied(name) {
    const n = normCompany(name);
    if (!n) return null;
    return store.companies[n] || null;
  }

  /** 公司锁的键：优先 BOSS 公司 ID（同一家公司不同 HR 的 brandId 相同），
   *  没有 ID 才退回归一化公司名。名字写法不同、HR 不同的漏洞就在这里堵住。 */
  function companyKeysOf(info) {
    const out = [];
    if (cfg.companyIdDedup !== false && info.companyId) out.push('id:' + info.companyId);
    const n = normCompany(info.company);
    if (n) out.push('name:' + n);
    return out;
  }

  /** 历史 + 本轮，任一公司键命中就算投过 */
  function companyLocked(info) {
    for (const k of companyKeysOf(info)) {
      if (k.indexOf('id:') === 0) {
        if (st.runCompanyIds.has(k.slice(3))) return { t: '本次已投（同公司其它 HR）' };
        if (store.companies[k]) return store.companies[k];
      } else {
        const n = k.slice(5);
        if (st.runCompanies.has(n)) return { t: '本次已投' };
        if (store.companies[n]) return store.companies[n];
      }
    }
    return null;
  }

  function lockCompany(info) {
    if (cfg.companyIdDedup !== false && info.companyId) {
      st.runCompanyIds.add(String(info.companyId));
      if (!store.companies['id:' + info.companyId]) {
        store.companies['id:' + info.companyId] = {
          c: info.company || '', t: info.title || '', at: Date.now()
        };
      }
    }
    const n = normCompany(info.company);
    if (n) {
      st.runCompanies.add(n);
      if (!store.companies[n]) {
        store.companies[n] = { c: info.company || '', t: info.title || '', at: Date.now() };
      }
    }
  }

  function fmtDay(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const pad = (x) => (x < 10 ? '0' + x : String(x));
    return d.getMonth() + 1 + '月' + d.getDate() + '日';
  }

  async function recordApply(info, score) {
    store.applied[info.key] = {
      t: decodeBossText(info.title),
      c: decodeBossText(info.company),
      s: decodeBossText(info.salary),
      a: decodeBossText(info.area),
      p: decodeBossText(info.fresh ? info.fresh.raw : ''),  // 发布时间 / 活跃度原文
      r: decodeBossText(info.req ? info.req.summary : ''),  // 识别出的岗位硬性要求
      ai: info.ai ? {                            // 大模型读完 JD 全文后的结论
        s: Number(info.ai.score) || 0,
        f: info.ai.fit ? 1 : 0,
        h: info.ai.hard ? 1 : 0,
        m: decodeBossText(info.ai.summary || ''),
        r: (info.ai.reasons || []).map((x) => decodeBossText(x)).join('；')
      } : null,
      cid: info.companyId || '',                  // BOSS 公司 ID，跨 HR 去重用
      api: info.fromApi ? 1 : 0,                  // 是否来自接口明文数据
      m: score,                                   // 手填条件匹配分
      at: Date.now()
    };

    // 公司级索引：公司 ID + 归一化公司名各锁一份，投一次就锁死整个公司
    lockCompany(info);

    const k = todayKey();
    store.daily[k] = (store.daily[k] || 0) + 1;
    st.today = store.daily[k];

    // 控制体积
    const keys = Object.keys(store.applied);
    if (keys.length > 8000) {
      keys.slice(0, 2000).forEach((x) => delete store.applied[x]);
    }
    const cks = Object.keys(store.companies).sort(
      (a, b) => (store.companies[a].at || 0) - (store.companies[b].at || 0)
    );
    if (cks.length > 6000) {
      cks.slice(0, 1500).forEach((x) => delete store.companies[x]);
    }
    const days = Object.keys(store.daily).sort();
    if (days.length > 180) days.slice(0, 60).forEach((x) => delete store.daily[x]);

    await saveStore();
    render();
  }

  /* ------------------------------------------------------------------ *
   * 主循环
   * ------------------------------------------------------------------ */
  async function run() {
    if (st.running) return;

    cfg = Object.assign({}, cfg, readCfgFromUI());

    // 今日计数可能被另一个标签页改过，重新读一次，
    // 否则会出现"明明还有额度，插件却认为已满"
    try {
      const r = await storageGet(STORE_KEY);
      const s = r && r[STORE_KEY];
      if (s && s.daily) st.today = s.daily[todayKey()] || 0;
    } catch (e) {}

    // 今日额度用完：直接问要不要临时提额，别空转一圈只留一句"已停止"
    if (st.today >= cfg.dailyLimit) {
      const want = st.today + 100;
      const go = window.confirm(
        '今天已经投了 ' + st.today + ' 个，达到当前上限 ' + cfg.dailyLimit + '。\n\n' +
          '这就是点了「开始」却什么都不发生的原因。\n\n' +
          '点「确定」把上限临时提到 ' + want + '，现在继续投；\n' +
          '点「取消」则不投。'
      );
      if (!go) return;
      cfg.dailyLimit = want;
      if (ui) ui.dailyLimit.value = want;
      saveCfg();
      log('今日上限已提到 ' + want + '。', 'ok');
    }

    const incOn = !!cfg.useInclude && splitList(cfg.include).length > 0;
    if (!cfg.sweepMode && !incOn && !(cfg.goalJob || '').trim()) {
      const go = window.confirm(
        '「必含关键词」没启用，「目标岗位」也是空的。\n\n' +
          '这样等于对页面上几乎每一个岗位投递，很可能投中一堆完全不相关的职位。\n\n确定继续吗？'
      );
      if (!go) return;
    }

    if (!cfg.ack && !cfg.dryRun) {
      const go = window.confirm(
        '即将开始全自动投递：\n\n' +
          '· 每日上限 ' + cfg.dailyLimit + ' 个\n' +
          '· 间隔 ' + cfg.gapMin + '-' + cfg.gapMax + ' 秒随机\n' +
          '· 匹配分低于 ' + cfg.minScore + ' 的会跳过\n' +
          (cfg.dryRun ? '' : '· 会真实点击「立即沟通」并发出消息\n') +
          '\n运行期间请让本标签页保持在该窗口的当前标签（不要最小化），\n' +
          '否则浏览器会降低计时器频率。\n\nESC 或「停止」可随时中断。开始吗？'
      );
      if (!go) return;
      cfg.ack = true;
      saveCfg();
    }

    // 先识别 BOSS 的加密数字字体，否则写进记录的薪资会变成缺字方框
    await ensureFontDigitMap();

    st.running = true;
    st.stop = false;
    st.scanned = 0;
    st.skipped = 0;
    st.applied = 0;
    st.stuck = 0;
    st.probe = 0;

    log(
      cfg.dryRun
        ? '演练模式：只列出会投的岗位，不实际点击。'
        : '全自动投递启动 · 日上限 ' + cfg.dailyLimit + ' · 间隔 ' + cfg.gapMin + '-' + cfg.gapMax + ' 秒随机',
      'ok'
    );
    if (cfg.sweepMode) {
      log(
        '★ 海投模式生效：关键词、证书、学历、招聘类型、发布时间、公司筛选、匹配分全部跳过；' +
          '你手动填的期望城市和薪资上下限仍然生效。',
        'ok'
      );
    }
    if (cfg.useResume && ((cfg.goalJob || '').trim() || splitList(cfg.skills).length)) {
      log('按手填条件算匹配分，低于 ' + cfg.minScore + ' 分的岗位会被跳过。', 'dim');
    }
    if (String(cfg.major || '').trim() && cfg.majorFilter !== false) {
      log('专业硬条件：「' + cfg.major + '」；JD 明确限专业且不匹配 → 跳过。', 'dim');
    }
    if (splitList(cfg.langOwned).length && cfg.langFilter !== false) {
      log('编程语言硬条件：只勾了 ' + cfg.langOwned + '；JD 硬性要求没勾的语言 → 跳过。', 'dim');
    }
    if (splitList(cfg.cities).length) {
      log(
        '城市硬限定：' + splitList(cfg.cities).join(' / ') +
          '（卡片 / 接口 / 详情 / JD 地点证据综合判定；确认不了' +
          (cfg.strictCity === false ? '按搜索页兜底' : '一律不投') + '）',
        'dim'
      );
    }
    log(
      '岗位数据源：已接入 ' + Object.keys(pageJobs).length + ' 条 BOSS 接口明文岗位' +
        (Object.keys(pageJobs).length
          ? '（薪资 / 公司 / 城市 / 公司 ID 直接读接口，不再靠猜）'
          : '（本次没拦到接口数据，退回详情面板解析）'),
      Object.keys(pageJobs).length ? 'ok' : 'dim'
    );
    log(
      cfg.jdScan
        ? '岗位要求识别已开启：点开详情读 JD 全文，' +
          (cfg.jdBlock ? '按硬性要求自动跳过' : '只记录不拦截') +
          (cfg.jdReject ? '；不接受：' + cfg.jdReject : '') + '。'
        : needJdAnalysis()
          ? '岗位要求识别已关闭，但你设了专业 / 编程语言硬条件：仍会读 JD，只比这两项。'
          : '岗位要求识别已关闭：不读 JD。',
      'dim'
    );
    if (cfg.aiEnabled && cfg.aiProvider !== 'off') {
      const AI_MODE_TXT = {
        veto: '只拦硬性不符',
        score: '按匹配分 ≥ ' + Math.round(clampNum(cfg.aiMinScore, 60, 0, 100)),
        log: '只记录不拦截'
      };
      log(
        'AI 语义判断已开启：' + (cfg.aiModel || '未填模型') + ' 读 JD 全文（最多 ' +
          Math.round(clampNum(cfg.aiMaxChars, 12000, 2000, 40000)) + ' 字）· ' +
          (AI_MODE_TXT[cfg.aiMode] || AI_MODE_TXT.veto) + ' · 超时 ' +
          clampNum(cfg.aiTimeout, 20, 3, 120) + 's · ' +
          (cfg.aiFailOpen === false ? '失败跳过该岗位' : '失败按原规则放行') +
          '。JD 与你的结构化条件会发送给你选的服务商（不再发送简历原文）。',
        'ok'
      );
    }
    if (splitList(cfg.include).length && !cfg.useInclude) {
      log(
        '「必含关键词」里有内容但开关是关的，本次不按它过滤。要用请勾上「启用」。',
        'dim'
      );
    }
    if (cfg.useInclude && splitList(cfg.include).length) {
      log('必含关键词：' + splitList(cfg.include).join(' / '), 'dim');
    }
    if (cfg.recruitType === 'campus') {
      log('校招模式：不按工作年限评分，跳过要求 2 年以上经验的岗位。', 'dim');
    } else if (cfg.recruitType === 'intern') {
      log('实习模式：不按工作年限评分，日薪按 21.75 天/月折算成月薪。', 'dim');
    }
    const scaleIds = splitList(cfg.scaleList);
    const finList = splitList(cfg.financeList);
    if (scaleIds.length || finList.length) {
      const parts = [];
      if (scaleIds.length) parts.push('规模 ' + scaleIds.join('/'));
      if (finList.length) parts.push('融资 ' + finList.join('/'));
      log('公司限定：' + parts.join('，'), 'dim');
    }
    if (cfg.companyDedup) {
      const locked = Object.keys(store.companies || {}).filter((k) => k.indexOf('id:') !== 0).length;
      log(
        '同公司去重已开启：已锁定 ' + locked + ' 家公司，它们旗下所有岗位都会跳过。',
        'dim'
      );
    } else {
      log('同公司去重已关闭：同一公司的多个岗位都会被投。', 'dim');
    }
    if (cfg.freshMax > 0) {
      log('发布时间限定：只看 ' + freshLabel(cfg.freshMax) + '发布 / 活跃的岗位。', 'dim');
    }
    if (cfg.freshFirst) {
      log('已开启「优先投最新的」：候选岗位按新鲜度排序后再投。', 'dim');
    }
    if (cfg.detailClick !== false) {
      log(
        cfg.forceOpenDetail === false
          ? '逐条点开职位再投（旧顺序）：先按卡片筛选，再由 applyTo 点开详情补判。'
          : '逐条点开职位再投：点当前卡片 → 严格确认右侧详情已切到本岗位（最多 ' +
            clampNum(cfg.detailWait, 3, 0.5, 30) + ' 秒）→ ' +
            (cfg.jdScroll === false
              ? '读详情 JD'
              : '在 JD 卡片内展开并滚动（最多 ' +
                Math.round(clampNum(cfg.jdScrollSteps, 12, 0, 40)) + ' 屏）') +
            '，以「去APP与BOSS随时沟通」为截止取全文 → 再判断专业 / 语言 / 硬性要求 / AI → 点「立即沟通」。',
        'dim'
      );
    }
    st.skipReasons = {};
    st.dialogLogged = 0;
    st.detailLogged = 0;
    st.cardClickHint = 0;
    render();

    const handled = new Set();
    st.runCompanies = new Set();                  // 本轮已投公司（名字键）
    st.runCompanyIds = new Set();                 // 本轮已投公司（BOSS 公司 ID 键）
    st.jdLogged = 0;
    st.detailOpened = 0;
    st.lastDetailTitle = '';
    st.lastJdChars = 0;
    st.lastJdEnd = false;
    const hardStop = Date.now() + 4 * 3600 * 1000;

    try {
      while (st.running && !st.stop && Date.now() < hardStop) {
        if (st.today >= cfg.dailyLimit) {
          log('已达今日上限 ' + cfg.dailyLimit + ' 个，自动停止。', 'ok');
          break;
        }

        // 弹窗也可能在 8–15 秒的等待间隔里才出现，每轮开头兜一次
        dismissChatDialog();

        const cards = getCards();
        if (!cards.length) {
          log('当前页没有找到岗位卡片，可能不在列表页或页面结构已变化。', 'err');
          break;
        }

        // 一次性解析本页卡片，便于按新鲜度排序
        const batch = [];
        for (const card of cards) {
          try {
            const info = extract(card);
            if (info.key) batch.push({ card, info });
          } catch (e) {
            /* 单张卡片解析失败不影响其它 */
          }
        }

        // 优先投最新发布 / 活跃的；解析不到时间的排最后
        if (cfg.freshFirst) {
          batch.sort((a, b) => {
            const ha = a.info.fresh ? a.info.fresh.h : Infinity;
            const hb = b.info.fresh ? b.info.fresh.h : Infinity;
            return ha - hb;
          });
        }

        let didSomething = false;

        for (const item of batch) {
          if (st.stop || !st.running) break;
          if (st.today >= cfg.dailyLimit) break;

          const card = item.card;
          const info = item.info;
          if (handled.has(info.key)) continue;
          handled.add(info.key);
          st.scanned++;

          if (alreadyApplied(info.key)) {
            st.skipped++;
            bumpSkip('dup_job');
            log('跳过 ' + info.title + ' · 历史已投过', 'skip');
            render();
            continue;
          }

          // 公司级去重：公司 ID 优先，同公司不同 HR 也判为同一家
          if (cfg.companyDedup) {
            const rec = companyLocked(info);
            if (rec) {
              st.skipped++;
              bumpSkip('dup_company');
              log(
                '跳过 ' + safeText(info.title) + ' · 公司「' + (safeText(info.company) || '未知') + '」已投过' +
                  (rec.at ? '（' + fmtDay(rec.at) + '：' + safeText(rec.t || '其他岗位') + '）' : '（' + (rec.t || '本次已投') + '）') +
                  (info.companyId ? ' [公司ID匹配]' : ''),
                'skip'
              );
              render();
              continue;
            }
          }

          /* 1.12.0：先真正点开「这一张」卡片，严格确认右侧详情已切换，
           * 展开 + 滚动读完 JD（以「去APP与BOSS随时沟通」为截止），再判断。
           * 旧版 judge 在点开之前就跑，用的是接口 JD 摘要 / 第一份岗位的详情，
           * 于是面板一直显示最初那个岗位，专业 / 语言 / AI 全在判错数据。 */
          if (cfg.detailClick !== false && cfg.forceOpenDetail !== false) {
            const opened = await openJobDetail(card, info);
            if (!opened.ok) {
              st.skipped++;
              bumpSkip(opened.code, opened.why);
              log('跳过 ' + safeText(info.title) + ' · ' + opened.why, 'skip');
              // 网慢导致没切开：这份不算处理过，下一轮重新点
              if (opened.code === 'detail_timeout') handled.delete(info.key);
              render();
              continue;
            }
            st.detailOpened = (st.detailOpened || 0) + 1;
            st.lastDetailTitle = opened.title || info.title;
            st.lastJdChars = Number(opened.jdChars) || String(info.jd || '').length;
            st.lastJdEnd = !!opened.endFound;
            if (opened.degraded && st.detailOpened <= 2) log(opened.why, 'dim');
            render();
          } else if (!info.btn && cfg.detailClick !== false) {
            info.detailMode = true;              // 旧路径：交给 applyTo 点开
          }

          const verdict = judge(info);
          if (!verdict.ok) {
            st.skipped++;
            bumpSkip(verdict.code, verdict.why);
            log('跳过 ' + (info.title || '未知职位') + ' · ' + verdict.why, 'skip');
            // 找不到按钮时输出卡片真实文案，最多 3 次 —— 光看「找不到」没法定位
            if (verdict.code === 'no_btn' && st.probe < 3) {
              st.probe++;
              log('  ↳ 卡片上的文字：' + (btnProbe(card) || '（没有可点文字）'), 'dim');
              if (st.probe === 3) {
                log('  ↳ 上面若出现「立即沟通」，说明按钮结构变了，把这段发我就能改选择器。', 'dim');
              }
            }
            render();
            continue;
          }

          if (cfg.dryRun) {
            if (cfg.companyDedup) lockCompany(info);
            log(
              '[演练] 会投 ' + safeText(info.title) + ' @ ' + safeText(info.company) + ' ' + safeText(info.salary) +
                (verdict.score >= 0 ? ' · ' + verdict.score + '分' : ''),
              'hit'
            );
            st.skipped++;
            render();
            continue;
          }

          const res = await applyTo(card, info);
          if (res.ok) {
            await recordApply(info, verdict.score);
            log(
              '✓ 已投递 ' + safeText(info.title) + ' @ ' + safeText(info.company) + ' ' + safeText(info.salary) +
                (verdict.score >= 0 ? ' · ' + verdict.score + '分' : '') +
                ' · 今日 ' + st.today + '/' + cfg.dailyLimit,
              'ok'
            );
            didSomething = true;
            st.applied++;
          } else {
            // 网络慢导致详情没加载出来：这份不算处理过，下一轮重投
            if (res.code === 'detail_timeout') {
              handled.delete(info.key);
            }
            // 详情阶段拦下的（城市 / 公司 / JD 要求）也要进跳过原因统计
            if (res.code) bumpSkip(res.code, res.why);
            log('✗ ' + safeText(info.title) + ' · ' + res.why, 'err');
          }
          render();

          const wait = rand(cfg.gapMin, cfg.gapMax) * 1000;
          log('等待 ' + Math.round(wait / 1000) + ' 秒…', 'dim');

          // 分片等待，方便随时中断
          const end = Date.now() + wait;
          while (Date.now() < end && st.running && !st.stop) {
            await sleep(250);
          }
        }

        if (!st.running || st.stop) break;

        if (cfg.autoScroll) {
          const more = await scrollNext();
          if (!more) {
            log('已经滚到列表底部，没有更多岗位了。', 'dim');
            break;
          }
        } else if (!didSomething) {
          break;
        }
      }
    } catch (e) {
      log('运行出错：' + (e && e.message), 'err');
    } finally {
      st.running = false;
      stop();
      log(
        '已停止。本次扫描 ' + st.scanned + ' 个，跳过 ' + st.skipped + ' 个，实投 ' +
          st.applied + ' 个，今日累计 ' + st.today + '/' + cfg.dailyLimit + ' 个。',
        'ok'
      );
      const top = topSkips(5);
      if (top.length) {
        log(
          '跳过原因：' + top.map((x) => x.label + ' ' + x.n).join('、') +
            (Object.keys(st.skipReasons).length > 5 ? ' 等' : ''),
          top[0].n > st.scanned * 0.6 && top[0].code === 'no_btn' ? 'err' : 'dim'
        );
      }

      // 一个都没投出去 —— 别只报数字，直接说该改哪个开关
      if (!st.applied) {
        if (!st.scanned) {
          log(
            '一个岗位都没扫到：当前页可能不是职位搜索列表页，或页面结构变了。确认在列表页后刷新一次重试。',
            'err'
          );
        } else if (top.length) {
          log('这次一个都没投出去，主因是「' + top[0].label + '」。' + adviceFor(top[0].code), 'err');
        } else {
          log('这次一个都没投出去，也没有跳过记录，可能卡在加载更多。往下滚一下再试。', 'err');
        }
      }

      render();
    }
  }

  function stop() {
    st.running = false;
    st.stop = true;
    render();
  }

  /* ------------------------------------------------------------------ *
   * 日志
   * ------------------------------------------------------------------ */
  function log(text, type) {
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    st.logs.push({ time, text, type: type || 'dim' });
    if (st.logs.length > 300) st.logs.splice(0, st.logs.length - 300);
    renderLog();
  }

  /* ------------------------------------------------------------------ *
   * UI
   * ------------------------------------------------------------------ */
  const PANEL_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    .root {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      font-size: 13px;
      line-height: 1.5;
      color: #1c1f23;
    }
    .fab {
      position: fixed; right: 22px; bottom: 22px;
      width: 54px; height: 54px; border-radius: 50%;
      background: linear-gradient(135deg, #00c6c4 0%, #00969e 100%);
      color: #fff; border: 0; cursor: pointer;
      font-size: 20px; font-weight: 700; letter-spacing: -0.5px;
      display: flex; align-items: center; justify-content: center;
      box-shadow: 0 10px 26px rgba(0, 150, 158, 0.35), 0 2px 6px rgba(0,0,0,.12);
      transition: transform .18s cubic-bezier(.34,1.56,.64,1), box-shadow .18s;
    }
    .fab:hover { transform: translateY(-3px) scale(1.05); box-shadow: 0 14px 32px rgba(0,150,158,.45); }
    .fab:active { transform: scale(.97); }

    .panel {
      position: fixed; right: 22px; bottom: 22px;
      width: 358px; max-height: 88vh;
      background: #fff;
      border-radius: 16px;
      box-shadow: 0 18px 50px rgba(16, 24, 40, 0.18), 0 4px 12px rgba(16,24,40,.08);
      border: 1px solid #eaedf2;
      display: flex; flex-direction: column;
      overflow: hidden;
      animation: slideUp .22s cubic-bezier(.16,1,.3,1);
    }
    @keyframes slideUp { from { opacity: 0; transform: translateY(12px) scale(.98);} to { opacity: 1; transform: none;} }

    .head {
      display: flex; align-items: center; gap: 8px;
      padding: 12px 14px;
      background: linear-gradient(135deg, #00c6c4 0%, #00969e 100%);
      color: #fff;
      flex: 0 0 auto;
    }
    .head h1 { font-size: 13.5px; font-weight: 600; letter-spacing: .2px; flex: 1; }
    .head .badge {
      font-size: 10.5px; font-weight: 600;
      padding: 2px 7px; border-radius: 20px;
      background: rgba(255,255,255,.22);
      letter-spacing: .3px;
    }
    .head .badge.on { background: #ffd84d; color: #6b4a00; }
    .head .badge.dry { background: rgba(255,255,255,.9); color: #0e7490; }
    .x {
      background: transparent; border: 0; color: #fff; cursor: pointer;
      font-size: 18px; line-height: 1; opacity: .8; padding: 2px 4px; border-radius: 6px;
    }
    .x:hover { opacity: 1; background: rgba(255,255,255,.18); }

    .body { overflow-y: auto; padding: 12px 14px 14px; flex: 1 1 auto; }
    .body::-webkit-scrollbar { width: 6px; }
    .body::-webkit-scrollbar-thumb { background: #d7dbe2; border-radius: 3px; }

    .stats { display: flex; gap: 6px; margin-bottom: 12px; }
    .stat {
      flex: 1; text-align: center; padding: 8px 4px;
      background: #f6f8fa; border-radius: 10px; border: 1px solid #eef1f5;
    }
    .stat b { display: block; font-size: 16px; font-weight: 700; color: #0f172a; letter-spacing: -.3px; }
    .stat span { font-size: 10px; color: #7b8494; }

    .skipbox { display: flex; flex-wrap: wrap; gap: 4px; margin: -1px 0 7px; }
    .skipitem {
      font-size: 10px; padding: 2px 6px; border-radius: 5px;
      background: #f4f6f9; color: #6b7684; white-space: nowrap;
    }
    .skipitem b { color: #d64545; font-weight: 700; margin-left: 3px; }
    .skipitem.top { background: #fff0f0; color: #b3352f; }

    .group { border-top: 1px dashed #eef1f5; padding-top: 2px; }
    .group:first-of-type { border-top: 0; }
    .gtitle {
      display: flex; align-items: center; gap: 6px;
      font-size: 10.5px; font-weight: 700; color: #98a1b0;
      letter-spacing: .7px; margin: 9px 0 7px;
    }
    .gtag {
      font-weight: 500; font-size: 9.5px; padding: 1px 5px; border-radius: 4px;
      background: #e8f7f7; color: #00868d; letter-spacing: 0;
    }
    .gtag.warn { background: #fff2e0; color: #b06000; }

    .field { margin-bottom: 9px; }
    .field > label,
    .field > .fl {
      display: flex; align-items: baseline; gap: 5px;
      font-size: 11.5px; font-weight: 600; color: #46505f; margin-bottom: 4px;
    }
    .field > label em,
    .field > .fl em { font-style: normal; font-weight: 400; color: #9aa3b2; font-size: 10px; }

    input[type="text"], input[type="number"], select {
      width: 100%; padding: 7px 9px;
      border: 1px solid #dfe3ea; border-radius: 8px;
      font-size: 12.5px; color: #1c1f23; background: #fff;
      font-family: inherit; outline: none;
      transition: border-color .15s, box-shadow .15s;
    }
    input[type="number"] { -moz-appearance: textfield; }
    input[type="number"]::-webkit-outer-spin-button,
    input[type="number"]::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
    select { cursor: pointer; }
    input:focus, select:focus { border-color: #00b3b0; box-shadow: 0 0 0 3px rgba(0,179,176,.12); }
    input::placeholder { color: #b8bfca; }

    .row2 { display: flex; gap: 8px; }
    .row2 > * { flex: 1; min-width: 0; }
    .row3 { display: flex; gap: 6px; }
    .row3 > * { flex: 1; min-width: 0; }
    .row3 .field > label { font-size: 10.5px; }

    /* 关键词开关：输入框 + 行内勾选 */
    .kwrow { display: flex; gap: 6px; align-items: center; }
    .kwrow > input[type="text"] { flex: 1; min-width: 0; }
    .kwsw {
      margin-left: auto; align-self: center; display: inline-flex; align-items: center; gap: 4px;
      font-size: 10.5px; font-weight: 500; color: #6b7686;
      cursor: pointer; user-select: none; white-space: nowrap;
      letter-spacing: 0;
    }
    .kwsw input {
      width: 13px; height: 13px; margin: 0; padding: 0;
      accent-color: #00b3b0; cursor: pointer; flex: 0 0 auto;
    }
    .kwsw.off { color: #a8b0bd; }
    .kwhint {
      flex: 0 0 auto; font-size: 10px; color: #9aa3b2;
      padding: 0 2px; white-space: nowrap;
    }
    .kwhint.off { color: #c2a06a; }

    .gtitle.clk { cursor: pointer; user-select: none; }
    .gtitle.clk:hover { color: #6b7686; }
    .gtitle .chev {
      margin-left: auto; font-style: normal; font-size: 9px;
      transition: transform .18s; opacity: .65;
    }
    .gtitle.collapsed .chev { transform: rotate(-90deg); }

    .chips { display: flex; flex-wrap: wrap; gap: 5px; }
    .chip {
      padding: 4px 8px; border-radius: 7px; border: 1px solid #e2e6ec;
      background: #fff; color: #55606f; font-size: 10.8px; font-family: inherit;
      cursor: pointer; transition: all .14s; line-height: 1.45;
    }
    .chip:hover { border-color: #b9e5e4; background: #f6fdfd; }
    .chip.on { background: #e6f8f8; border-color: #00b3b0; color: #007a80; font-weight: 600; }

    .toggles { display: flex; flex-direction: column; gap: 7px; margin: 12px 0; }
    .tg { display: flex; align-items: center; gap: 8px; cursor: pointer; user-select: none; }
    .tg input { display: none; }
    .tg .track {
      width: 34px; height: 19px; border-radius: 20px; background: #d8dde5;
      position: relative; flex: 0 0 auto; transition: background .2s;
    }
    .tg .track::after {
      content: ""; position: absolute; top: 2px; left: 2px;
      width: 15px; height: 15px; border-radius: 50%; background: #fff;
      box-shadow: 0 1px 3px rgba(0,0,0,.2);
      transition: transform .2s cubic-bezier(.34,1.56,.64,1);
    }
    .tg input:checked + .track { background: #00b3b0; }
    .tg input:checked + .track::after { transform: translateX(15px); }
    .tg .txt { font-size: 12px; color: #39424f; display: flex; align-items: baseline; gap: 5px; }
    .tg .txt small { color: #9aa3b2; font-size: 10px; }

    .warn {
      background: #fff8e6; border: 1px solid #ffe2a8; color: #8a5b00;
      padding: 6px 9px; border-radius: 8px; font-size: 10.8px; line-height: 1.5;
      margin-bottom: 10px;
    }

    .actions { display: flex; gap: 8px; margin-bottom: 11px; }
    .btn {
      flex: 1; padding: 9px 10px; border-radius: 9px; border: 1px solid transparent;
      font-size: 13px; font-weight: 600; cursor: pointer; font-family: inherit;
      transition: transform .12s, filter .16s, background .16s;
    }
    .btn:active { transform: scale(.98); }
    .btn-primary { background: linear-gradient(135deg, #00c6c4, #00969e); color: #fff; }
    .btn-primary:hover { filter: brightness(1.06); }
    .btn-danger { background: #fee2e2; color: #b91c1c; border-color: #fecaca; }
    .btn-danger:hover { background: #fecaca; }
    .btn-ghost { background: #f2f4f7; color: #46505f; border-color: #e4e8ee; flex: 0 0 auto; padding: 9px 11px; }
    .btn-ghost:hover { background: #e9edf2; }
    .deduprow { display: flex; align-items: center; gap: 8px; }
    .dedupdesc { font-size: 11px; color: #8a94a6; line-height: 1.45; flex: 1; min-width: 0; }
    .btn-mini {
      flex: 0 0 auto; font-size: 11px; padding: 4px 9px; border-radius: 7px;
      background: #f2f4f7; color: #46505f; border: 1px solid #e4e8ee;
      font-family: inherit; cursor: pointer; white-space: nowrap;
    }
    .btn-mini:hover { background: #e9edf2; }
    .btn-mini.wide { width: 100%; display: block; margin-top: 2px; text-align: center; }
    .btn-mini.strong { background: #eafaf9; color: #00787c; border-color: #bfe9e7; }
    .btn-mini.strong:hover { background: #dff5f3; }
    .btn:disabled { opacity: .45; cursor: not-allowed; filter: none; }

    /* ---- 我的条件 / 硬条件说明 ---- */
    .condnote {
      font-size: 10.2px; color: #8a94a6; line-height: 1.55;
      margin: 0 0 7px;
    }
    .condnote b { color: #00777b; font-weight: 600; }
    .rowbtn { display: flex; gap: 6px; margin-top: 7px; flex-wrap: wrap; }
    .btn.wide { width: 100%; flex: none; display: block; }

    .logbox {
      height: 124px; overflow-y: auto;
      background: #0f172a; border-radius: 10px; padding: 8px 10px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 10.6px; line-height: 1.65; color: #94a3b8;
    }
    .logbox::-webkit-scrollbar { width: 5px; }
    .logbox::-webkit-scrollbar-thumb { background: #334155; border-radius: 3px; }
    .logbox .l { display: flex; gap: 6px; }
    .logbox .t { color: #475569; flex: 0 0 auto; }
    .logbox .ok { color: #4ade80; }
    .logbox .err { color: #f87171; }
    .logbox .skip { color: #64748b; }
    .logbox .hit { color: #fbbf24; }
    .logbox .dim { color: #94a3b8; }

    .foot { font-size: 10px; color: #a3abb8; text-align: center; margin-top: 8px; line-height: 1.7; }
  `;

  const PANEL_HTML = `
    <div class="root">
      <button class="fab" id="fab" title="批量投递助手">投</button>
      <section class="panel" id="panel" style="display:none">
        <div class="head">
          <h1>批量投递助手</h1>
          <span class="badge" id="stateBadge">待机</span>
          <button class="x" id="closeBtn" title="收起">×</button>
        </div>
        <div class="body">
          <div class="stats">
            <div class="stat"><b id="sToday">0</b><span>今日 / 上限</span></div>
            <div class="stat"><b id="sScan">0</b><span>本次扫描</span></div>
            <div class="stat"><b id="sSkip">0</b><span>本次跳过</span></div>
          </div>

          <div class="skipbox" id="skipBox" style="display:none"></div>

          <div id="warnBox" class="warn" style="display:none">演练模式已开启：只列出会投的岗位，不会真的点击。</div>

          <div class="group">
            <div class="gtitle">开始投递 <span class="gtag" id="modeTag">按当前条件</span></div>
            <div class="condnote">全部条件自己填，插件<b>不再读取或识别简历</b>。期望城市 / 薪资 / <b>专业</b> / <b>编程语言</b>属于硬条件，海投模式也不会清掉。</div>
            <div class="rowbtn">
              <button class="btn-mini" id="sweepBtn" title="跳过软筛选，手填的硬条件仍然生效">海投模式</button>
            </div>
            <button class="btn btn-primary wide" id="autoBtn" style="margin-top:8px">一键全自动</button>
          </div>

          <div class="group">
            <div class="gtitle">专业 / 编程语言 <span class="gtag" id="hardTag">未设置</span></div>
            <div class="condnote">填了就生效；留空 / 一个都不勾 = 不按这一项拦。JD 里写「优先 / 不限」的一律不拦。</div>
            <div class="field">
              <label>我的专业 <em>逗号可填多个</em></label>
              <input type="text" id="major" placeholder="例：计算机相关, 软件工程">
            </div>
            <label class="tg" style="margin:1px 0 6px"><input type="checkbox" id="majorFilter"><span class="track"></span>
              <span class="txt">专业不符就跳过 <small>JD 明确限专业时按上面填的比</small></span></label>
            <div class="field">
              <label>我会的编程语言 <em>勾了才是硬条件</em></label>
              <div class="chips" id="langChips"></div>
            </div>
            <label class="tg" style="margin:1px 0"><input type="checkbox" id="langFilter"><span class="track"></span>
              <span class="txt">不会的语言就跳过 <small>JD 硬性要求没勾的语言</small></span></label>
          </div>

          <div class="group">
            <div class="gtitle">我的条件 <span class="gtag" id="condTag">手填</span></div>
            <div class="field">
              <label>招聘类型 <em>校招不看工作年限</em></label>
              <div class="chips" id="typeChips"></div>
            </div>
            <div class="field">
              <label>目标岗位</label>
              <input type="text" id="goalJob" placeholder="如：前端开发工程师">
            </div>
            <div class="field">
              <label>技能关键词 <em>命中越多分越高</em></label>
              <input type="text" id="skills" placeholder="React,Vue,TypeScript,Webpack">
            </div>
            <div class="row2">
              <div class="field">
                <label>工作年限</label>
                <input type="number" id="years" min="0" max="40" step="1" placeholder="3">
              </div>
              <div class="field">
                <label>最高学历</label>
                <select id="edu">
                  <option>不限</option>
                  <option>大专</option>
                  <option>本科</option>
                  <option>硕士</option>
                  <option>博士</option>
                </select>
              </div>
            </div>
            <div class="field">
              <label>期望城市 <em>硬条件，海投也不清空</em></label>
              <input type="text" id="cities" placeholder="北京,上海,杭州">
            </div>
          </div>

          <div class="group">
            <div class="gtitle">硬性筛选 <span class="gtag" id="strictTag">先看这里</span></div>
            <div class="field">
              <span class="fl">必含关键词 <em>任一命中即可</em>
                <label class="kwsw"><input type="checkbox" id="useInclude"><span>启用</span></label>
              </span>
              <div class="kwrow">
                <input type="text" id="inc" placeholder="留空 = 不限">
                <span class="kwhint off" id="incHint">已关闭</span>
              </div>
            </div>
            <div class="field">
              <span class="fl">排除关键词
                <label class="kwsw"><input type="checkbox" id="useExclude"><span>启用</span></label>
              </span>
              <div class="kwrow">
                <input type="text" id="exc" placeholder="销售,外包,驻场">
                <span class="kwhint" id="excHint">生效中</span>
              </div>
            </div>
            <div class="row3">
              <div class="field"><label>薪资下限 K</label><input type="number" id="minSalary" min="0" placeholder="0"></div>
              <div class="field"><label>薪资上限 K</label><input type="number" id="maxSalary" min="0" placeholder="0"></div>
              <div class="field"><label>匹配分阈值</label><input type="number" id="minScore" min="0" max="100" placeholder="60"></div>
            </div>
            <button class="btn-mini wide strong" id="loosenBtn">一键海投（跳过软筛选，投不出去点这个）</button>
          </div>

          <div class="group">
            <div class="gtitle">岗位要求 <span class="gtag" id="jdTag">读 JD</span></div>
            <div style="font-size:10.5px;color:#9aa3b2;line-height:1.5;margin-bottom:6px">
              逐个点开当前岗位 → 在 JD 卡片内滚动读全文，以「去APP与BOSS随时沟通」为截止
            </div>
            <div id="jdNow" style="font-size:11px;color:#8a94a6;background:#eef9f9;border-radius:6px;padding:7px 8px;margin-bottom:6px;line-height:1.45">
              当前详情：尚未点开岗位
            </div>
            <div id="jdLast" style="font-size:11px;color:#1c1f23;background:#f5f7fa;border-radius:6px;padding:7px 8px;margin-bottom:8px;line-height:1.45">
              尚未识别到岗位要求
            </div>
            <label class="tg" style="margin:1px 0"><input type="checkbox" id="forceOpenDetail"><span class="track"></span>
              <span class="txt">逐个点开岗位再判断 <small>确认右侧是本岗位才读 JD</small></span></label>
            <label class="tg" style="margin:1px 0"><input type="checkbox" id="jdScroll"><span class="track"></span>
              <span class="txt">JD 卡片内滚动加载 <small>展开折叠 + 长 JD 滚到底</small></span></label>
            <label class="tg" style="margin:1px 0 8px"><input type="checkbox" id="strictDetail"><span class="track"></span>
              <span class="txt">详情没切到本岗位就不投 <small>防投到最初那个岗位</small></span></label>
            <label class="tg" style="margin:1px 0"><input type="checkbox" id="jdScan"><span class="track"></span>
              <span class="txt">读取并识别岗位要求 <small>学历 / 经验 / 证书 / 工作条件</small></span></label>
            <label class="tg" style="margin:1px 0 8px"><input type="checkbox" id="jdBlock"><span class="track"></span>
              <span class="txt">按硬性要求自动跳过 <small>关掉 = 只记录不拦截</small></span></label>
            <div class="field">
              <label>我不能接受 <em>不勾 = 不拦</em></label>
              <div class="chips" id="jdRejectChips"></div>
            </div>
            <label class="tg" style="margin:1px 0"><input type="checkbox" id="strictCity"><span class="track"></span>
              <span class="txt">地点确认不了就不投 <small>防止选杭州投到南京</small></span></label>
            <label class="tg" style="margin:1px 0"><input type="checkbox" id="companyIdDedup"><span class="track"></span>
              <span class="txt">用公司 ID 去重 <small>同公司不同 HR 也算一家</small></span></label>
            <label class="tg" style="margin:1px 0"><input type="checkbox" id="fetchDetail"><span class="track"></span>
              <span class="txt">主动补详情接口 <small>额外请求，可能触发风控，默认关</small></span></label>
          </div>

          <div class="group">
            <div class="gtitle clk" id="aiTitle">AI 语义判断 <span class="gtag" id="aiTag">未启用</span> <i class="chev">▾</i></div>
            <div id="aiBody" style="display:none">
              <div style="font-size:10.5px;color:#9aa3b2;line-height:1.55;margin-bottom:8px">
                把 <b>JD 全文</b> 和你的筛选条件交给大模型读，分清「必须 / 优先」，认出证书、专业、驻场这类隐含门槛。
                需要你自己的 API Key，<b>JD 与你的结构化条件会发送给你选的服务商</b>；插件不再读取或发送简历原文。
              </div>
              <label class="tg" style="margin:1px 0 8px"><input type="checkbox" id="aiEnabled"><span class="track"></span>
                <span class="txt">启用 AI 语义判断 <small>点沟通按钮前复核</small></span></label>
              <div class="field">
                <label>服务商 <em>OpenAI 兼容接口</em></label>
                <select id="aiProvider"></select>
              </div>
              <div class="field">
                <label>模型名</label>
                <input type="text" id="aiModel" placeholder="deepseek-chat">
              </div>
              <div class="field">
                <label>接口地址 <em>选内置服务商会自动填</em></label>
                <input type="text" id="aiBaseUrl" placeholder="https://api.deepseek.com/v1">
              </div>
              <div class="field">
                <label>API Key <em>只存本机</em></label>
                <input type="password" id="aiApiKey" placeholder="sk-..." autocomplete="off">
              </div>
              <div class="field">
                <label>判断方式</label>
                <select id="aiMode">
                  <option value="veto">只拦硬性不符（推荐，不误杀）</option>
                  <option value="score">按 AI 匹配分阈值拦</option>
                  <option value="log">只记录，绝不拦截</option>
                </select>
              </div>
              <div class="row3">
                <div class="field"><label>最低分</label><input type="number" id="aiMinScore" min="0" max="100" step="1" placeholder="60"></div>
                <div class="field"><label>超时 s</label><input type="number" id="aiTimeout" min="3" max="120" step="1" placeholder="20"></div>
                <div class="field"><label>JD 上限字</label><input type="number" id="aiMaxChars" min="2000" max="40000" step="1000" placeholder="12000"></div>
              </div>
              <div class="field">
                <label>补充要求 <em>会一起发给模型</em></label>
                <textarea id="aiExtra" rows="2" placeholder="例：不投要求长期出差的；只接受 2026 届可投的岗位"></textarea>
              </div>
              <label class="tg" style="margin:1px 0"><input type="checkbox" id="aiSendProfile"><span class="track"></span>
                <span class="txt">附带技能 / 目标岗位等补充条件 <small>专业、语言、学历始终会带</small></span></label>
              <label class="tg" style="margin:1px 0 8px"><input type="checkbox" id="aiFailOpen"><span class="track"></span>
                <span class="txt">调用失败按原规则放行 <small>强烈建议保持开启</small></span></label>
              <div class="rowbtn">
                <button class="btn-mini" id="aiTestBtn">测试连接</button>
                <button class="btn-mini" id="aiClearCacheBtn">清空缓存</button>
              </div>
              <div id="aiStatus" style="font-size:10.5px;color:#6b7686;line-height:1.45;margin-top:6px">未测试</div>
              <div id="aiLast" style="font-size:11px;color:#1c1f23;background:#f5f7fa;border-radius:6px;padding:7px 8px;margin-top:7px;line-height:1.45">最近一次 AI 判断：—</div>
            </div>
          </div>

          <div class="group">
            <div class="gtitle clk" id="gCompanyTitle">公司筛选 <span class="gtag" id="companyCount">规模 / 融资</span> <i class="chev">▾</i></div>
            <div id="gCompanyBody" style="display:none">
              <div class="field">
                <label>公司规模 <em>不选 = 不限</em></label>
                <div class="chips" id="scaleChips"></div>
              </div>
              <div class="field">
                <label>融资阶段 <em>不选 = 不限</em></label>
                <div class="chips" id="financeChips"></div>
              </div>
              <div class="field">
                <label>只要这些公司 <em>逗号分隔，留空不限</em></label>
                <input type="text" id="companyInclude" placeholder="字节,腾讯,阿里">
              </div>
              <div class="field">
                <label>排除公司 <em>公司名含这些词就跳过</em></label>
                <input type="text" id="companyExclude" placeholder="人力,外包">
              </div>
            </div>
          </div>

          <div class="group">
            <div class="gtitle clk" id="certTitle">证书要求 <span class="gtag" id="certTag">未勾选</span> <i class="chev">▾</i></div>
            <div id="certBody" style="display:none">
              <label class="tg" style="margin:1px 0 8px"><input type="checkbox" id="certFilter"><span class="track"></span>
                <span class="txt">硬性要求证书的不投 <small>写「优先」的照投</small></span></label>
              <div class="field">
                <label>我持有的证书 <em>勾了的要求就放行</em></label>
                <div class="chips" id="certChips"></div>
              </div>
            </div>
          </div>

          <div class="group">
            <div class="gtitle">发布时间 <span class="gtag" id="freshTag">不限</span></div>
            <div class="chips" id="freshChips"></div>
          </div>

          <div class="group">
            <div class="gtitle">去重 <span class="gtag" id="dedupTag">已锁 0 家公司</span></div>
            <div class="deduprow">
              <span class="dedupdesc">投过一家公司后，它旗下所有岗位都跳过</span>
              <button class="btn-mini" id="clearCompanyBtn">清空</button>
            </div>
          </div>

          <div class="group">
            <div class="gtitle">节奏</div>
            <div class="row3">
              <div class="field"><label>每日上限</label><input type="number" id="dailyLimit" min="1" max="500" step="1" placeholder="150"></div>
              <div class="field"><label>间隔最小 s</label><input type="number" id="gapMin" min="3" max="600" step="1" placeholder="8"></div>
              <div class="field"><label>间隔最大 s</label><input type="number" id="gapMax" min="3" max="600" step="1" placeholder="15"></div>
            </div>
            <div class="row3">
              <div class="field"><label>详情加载等待 s</label><input type="number" id="detailWait" min="0.5" max="30" step="0.5" placeholder="3"></div>
              <div class="field"><label>滚动加载等待 s</label><input type="number" id="scrollWait" min="0.2" max="20" step="0.2" placeholder="1.4"></div>
              <div class="field"><label>详情重试次数</label><input type="number" id="detailRetry" min="1" max="5" step="1" placeholder="3"></div>
            </div>
            <div class="row3">
              <div class="field"><label>JD 每步等待 ms</label><input type="number" id="jdScrollWait" min="0" max="1500" step="20" placeholder="160"></div>
              <div class="field"><label>JD 滚动屏数</label><input type="number" id="jdScrollSteps" min="0" max="40" step="1" placeholder="12"></div>
              <div class="field"><label>JD 全文字数</label><input type="number" id="jdMaxChars" min="1000" max="40000" step="1000" placeholder="12000"></div>
            </div>
            <div style="font-size:10.5px;color:#9aa3b2;line-height:1.5;margin-top:4px">
              网慢：把「详情加载等待」调到 6–10 秒、「滚动加载等待」调到 3–5 秒；JD 很长就把「JD 滚动屏数」调到 20–30、「每步等待」调到 300–500ms。
            </div>
          </div>

          <div class="toggles">
            <label class="tg"><input type="checkbox" id="useResume"><span class="track"></span>
              <span class="txt">按手填条件算匹配分 <small>低于阈值不投</small></span></label>
            <label class="tg"><input type="checkbox" id="autoScroll"><span class="track"></span>
              <span class="txt">自动翻页 <small>投完一屏继续下一屏</small></span></label>
            <label class="tg"><input type="checkbox" id="detailClick"><span class="track"></span>
              <span class="txt">逐条点开职位再投 <small>列表+右侧详情布局必开</small></span></label>
            <label class="tg"><input type="checkbox" id="onlyNew"><span class="track"></span>
              <span class="txt">只投未沟通的</span></label>
            <label class="tg"><input type="checkbox" id="companyDedup"><span class="track"></span>
              <span class="txt">同一公司只投一次 <small>投过就跳过它所有岗位</small></span></label>
            <label class="tg"><input type="checkbox" id="freshFirst"><span class="track"></span>
              <span class="txt">优先投最新的 <small>新发布的先投</small></span></label>
            <label class="tg"><input type="checkbox" id="dryRun"><span class="track"></span>
              <span class="txt">演练模式 <small>只看名单不点击</small></span></label>
          </div>

          <div class="actions">
            <button class="btn btn-primary" id="startBtn">开始</button>
            <button class="btn btn-ghost" id="recordsBtn" title="查看投递记录表格">记录</button>
            <button class="btn btn-ghost" id="resetBtn" title="清空今日计数">重置</button>
          </div>

          <div class="logbox" id="logbox"></div>
          <div class="foot">运行期间请保持本标签页在当前窗口，勿最小化<br>ESC 键可随时紧急停止</div>
        </div>
      </section>
    </div>
  `;

  /* ------------------------------------------------------------------ *
   * 配置补丁 / 海投 / 一键全自动 / 硬条件界面同步
   * ------------------------------------------------------------------ */

  /** 专业 / 语言区的界面同步（顶层，render / applySweep / 事件都会调） */
  function syncMajorLang() {
    if (!ui || !ui.langChips) return;
    const set = new Set(splitList(cfg.langOwned));
    ui.langChips.querySelectorAll('.chip').forEach((c) => {
      c.classList.toggle('on', set.has(c.dataset.v));
    });
    if (ui.major) ui.major.value = cfg.major || '';
    if (ui.majorFilter) ui.majorFilter.checked = cfg.majorFilter !== false;
    if (ui.langFilter) ui.langFilter.checked = cfg.langFilter !== false;
    const bits = [];
    if (String(cfg.major || '').trim() && cfg.majorFilter !== false) bits.push('专业');
    if (set.size && cfg.langFilter !== false) bits.push('语言 ' + set.size + ' 种');
    if (ui.hardTag) {
      ui.hardTag.textContent = bits.length ? bits.join(' + ') : '未设置';
      ui.hardTag.classList.toggle('warn', bits.length > 0);
    }
    if (ui.condTag) ui.condTag.textContent = cfg.sweepMode ? '海投模式' : '手填条件';
  }

  /** 把配置补丁写进 cfg 并同步到界面 */
  function applyPatch(patch) {
    if (!patch) return;
    cfg = Object.assign({}, cfg, patch);

    const set = (el, v) => {
      if (el && v !== undefined) el.value = v;
    };
    set(ui.goalJob, patch.goalJob);
    set(ui.skills, patch.skills);
    set(ui.years, patch.years);
    set(ui.edu, patch.edu);
    set(ui.cities, patch.cities);
    set(ui.inc, patch.include);
    set(ui.exc, patch.exclude);
    set(ui.companyInclude, patch.companyInclude);
    set(ui.companyExclude, patch.companyExclude);
    set(ui.minScore, patch.minScore);
    set(ui.minSalary, patch.minSalary);
    set(ui.maxSalary, patch.maxSalary);
    set(ui.detailWait, patch.detailWait);
    set(ui.scrollWait, patch.scrollWait);
    set(ui.detailRetry, patch.detailRetry);
    set(ui.jdScrollWait, patch.jdScrollWait);
    set(ui.jdScrollSteps, patch.jdScrollSteps);
    set(ui.jdMaxChars, patch.jdMaxChars);
    if (patch.detailClick !== undefined) ui.detailClick.checked = !!patch.detailClick;
    if (patch.forceOpenDetail !== undefined) ui.forceOpenDetail.checked = !!patch.forceOpenDetail;
    if (patch.strictDetail !== undefined) ui.strictDetail.checked = !!patch.strictDetail;
    if (patch.jdScroll !== undefined) ui.jdScroll.checked = !!patch.jdScroll;
    if (patch.useResume !== undefined) ui.useResume.checked = !!patch.useResume;
    if (patch.certFilter !== undefined) ui.certFilter.checked = !!patch.certFilter;
    if (patch.useInclude !== undefined) ui.useInclude.checked = !!patch.useInclude;
    if (patch.useExclude !== undefined) ui.useExclude.checked = !!patch.useExclude;
    if (patch.include === '' && patch.useInclude === undefined) {
      cfg.useInclude = false;
      ui.useInclude.checked = false;
    }
    syncKwHint();
    syncJd();
    syncMajorLang();
    if (patch.recruitType !== undefined && ui._syncType) {
      ui._syncType();
      ui._applyTypeUI();
    }
    saveCfg();
    render();
  }

  /** 海投：跳过软筛选，但用户手填的硬条件一个都不清 */
  function applySweep() {
    applyPatch({
      sweepMode: true,
      useResume: false,
      goalJob: '',
      skills: '',
      years: '',
      edu: '不限',
      minScore: 0,
      certFilter: false,
      certOwned: '',
      // 城市 / 薪资 / 专业 / 编程语言是用户明确填过的硬条件，一律不清空。
      scaleList: '',
      financeList: '',
      companyInclude: '',
      companyExclude: '',
      include: '',
      exclude: '',
      useInclude: false,
      useExclude: false,
      freshMax: 0,
      recruitType: '',
      passVague: true
    });

    const clearChips = (el) => {
      if (el && el.querySelectorAll) {
        el.querySelectorAll('.chip').forEach((c) => c.classList.remove('on'));
      }
    };
    clearChips(ui.scaleChips);
    clearChips(ui.financeChips);
    clearChips(ui.certChips);
    clearChips(ui.freshChips);
    clearChips(ui.typeChips);
    // 注意：langChips 不能清 —— 勾过的语言是硬条件
    if (ui.certFilter) ui.certFilter.checked = false;
    if (ui.useResume) ui.useResume.checked = false;
    if (ui.useInclude) ui.useInclude.checked = false;
    if (ui.useExclude) ui.useExclude.checked = false;
    if (ui.freshTag) ui.freshTag.textContent = '不限';
    if (ui.certTag) ui.certTag.textContent = '未勾选';
    syncKwHint();
    syncCert();
    syncJd();
    syncMajorLang();
    saveCfg();
    render();
    log(
      '海投模式已开启：关键词 / 证书 / 学历 / 招聘类型 / 发布时间 / 公司筛选 / 匹配分全部跳过。' +
        '你手填的「期望城市 ' + (cfg.cities || '未填') + '」、薪资上下限、专业「' +
        (cfg.major || '未填') + '」和已勾的编程语言「' + (cfg.langOwned || '未勾') +
        '」仍然生效（海投不清空硬条件）。',
      'ok'
    );
  }

  /** 一键全自动：按面板上当前的条件直接开始，不再解析简历 */
  async function autoRun() {
    if (st.running) {
      stop();
      return;
    }
    log('按面板当前条件开始全自动投递（不再读取简历）。', 'dim');
    run();
  }

  /** 关键词开关的状态提示：让人一眼看出「填了但没启用」这种坑 */
  function syncKwHint() {
    if (!ui || !ui.useInclude || !ui.useExclude) return;

    const set = (chk, hint, val, emptyText) => {
      const on = !!chk.checked;
      const has = String(val || '').trim().length > 0;
      const wrap = chk.closest('.kwsw');
      if (wrap) wrap.classList.toggle('off', !on);

      if (!hint) return;
      if (!on) {
        hint.textContent = '已关闭';
        hint.className = 'kwhint off';
      } else if (!has) {
        hint.textContent = emptyText;
        hint.className = 'kwhint off';
      } else {
        hint.textContent = '生效中';
        hint.className = 'kwhint';
      }
    };

    set(ui.useInclude, ui.incHint, ui.inc.value, '留空不限');
    set(ui.useExclude, ui.excHint, ui.exc.value, '留空不限');
  }

  /** 证书区界面同步。放顶层：applySweep 等面板外的函数也要能调用。 */
  /** 岗位要求区界面同步（顶层，render / applySweep 都会调） */
  function syncJd() {
    if (!ui || !ui.jdRejectChips) return;
    const set = new Set(splitList(cfg.jdReject));
    ui.jdRejectChips.querySelectorAll('.chip').forEach((c) => {
      c.classList.toggle('on', set.has(c.dataset.v));
    });
    if (ui.jdScan) ui.jdScan.checked = cfg.jdScan !== false;
    if (ui.jdBlock) ui.jdBlock.checked = cfg.jdBlock !== false;
    if (ui.strictCity) ui.strictCity.checked = cfg.strictCity !== false;
    if (ui.companyIdDedup) ui.companyIdDedup.checked = cfg.companyIdDedup !== false;
    if (ui.fetchDetail) ui.fetchDetail.checked = cfg.fetchDetail === true;
    if (ui.jdTag) {
      ui.jdTag.textContent =
        cfg.jdScan === false ? '已关闭' : cfg.jdBlock === false ? '只记录' : '自动拦截';
      ui.jdTag.classList.toggle('warn', cfg.jdScan !== false && cfg.jdBlock !== false);
    }
    if (ui.jdLast) {
      ui.jdLast.textContent = st.lastReq
        ? '最近一份岗位：' + st.lastReq
        : '尚未识别到岗位要求';
    }
    if (ui.jdNow) {
      ui.jdNow.textContent = st.lastDetailTitle
        ? '当前详情：' + st.lastDetailTitle + ' · JD ' + (st.lastJdChars || 0) + ' 字 · ' +
          (st.lastJdEnd ? '已读到「去APP与BOSS随时沟通」' : '未找到截止按钮，按详情全文判断')
        : '当前详情：尚未点开岗位';
      ui.jdNow.style.color = st.lastDetailTitle ? '#00777b' : '#8a94a6';
    }
  }

  /** AI 区界面同步（顶层，render / 配置变更都会调） */
  function syncAi() {
    if (!ui || !ui.aiTag) return;
    const on = !!cfg.aiEnabled && cfg.aiProvider !== 'off';
    ui.aiTag.textContent = on
      ? (cfg.aiMode === 'log' ? '只记录' : '已开启')
      : '未启用';
    ui.aiTag.classList.toggle('warn', on);

    if (ui.aiMinScore) {
      const usable = cfg.aiMode === 'score';
      ui.aiMinScore.disabled = !usable;
      ui.aiMinScore.style.opacity = usable ? '' : '.45';
    }
    if (ui.aiLast) {
      const a = st.lastAi;
      ui.aiLast.textContent = a
        ? '最近一次 AI 判断：' +
          (typeof a.score === 'number' ? a.score + '分 · ' : '') +
          (a.hard ? '硬性不符' : a.fit ? '建议投' : '不太匹配') +
          ' · ' + (a.summary || '') +
          (a.reasons && a.reasons.length ? '（' + a.reasons.slice(0, 2).join('；') + '）' : '')
        : '最近一次 AI 判断：—';
    }
  }

  function syncCert() {
    if (!ui || !ui.certChips || !ui.certFilter || !ui.certTag) return;
    const set = new Set(splitList(cfg.certOwned));
    ui.certChips.querySelectorAll('.chip').forEach((c) => {
      c.classList.toggle('on', set.has(c.dataset.v));
    });
    ui.certFilter.checked = cfg.certFilter !== false;
    const n = set.size;
    ui.certTag.textContent =
      cfg.certFilter === false ? '不启用' : n ? '持有 ' + n + ' 项' : '未勾选';
    ui.certTag.classList.toggle('warn', n > 0);
  }

  function buildUI() {
    // 避免与 BOSS 自身样式冲突，全部放进 Shadow DOM
    const host = document.createElement('div');
    host.id = 'baa-host';
    host.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;z-index:2147483600;';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<style>' + PANEL_CSS + '</style>' + PANEL_HTML;
    document.body.appendChild(host);

    const $ = (id) => shadow.getElementById(id);

    ui = {
      host,
      shadow,
      $,
      fab: $('fab'),
      panel: $('panel'),
      badge: $('stateBadge'),
      warnBox: $('warnBox'),
      sToday: $('sToday'),
      sScan: $('sScan'),
      sSkip: $('sSkip'),
      skipBox: $('skipBox'),
      strictTag: $('strictTag'),
      modeTag: $('modeTag'),
      sweepBtn: $('sweepBtn'),
      autoBtn: $('autoBtn'),
      major: $('major'),
      majorFilter: $('majorFilter'),
      langFilter: $('langFilter'),
      langChips: $('langChips'),
      hardTag: $('hardTag'),
      condTag: $('condTag'),
      goalJob: $('goalJob'),
      skills: $('skills'),
      years: $('years'),
      edu: $('edu'),
      cities: $('cities'),
      inc: $('inc'),
      exc: $('exc'),
      useInclude: $('useInclude'),
      useExclude: $('useExclude'),
      incHint: $('incHint'),
      excHint: $('excHint'),
      loosenBtn: $('loosenBtn'),
      minSalary: $('minSalary'),
      maxSalary: $('maxSalary'),
      minScore: $('minScore'),
      dailyLimit: $('dailyLimit'),
      gapMin: $('gapMin'),
      gapMax: $('gapMax'),
      detailWait: $('detailWait'),
      scrollWait: $('scrollWait'),
      detailRetry: $('detailRetry'),
      detailClick: $('detailClick'),
      forceOpenDetail: $('forceOpenDetail'),
      strictDetail: $('strictDetail'),
      jdScroll: $('jdScroll'),
      jdScrollWait: $('jdScrollWait'),
      jdScrollSteps: $('jdScrollSteps'),
      jdMaxChars: $('jdMaxChars'),
      jdNow: $('jdNow'),
      useResume: $('useResume'),
      dryRun: $('dryRun'),
      onlyNew: $('onlyNew'),
      companyDedup: $('companyDedup'),
      freshFirst: $('freshFirst'),
      autoScroll: $('autoScroll'),
      companyInclude: $('companyInclude'),
      companyExclude: $('companyExclude'),
      scaleChips: $('scaleChips'),
      financeChips: $('financeChips'),
      typeChips: $('typeChips'),
      companyCount: $('companyCount'),
      dedupTag: $('dedupTag'),
      clearCompanyBtn: $('clearCompanyBtn'),
      freshTag: $('freshTag'),
      freshChips: $('freshChips'),
      certFilter: $('certFilter'),
      certChips: $('certChips'),
      jdScan: $('jdScan'),
      jdBlock: $('jdBlock'),
      jdTag: $('jdTag'),
      jdLast: $('jdLast'),
      jdRejectChips: $('jdRejectChips'),
      strictCity: $('strictCity'),
      companyIdDedup: $('companyIdDedup'),
      fetchDetail: $('fetchDetail'),
      aiTitle: $('aiTitle'),
      aiBody: $('aiBody'),
      aiTag: $('aiTag'),
      aiEnabled: $('aiEnabled'),
      aiProvider: $('aiProvider'),
      aiModel: $('aiModel'),
      aiBaseUrl: $('aiBaseUrl'),
      aiApiKey: $('aiApiKey'),
      aiMode: $('aiMode'),
      aiMinScore: $('aiMinScore'),
      aiTimeout: $('aiTimeout'),
      aiMaxChars: $('aiMaxChars'),
      aiExtra: $('aiExtra'),
      aiSendProfile: $('aiSendProfile'),
      aiFailOpen: $('aiFailOpen'),
      aiTestBtn: $('aiTestBtn'),
      aiClearCacheBtn: $('aiClearCacheBtn'),
      aiStatus: $('aiStatus'),
      aiLast: $('aiLast'),
      certTag: $('certTag'),
      certTitle: $('certTitle'),
      certBody: $('certBody'),
      gCompanyTitle: $('gCompanyTitle'),
      gCompanyBody: $('gCompanyBody'),
      startBtn: $('startBtn'),
      recordsBtn: $('recordsBtn'),
      resetBtn: $('resetBtn'),
      logbox: $('logbox')
    };

    // 填充配置
    ui.major.value = cfg.major || '';
    ui.majorFilter.checked = cfg.majorFilter !== false;
    ui.langFilter.checked = cfg.langFilter !== false;
    ui.goalJob.value = cfg.goalJob;
    ui.skills.value = cfg.skills;
    ui.years.value = cfg.years;
    ui.edu.value = cfg.edu;
    ui.cities.value = cfg.cities;
    ui.inc.value = cfg.include;
    ui.exc.value = cfg.exclude;
    ui.useInclude.checked = !!cfg.useInclude;
    ui.useExclude.checked = cfg.useExclude !== false;
    syncKwHint();
    ui.minSalary.value = cfg.minSalary;
    ui.maxSalary.value = cfg.maxSalary;
    ui.minScore.value = cfg.minScore;
    ui.dailyLimit.value = cfg.dailyLimit;
    ui.gapMin.value = cfg.gapMin;
    ui.gapMax.value = cfg.gapMax;
    ui.detailWait.value = cfg.detailWait;
    ui.scrollWait.value = cfg.scrollWait;
    ui.detailRetry.value = cfg.detailRetry;
    ui.detailClick.checked = cfg.detailClick !== false;
    ui.forceOpenDetail.checked = cfg.forceOpenDetail !== false;
    ui.strictDetail.checked = cfg.strictDetail !== false;
    ui.jdScroll.checked = cfg.jdScroll !== false;
    ui.jdScrollWait.value = cfg.jdScrollWait;
    ui.jdScrollSteps.value = cfg.jdScrollSteps;
    ui.jdMaxChars.value = cfg.jdMaxChars;
    ui.useResume.checked = cfg.useResume;
    ui.dryRun.checked = cfg.dryRun;
    ui.onlyNew.checked = cfg.onlyNew;
    ui.companyDedup.checked = cfg.companyDedup !== false;
    ui.jdScan.checked = cfg.jdScan !== false;
    ui.jdBlock.checked = cfg.jdBlock !== false;
    ui.strictCity.checked = cfg.strictCity !== false;
    ui.companyIdDedup.checked = cfg.companyIdDedup !== false;
    ui.fetchDetail.checked = cfg.fetchDetail === true;

    /* ---- AI 语义判断：下拉预设 + 回填配置 ---- */
    AI_PROVIDERS.forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.label;
      ui.aiProvider.appendChild(opt);
    });
    ui.aiProvider.value = cfg.aiProvider || 'deepseek';
    if (!ui.aiProvider.value) ui.aiProvider.value = 'deepseek';
    ui.aiModel.value = cfg.aiModel || 'deepseek-chat';
    ui.aiBaseUrl.value = cfg.aiBaseUrl || 'https://api.deepseek.com/v1';
    ui.aiApiKey.value = cfg.aiApiKey || '';
    ui.aiMode.value = cfg.aiMode || 'veto';
    ui.aiMinScore.value = cfg.aiMinScore;
    ui.aiTimeout.value = cfg.aiTimeout;
    ui.aiMaxChars.value = cfg.aiMaxChars;
    ui.aiExtra.value = cfg.aiExtra || '';
    ui.aiEnabled.checked = !!cfg.aiEnabled;
    ui.aiSendProfile.checked = cfg.aiSendProfile !== false;
    ui.aiFailOpen.checked = cfg.aiFailOpen !== false;
    if (cfg.aiEnabled) {
      ui.aiBody.style.display = 'block';
    } else {
      ui.aiTitle.classList.add('collapsed');
    }
    syncAi();
    syncJd();
    ui.freshFirst.checked = !!cfg.freshFirst;
    ui.autoScroll.checked = cfg.autoScroll;
    ui.companyInclude.value = cfg.companyInclude;
    ui.companyExclude.value = cfg.companyExclude;

    /* ---- 公司规模 / 融资 chips ---- */
    const buildChips = (wrap, items) => {
      wrap.innerHTML = '';
      items.forEach((item) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'chip';
        b.dataset.v = item.id || item;
        b.textContent = item.label || item;
        wrap.appendChild(b);
      });
    };

    buildChips(ui.typeChips, [
      { id: 'social', label: '社招' },
      { id: 'campus', label: '校招' },
      { id: 'intern', label: '实习' }
    ]);
    buildChips(ui.scaleChips, SCALE_RANGES);
    buildChips(ui.financeChips, FINANCE_STAGES);
    buildChips(ui.jdRejectChips, JD_REJECT_CHOICES.map((r) => r.id));

    const syncType = () => {
      ui.typeChips.querySelectorAll('.chip').forEach((c) => {
        c.classList.toggle('on', c.dataset.v === cfg.recruitType);
      });
    };

    // 校招 / 实习不看工作年限，把该输入框置灰
    const applyTypeUI = () => {
      const skip = cfg.recruitType !== 'social';
      ui.years.disabled = skip;
      ui.years.style.opacity = skip ? '.45' : '';
      ui.years.title = skip ? '校招 / 实习不按工作年限评分' : '';
    };

    syncType();
    applyTypeUI();
    // 供模块级的 applyPatch 调用（改配置后要同步招聘类型的选中态）
    ui._syncType = syncType;
    ui._applyTypeUI = applyTypeUI;

    const TYPE_MSG = {
      social: '已切到社招模式：按工作年限参与评分。',
      campus: '已切到校招模式：不按年限评分，并跳过要求 2 年以上经验的岗位。',
      intern:
        '已切到实习模式：不按年限评分，并跳过要求 1 年以上经验的岗位。日薪按 21.75 天/月折算成月薪再比较。'
    };

    ui.typeChips.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      cfg.recruitType = chip.dataset.v;
      saveCfg();
      syncType();
      applyTypeUI();
      log(TYPE_MSG[cfg.recruitType] || '', 'dim');

      // 实习岗薪资口径不同，下限设太高会全军覆没
      if (cfg.recruitType === 'intern' && cfg.minSalary > 10) {
        log(
          '提醒：当前薪资下限 ' + cfg.minSalary + 'K 可能过滤掉全部实习岗（日薪 200 元 ≈ 4.4K）。',
          'err'
        );
      }
    });

    const syncChips = (wrap, val) => {
      const set = new Set(splitList(val));
      wrap.querySelectorAll('.chip').forEach((c) => {
        c.classList.toggle('on', set.has(c.dataset.v));
      });
    };

    syncChips(ui.scaleChips, cfg.scaleList);
    syncChips(ui.financeChips, cfg.financeList);

    const refreshCompanyTag = () => {
      const n = splitList(cfg.scaleList).length + splitList(cfg.financeList).length;
      ui.companyCount.textContent = n ? '已选 ' + n + ' 项' : '规模 / 融资';
    };
    refreshCompanyTag();

    const onChipClick = (wrap, key) => {
      wrap.addEventListener('click', (e) => {
        const chip = e.target.closest('.chip');
        if (!chip) return;
        chip.classList.toggle('on');
        const vals = Array.from(wrap.querySelectorAll('.chip.on')).map((c) => c.dataset.v);
        cfg[key] = vals.join(',');
        saveCfg();
        refreshCompanyTag();
        render();
      });
    };
    onChipClick(ui.scaleChips, 'scaleList');
    onChipClick(ui.financeChips, 'financeList');

    /* ---- 发布时间（单选） ---- */
    buildChips(ui.freshChips, FRESH_OPTIONS.map((o) => ({ id: o.id, label: o.label })));

    const syncFresh = () => {
      const cur = FRESH_OPTIONS.find((o) => o.hours === cfg.freshMax) || FRESH_OPTIONS[0];
      ui.freshChips.querySelectorAll('.chip').forEach((c) => {
        c.classList.toggle('on', c.dataset.v === cur.id);
      });
      ui.freshTag.textContent = cur.label;
      ui.freshTag.classList.toggle('warn', cur.hours > 0);
    };
    syncFresh();

    ui.freshChips.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      const opt = FRESH_OPTIONS.find((o) => o.id === chip.dataset.v);
      if (!opt) return;
      cfg.freshMax = opt.hours;
      saveCfg();
      syncFresh();
      log(
        opt.hours
          ? '只看 ' + opt.label + '发布 / 活跃的岗位，更早的跳过。'
          : '发布时间不限。',
        'dim'
      );
    });

    /* ---- 证书（多选） ---- */
    buildChips(ui.certChips, CERT_CHOICES.map((c) => ({ id: c, label: c })));

    syncCert();

    ui.certChips.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      chip.classList.toggle('on');
      const vals = Array.from(ui.certChips.querySelectorAll('.chip.on')).map((c) => c.dataset.v);
      cfg.certOwned = vals.join(',');
      saveCfg();
      syncCert();
      log(
        vals.length
          ? '已标记持有：' + vals.join('、')
          : '未勾选任何证书 —— 硬性要求证书的岗位会全部跳过。',
        vals.length ? 'dim' : 'err'
      );
    });

    /* ---- 编程语言（多选，硬条件） ---- */
    buildChips(ui.langChips, LANG_CHOICES.map((x) => ({ id: x, label: x })));
    ui.langChips.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      chip.classList.toggle('on');
      cfg.langOwned = Array.from(ui.langChips.querySelectorAll('.chip.on'))
        .map((c) => c.dataset.v).join(',');
      saveCfg();
      syncMajorLang();
      log(
        cfg.langOwned
          ? '已勾会用的语言：' + cfg.langOwned + '。JD 硬性要求其它语言 → 跳过。'
          : '未勾任何语言 —— 不按编程语言拦岗位。',
        'dim'
      );
    });
    syncMajorLang();

    ui.certFilter.addEventListener('change', () => {
      cfg.certFilter = ui.certFilter.checked;
      saveCfg();
      syncCert();
      log(
        cfg.certFilter
          ? '证书过滤已开启：硬性要求你没有的证书 → 跳过。'
          : '证书过滤已关闭：要求证书的岗位也会投。',
        'dim'
      );
    });

    if (splitList(cfg.certOwned).length) {
      ui.certBody.style.display = 'block';
    } else {
      ui.certTitle.classList.add('collapsed');
    }

    /* ---- 一键放宽：直接切到真正的海投，不再只放 4 项 ---- */
    ui.loosenBtn.addEventListener('click', () => applySweep());

    ui.certTitle.addEventListener('click', () => {
      const open = ui.certBody.style.display !== 'none';
      ui.certBody.style.display = open ? 'none' : 'block';
      ui.certTitle.classList.toggle('collapsed', open);
    });

    // 折叠：已配置过就默认展开
    const hasCompanyCfg =
      splitList(cfg.scaleList).length > 0 || splitList(cfg.financeList).length > 0;
    if (hasCompanyCfg) {
      ui.gCompanyBody.style.display = 'block';
    } else {
      ui.gCompanyTitle.classList.add('collapsed');
    }

    ui.gCompanyTitle.addEventListener('click', () => {
      const open = ui.gCompanyBody.style.display !== 'none';
      ui.gCompanyBody.style.display = open ? 'none' : 'block';
      ui.gCompanyTitle.classList.toggle('collapsed', open);
    });

    // 事件
    ui.fab.addEventListener('click', () => togglePanel(true));
    $('closeBtn').addEventListener('click', () => togglePanel(false));

    [ui.goalJob, ui.skills, ui.cities, ui.major, ui.inc, ui.exc, ui.companyInclude, ui.companyExclude].forEach(
      (el) => el.addEventListener('input', () => {
        syncKwHint();
        persistCfg();
      })
    );
    [
      ui.years, ui.minSalary, ui.maxSalary, ui.minScore, ui.dailyLimit,
      ui.gapMin, ui.gapMax, ui.detailWait, ui.scrollWait, ui.detailRetry,
      ui.jdScrollWait, ui.jdScrollSteps, ui.jdMaxChars
    ].forEach((el) => el.addEventListener('change', persistCfg));
    ui.edu.addEventListener('change', persistCfg);
    [
      ui.useResume, ui.dryRun, ui.onlyNew, ui.autoScroll, ui.companyDedup,
      ui.freshFirst, ui.detailClick, ui.jdScan, ui.jdBlock, ui.strictCity,
      ui.companyIdDedup, ui.fetchDetail, ui.majorFilter, ui.langFilter,
      ui.forceOpenDetail, ui.strictDetail, ui.jdScroll
    ].forEach((el) => el.addEventListener('change', () => {
      persistCfg();
      syncJd();
      syncMajorLang();
    }));

    // 「我不能接受」勾选：默认一个都不勾，不会因为新功能把岗位全拦掉
    ui.jdRejectChips.addEventListener('click', (e) => {
      const chip = e.target.closest && e.target.closest('.chip');
      if (!chip) return;
      const vals = new Set(splitList(cfg.jdReject));
      if (vals.has(chip.dataset.v)) vals.delete(chip.dataset.v);
      else vals.add(chip.dataset.v);
      cfg.jdReject = Array.from(vals).join(',');
      persistCfg();
      syncJd();
      log(
        cfg.jdReject
          ? '不接受的岗位条件：' + cfg.jdReject + '（JD 里明确要求就跳过）'
          : '已清空「我不能接受」，不按工作条件拦岗位。',
        'dim'
      );
    });

    // 关键词开关
    ui.useInclude.addEventListener('change', () => {
      syncKwHint();
      persistCfg();
      const on = ui.useInclude.checked;
      log(
        on
          ? '必含关键词已启用：职位名 / 公司 / 标签里不含你填的词就跳过。'
          : '必含关键词已关闭：不再按关键词卡岗位（填的词保留，随时可再打开）。',
        on ? 'dim' : 'ok'
      );
    });
    ui.useExclude.addEventListener('change', () => {
      syncKwHint();
      persistCfg();
      log(
        ui.useExclude.checked
          ? '排除关键词已启用。'
          : '排除关键词已关闭：销售 / 外包这类岗位也会投。',
        'dim'
      );
    });

    /* ---- AI 语义判断 ---- */
    ui.aiTitle.addEventListener('click', () => {
      const open = ui.aiBody.style.display !== 'none';
      ui.aiBody.style.display = open ? 'none' : 'block';
      ui.aiTitle.classList.toggle('collapsed', open);
    });

    [
      ui.aiModel, ui.aiBaseUrl, ui.aiApiKey, ui.aiMode,
      ui.aiMinScore, ui.aiTimeout, ui.aiMaxChars, ui.aiExtra
    ].forEach((el) =>
      el.addEventListener('change', () => {
        persistCfg();
        syncAi();
      })
    );
    [ui.aiEnabled, ui.aiSendProfile, ui.aiFailOpen].forEach((el) =>
      el.addEventListener('change', () => {
        persistCfg();
        syncAi();
        if (el === ui.aiEnabled) {
          log(
            cfg.aiEnabled
              ? 'AI 语义判断已开启：点沟通按钮前会把 JD 全文交给模型复核（需要 API Key）。'
              : 'AI 语义判断已关闭：回到原来的规则判断。',
            cfg.aiEnabled ? 'ok' : 'dim'
          );
        }
      })
    );

    // 换服务商时自动填地址和模型；切到「自定义」保留用户已填的内容
    ui.aiProvider.addEventListener('change', () => {
      const p = AI_PROVIDERS.find((x) => x.id === ui.aiProvider.value);
      if (p && p.base) {
        ui.aiBaseUrl.value = p.base;
        ui.aiModel.value = p.model;
      }
      persistCfg();
      syncAi();
      const origin = String(ui.aiBaseUrl.value || '').split('/').slice(0, 3).join('/');
      log(
        'AI 服务商已切到「' + (p ? p.label : '自定义') + '」' +
          (p && p.base ? '，接口 ' + origin : '，请自己填接口地址和模型名') + '。',
        'dim'
      );
    });

    ui.aiTestBtn.addEventListener('click', async () => {
      persistCfg();
      ui.aiTestBtn.disabled = true;
      ui.aiStatus.textContent = '正在连接…';
      ui.aiStatus.style.color = '#6b7686';
      const testCfg = aiPayloadOf({ title: '', company: '', jd: '' }).cfg;
      const res = await aiSend('baa_ai_test', { cfg: testCfg });
      ui.aiTestBtn.disabled = false;
      if (res && res.ok) {
        ui.aiStatus.textContent =
          '✓ 连接成功 · ' + res.model + ' · ' + res.elapsed + 'ms · 回复：' + res.reply;
        ui.aiStatus.style.color = '#00897b';
        log('AI 连接测试通过：' + res.model + '（' + res.elapsed + 'ms）。', 'ok');
      } else {
        const err = res ? (res.error || '未知错误') : '扩展后台没响应，请重新加载扩展后再试';
        ui.aiStatus.textContent = '✗ ' + err;
        ui.aiStatus.style.color = '#c0392b';
        log('AI 连接测试失败：' + err, 'err');
      }
    });

    ui.aiClearCacheBtn.addEventListener('click', async () => {
      const res = await aiSend('baa_ai_clear_cache', {});
      ui.aiStatus.textContent = res && res.ok ? '已清空 AI 判断缓存。' : '清空失败，请重试。';
      ui.aiStatus.style.color = '#6b7686';
    });

    /* ---- 开始投递 ---- */
    ui.sweepBtn.addEventListener('click', () => {
      if (!window.confirm(
        '海投模式会关掉关键词、证书、招聘类型、发布时间、公司筛选和匹配分，能投就投。\n\n' +
        '你手填的期望城市 / 薪资 / 专业 / 编程语言仍然生效。确定吗？'
      )) return;
      applySweep();
    });

    ui.autoBtn.addEventListener('click', () => autoRun());

    /* ---- 开始投递结束 ---- */

    ui.startBtn.addEventListener('click', () => {
      if (st.running) {
        stop();
        log('已手动停止。', 'skip');
      } else {
        run();
      }
    });

    ui.recordsBtn.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'baa_open_records' });
    });

    ui.clearCompanyBtn.addEventListener('click', async () => {
      const n = Object.keys(store.companies || {}).filter((k) => k.indexOf('id:') !== 0).length;
      if (!n) {
        log('还没有已锁定的公司。', 'dim');
        return;
      }
      const go = window.confirm(
        '确定清空 ' + n + ' 家公司的投递锁定？\n\n清空后这些公司会被重新投递（包括已投过的岗位所在公司）。'
      );
      if (!go) return;
      store.companies = {};
      await saveStore();
      log('已清空 ' + n + ' 家公司的去重记录。', 'dim');
      render();
    });

    ui.resetBtn.addEventListener('click', async () => {
      const k = todayKey();
      store.daily[k] = 0;
      st.today = 0;
      await saveStore();
      log('今日计数已重置为 0。', 'dim');
      render();
    });

    document.addEventListener('keydown', (e) => {
      // 只认用户真实按键：插件自己合成的 ESC（用来关 BOSS 弹窗）不能触发紧急停止
      if (e.isTrusted === false) return;
      if (e.key === 'Escape' && st.running) {
        stop();
        log('ESC 紧急停止。', 'err');
      }
    });

    render();
    renderLog();
    syncMajorLang();
  }

  function togglePanel(open) {
    if (!ui) return;
    ui.panel.style.display = open ? 'flex' : 'none';
    ui.fab.style.display = open ? 'none' : 'flex';
  }

  function persistCfg() {
    // 合并而非替换：ack 等不在表单里的字段要保留
    cfg = Object.assign({}, cfg, readCfgFromUI());
    // 手动填了目标岗位或必含词，说明已经不是纯海投了 —— 退出海投模式
    if (
      (cfg.goalJob || '').trim() ||
      (cfg.include || '').trim() ||
      (cfg.skills || '').trim()
    ) cfg.sweepMode = false;
    saveCfg();
    render();
  }

  function readCfgFromUI() {
    if (!ui) return cfg;
    const num = (el, def, min, max) => {
      const v = parseInt(el.value, 10);
      if (isNaN(v)) return def;
      return Math.min(max, Math.max(min, v));
    };
    const numF = (el, def, min, max) => {
      const v = parseFloat(el.value);
      if (!isFinite(v)) return def;
      return Math.min(max, Math.max(min, v));
    };
    return {
      goalJob: ui.goalJob.value.trim(),
      skills: ui.skills.value.trim(),
      years: ui.years.value.trim(),
      edu: ui.edu.value || '本科',
      cities: ui.cities.value.trim(),
      useResume: ui.useResume.checked,
      major: ui.major.value.trim(),
      majorFilter: ui.majorFilter.checked,
      langFilter: ui.langFilter.checked,

      include: ui.inc.value.trim(),
      exclude: ui.exc.value.trim(),
      useInclude: !!(ui.useInclude && ui.useInclude.checked),
      useExclude: !!(ui.useExclude && ui.useExclude.checked),
      minSalary: num(ui.minSalary, 0, 0, 999),
      maxSalary: num(ui.maxSalary, 0, 0, 999),
      minScore: num(ui.minScore, 60, 0, 100),

      dailyLimit: num(ui.dailyLimit, 150, 1, 500),
      gapMin: num(ui.gapMin, 8, 3, 600),
      gapMax: num(ui.gapMax, 15, 3, 600),
      detailWait: numF(ui.detailWait, 3, 0.5, 30),
      scrollWait: numF(ui.scrollWait, 1.4, 0.2, 20),
      detailRetry: num(ui.detailRetry, 2, 1, 5),
      detailClick: ui.detailClick.checked,
      jdScrollWait: num(ui.jdScrollWait, 160, 0, 1500),
      jdScrollSteps: num(ui.jdScrollSteps, 12, 0, 40),
      jdMaxChars: num(ui.jdMaxChars, 12000, 1000, 40000),
      forceOpenDetail: ui.forceOpenDetail.checked,
      strictDetail: ui.strictDetail.checked,
      jdScroll: ui.jdScroll.checked,
      autoScroll: ui.autoScroll.checked,
      onlyNew: ui.onlyNew.checked,
      companyDedup: ui.companyDedup.checked,
      jdScan: ui.jdScan.checked,
      jdBlock: ui.jdBlock.checked,
      strictCity: ui.strictCity.checked,
      companyIdDedup: ui.companyIdDedup.checked,
      fetchDetail: ui.fetchDetail.checked,
      freshFirst: ui.freshFirst.checked,
      dryRun: ui.dryRun.checked,

      aiEnabled: ui.aiEnabled.checked,
      aiProvider: ui.aiProvider.value || 'deepseek',
      aiBaseUrl: ui.aiBaseUrl.value.trim(),
      aiModel: ui.aiModel.value.trim(),
      aiApiKey: ui.aiApiKey.value.trim(),
      aiMode: ui.aiMode.value || 'veto',
      aiMinScore: num(ui.aiMinScore, 60, 0, 100),
      aiTimeout: num(ui.aiTimeout, 20, 3, 120),
      aiMaxChars: num(ui.aiMaxChars, 12000, 2000, 40000),
      aiExtra: ui.aiExtra.value.trim(),
      aiSendProfile: ui.aiSendProfile.checked,
      aiFailOpen: ui.aiFailOpen.checked
    };
  }

  let renderQueued = false;
  /** 当前生效的拦截条件清单 —— "投不出去"时先看这里有几项 */
  function activeFilters() {
    // 海投只跳过「没填的条件」；手动填过的城市 / 薪资仍是硬条件，要在面板上显示出来
    if (cfg.sweepMode) {
      const hard = [];
      if (splitList(cfg.cities).length) hard.push('城市');
      if (cfg.minSalary > 0 || cfg.maxSalary > 0) hard.push('薪资');
      return hard;
    }
    const out = [];
    if (cfg.useInclude && splitList(cfg.include).length) out.push('必含关键词');
    if (cfg.useExclude !== false && splitList(cfg.exclude).length) out.push('排除关键词');
    if (cfg.certFilter) out.push('证书要求');
    if (
      cfg.useResume &&
      typeof cfg.minScore === 'number' &&
      cfg.minScore > 0 &&
      (splitList(cfg.skills).length || (cfg.goalJob || '').trim())
    ) {
      out.push('匹配分 ≥ ' + cfg.minScore);
    }
    if (splitList(cfg.cities).length) out.push('城市');
    if (cfg.minSalary > 0 || cfg.maxSalary > 0) out.push('薪资');
    if (splitList(cfg.companyInclude).length) out.push('公司白名单');
    if (splitList(cfg.companyExclude).length) out.push('公司黑名单');
    if (splitList(cfg.scaleList).length) out.push('公司规模');
    if (splitList(cfg.financeList).length) out.push('融资阶段');
    if (cfg.freshMax > 0) out.push('发布时间');
    if (cfg.onlyNew) out.push('只投未沟通');
    if (cfg.companyDedup) out.push('同公司去重');
    if (cfg.jdScan && cfg.jdBlock) out.push('JD 硬性要求');
    if (String(cfg.major || '').trim() && cfg.majorFilter !== false) out.push('专业硬条件');
    if (splitList(cfg.langOwned).length && cfg.langFilter !== false) out.push('编程语言硬条件');
    if (cfg.aiEnabled && cfg.aiMode !== 'log') out.push('AI 语义判断');
    if (cfg.strictCity !== false && splitList(cfg.cities).length) out.push('地点不确定不投');
    return out;
  }

  function render() {
    if (!ui || renderQueued) return;
    renderQueued = true;
    // 用 setTimeout 而非 rAF：标签页在后台时 rAF 会暂停，导致 UI 卡死
    setTimeout(() => {
      renderQueued = false;
      if (!ui) return;
      syncJd();                                   // 最近一份岗位的硬性要求实时显示
      syncAi();                                   // 最近一次大模型结论实时显示
      syncMajorLang();                           // 专业 / 语言硬条件实时显示
      const todayText = st.today + '/' + cfg.dailyLimit;
      ui.sToday.textContent = todayText;
      ui.sToday.style.fontSize = todayText.length > 4 ? '12.5px' : '';
      ui.sScan.textContent = String(st.scanned);
      ui.sSkip.textContent = String(st.skipped);

      // 跳过原因 Top4：一眼看出为什么一直在跳过
      if (ui.skipBox) {
        const top = topSkips(4);
        if (top.length) {
          ui.skipBox.style.display = 'flex';
          ui.skipBox.innerHTML = top
            .map(
              (x, i) =>
                '<span class="skipitem' + (i === 0 ? ' top' : '') + '">' +
                x.label +
                '<b>' + x.n + '</b></span>'
            )
            .join('');
        } else {
          ui.skipBox.style.display = 'none';
          ui.skipBox.innerHTML = '';
        }
      }

      const locked = Object.keys(store.companies || {}).filter((k) => k.indexOf('id:') !== 0).length;
      if (ui.dedupTag) {
        ui.dedupTag.textContent = locked ? '已锁 ' + locked + ' 家' : '已锁 0 家';
        ui.dedupTag.classList.toggle('warn', locked > 0);
      }

      if (ui.strictTag) {
        const list = activeFilters();
        if (cfg.sweepMode) {
          ui.strictTag.textContent = '海投模式';
          ui.strictTag.title = '全部筛选已跳过，只检查沟通按钮和岗位 / 公司去重';
          ui.strictTag.classList.remove('warn');
        } else {
          ui.strictTag.textContent = list.length ? '生效 ' + list.length + ' 项' : '无拦截';
          ui.strictTag.title = list.length
            ? '当前生效的拦截条件：' + list.join('、')
            : '当前没有任何拦截条件，能投就投';
          ui.strictTag.classList.toggle('warn', list.length >= 5);
        }
      }

      const badge = ui.badge;
      badge.className = 'badge';
      if (st.running) {
        badge.textContent = '运行中';
        badge.classList.add('on');
      } else if (cfg.dryRun) {
        badge.textContent = '演练';
        badge.classList.add('dry');
      } else {
        badge.textContent = '待机';
      }

      if (ui.modeTag) ui.modeTag.textContent = cfg.sweepMode ? '海投模式' : '按当前条件';
      ui.warnBox.style.display = cfg.dryRun ? 'block' : 'none';
      ui.startBtn.textContent = st.running ? '停止' : cfg.dryRun ? '试运行' : '开始投递';
      ui.startBtn.className = 'btn ' + (st.running ? 'btn-danger' : 'btn-primary');
    }, 16);
  }

  function renderLog() {
    if (!ui) return;
    const box = ui.logbox;
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;

    box.innerHTML = st.logs
      .slice(-160)
      .map(
        (l) =>
          '<div class="l"><span class="t">' +
          l.time +
          '</span><span class="' +
          l.type +
          '">' +
          escapeHtml(l.text) +
          '</span></div>'
      )
      .join('');

    if (nearBottom) box.scrollTop = box.scrollHeight;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ------------------------------------------------------------------ *
   * 消息（供 popup 调用）
   * ------------------------------------------------------------------ */
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;
    if (msg.type === 'baa_toggle') {
      if (st.running) {
        stop();
        log('已从弹窗停止。', 'skip');
      } else {
        run();
      }
      sendResponse({ running: st.running });
    } else if (msg.type === 'baa_status') {
      sendResponse({
        running: st.running,
        today: st.today,
        scanned: st.scanned,
        skipped: st.skipped,
        dryRun: cfg.dryRun,
        dailyLimit: cfg.dailyLimit,
        aiEnabled: !!cfg.aiEnabled,
        aiCalls: st.aiCalls || 0
      });
    } else if (msg.type === 'baa_open') {
      togglePanel(true);
      sendResponse({ ok: true });
    }
    return true;
  });

  /* ------------------------------------------------------------------ *
   * 启动
   * ------------------------------------------------------------------ */
  async function init() {
    await loadAll();
    loadPageJobs();                                // 读页面自己已收到的接口明文数据
    if (!document.body) {
      await new Promise((r) => window.addEventListener('DOMContentLoaded', r, { once: true }));
    }

    // 首次进来自动识别校招 / 实习 / 社招频道
    const detected = detectRecruitType();
    if (!cfg.recruitType) cfg.recruitType = detected;

    buildUI();

    if (cfg.recruitType !== detected) {
      const NAME = { social: '社招', campus: '校招', intern: '实习' };
      log(
        '注意：当前页面像「' + NAME[detected] + '」频道，但配置是「' + NAME[cfg.recruitType] +
          '」。要切换请点面板里的招聘类型。',
        'err'
      );
    }
    log('已就绪。默认处于演练模式，先点「试运行」看看会匹配到哪些岗位。', 'ok');

    // SPA 路由切换后，面板可能被 React 移除，做一次守护
    setInterval(() => {
      if (!document.getElementById('baa-host') && document.body) {
        try {
          buildUI();
        } catch (e) {}
      }
    }, 5000);
  }

  init();
})();
