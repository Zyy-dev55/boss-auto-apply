/* =========================================================================
 * BOSS 直聘 · AI 语义判断核心（纯函数，不依赖 chrome.*，可在 Node 里单测）
 * -------------------------------------------------------------------------
 * 职责：把「JD 全文 + 结构化条件档案」组织成提示词，解析大模型返回的结构化
 * 结论，并按用户选的模式给出「拦 / 不拦」。
 * 1.11.0 起不再读取 / 发送简历原文，档案只由用户手填的条件构成。
 *
 * 设计底线（这是吸取了前几轮「一个也投不了」的教训）：
 *   1. 只有模型给出「明确硬性门槛 + 原文证据」时才拦，绝不因主观印象杀岗位；
 *   2. 候选人档案里没写的，一律不能推断为「不具备」；
 *   3. 解析失败 / 超时 / 未配置 → 由调用方按「失败放行」退回原规则，绝不阻断海投。
 * ========================================================================= */
(function () {
  'use strict';

  /** 常见 OpenAI 兼容服务商预设。用户也可选 custom 自己填地址。 */
  var AI_PRESETS = [
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

  var SYSTEM_PROMPT = [
    '你是一个严谨的求职筛选助手。你的任务是阅读岗位 JD 全文，判断这个岗位对候选人是否存在「无法满足的硬性门槛」，并评估匹配度。',
    '',
    '判定规则（必须严格遵守）：',
    '1. 硬性门槛只包括 JD 中用「必须 / 要求 / 需 / 至少 / 仅限 / 须 / 不接受」等明确措辞写出，且候选人明确无法满足的条件：学历、工作年限、证书 / 资格证、专业限制、年龄、户籍、驾照、驻场 / 长期出差 / 倒班 / 单休、语言等级等。',
    '2. 出现「优先 / 加分 / 更佳 / 最好 / 有则 / 择优 / 欢迎 / 不限 / 不作要求 / 可接受应届生」等软化措辞的，一律不算硬性门槛。',
    '3. 「岗位职责」里描述的工作内容不是门槛；只有「任职要求 / 任职资格」这类明确条件才算。',
    '4. 候选人档案里没有写某项信息（例如没写证书、没写实习经历），代表信息缺失，绝不能推断成「不具备」。信息不足时倾向放行。',
    '5. 「我的专业」写成「未填」、「我会的编程语言」写成「未勾」，代表用户主动不设这项限制，此时 JD 里任何专业 / 语言要求都不构成 hard_block；只有用户明确填了专业 / 勾了语言，才按档案里写的值比对。',
    '6. 只有当你能在 JD 里找到明确证据、并且候选人档案里明确写了与之冲突的信息时，才允许把 hard_block 设为 true。不确定就设 false。',
    '7. hard_reasons 里必须引用 JD 原文短语（每条不超过 40 字），并说明候选人哪里不满足；没有证据就留空数组。',
    '8. score 是 0-100 的匹配度整数，fit 表示是否建议投递（综合岗位方向与候选人背景）。',
    '',
    '只输出一个 JSON 对象，不要 markdown、不要代码块、不要任何解释文字。字段固定为：',
    '{"fit": true, "score": 78, "hard_block": false, "hard_reasons": [], "reasons": ["理由1", "理由2"], "summary": "一句话结论"}',
    'reasons 最多 3 条，每条不超过 40 字；summary 不超过 60 字。所有文字用简体中文。'
  ].join('\n');

  function presetById(id) {
    for (var i = 0; i < AI_PRESETS.length; i++) {
      if (AI_PRESETS[i].id === id) return AI_PRESETS[i];
    }
    return null;
  }

  function clamp(v, def, min, max) {
    var n = Number(v);
    if (!isFinite(n)) return def;
    return Math.min(max, Math.max(min, n));
  }

  /** 去掉条件文本里可能混进的手机号 / 邮箱 / 证件号 / 链接，避免外发敏感信息 */
  function scrubPii(s) {
    return String(s == null ? '' : s)
      .replace(/1[3-9]\d{9}/g, '[手机号]')
      .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[邮箱]')
      .replace(/\d{17}[\dXx]/g, '[证件号]')
      .replace(/https?:\/\/\S+/g, '[链接]');
  }

  /** FNV-1a 32 位，附加长度降低碰撞概率 */
  function hashStr(s) {
    var str = String(s || '');
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) {
      h = Math.imul(h ^ str.charCodeAt(i), 16777619) >>> 0;
    }
    return (h >>> 0).toString(16) + '-' + str.length.toString(36);
  }

  /** 把用户填的 base 补成完整的 chat/completions 地址 */
  function resolveEndpoint(cfg) {
    cfg = cfg || {};
    var p = presetById(cfg.aiProvider);
    var base = String(cfg.aiBaseUrl || '').trim().replace(/\/+$/, '');
    if (!base && p && p.base) base = p.base;
    if (!base) {
      return { ok: false, error: '请填接口地址（例如 https://api.deepseek.com/v1）' };
    }
    if (!/^https:\/\//i.test(base)) {
      return { ok: false, error: '接口地址必须用 https:// 开头' };
    }
    var url;
    try {
      url = new URL(base);
    } catch (e) {
      return { ok: false, error: '接口地址不是合法 URL' };
    }
    var path = String(url.pathname || '/').replace(/\/+$/, '');
    if (!/chat\/completions$/i.test(path)) path += '/chat/completions';
    url.pathname = path;
    url.search = '';
    url.hash = '';

    var model = String(cfg.aiModel || '').trim() || (p && p.model) || '';
    if (!model) return { ok: false, error: '请填模型名（例如 deepseek-chat）' };
    var key = String(cfg.aiApiKey || '').trim();
    if (!key) return { ok: false, error: '请填 API Key' };

    return {
      ok: true,
      url: url.toString(),
      origin: url.origin,
      model: model,
      key: key,
      provider: (p && p.id) || 'custom'
    };
  }

  /** JD 全文裁剪：默认 12000 字足够覆盖绝大多数 JD；真超长时保留开头 +
   *  「任职要求」段（硬性要求几乎都在后半段），别只截前半段把要求丢了。 */
  function clipJd(text, max) {
    var s = String(text == null ? '' : text)
      .replace(/\r/g, '')
      .replace(/[ \t]+/g, ' ')
      .trim();
    var limit = Math.floor(clamp(max, 12000, 2000, 40000));
    if (s.length <= limit) return s;

    var headLen = Math.floor(limit * 0.4);
    var head = s.slice(0, headLen);
    var mark = s.search(/(任职要求|岗位要求|职位要求|任职资格|应聘条件|我们需要你|岗位要求)/);
    var tailLen = limit - headLen - 24;
    var tailFrom = mark > headLen ? Math.max(headLen, mark - 100) : s.length - tailLen;
    if (tailFrom + tailLen > s.length) tailFrom = Math.max(headLen, s.length - tailLen);
    return head + '\n…（中间部分略）…\n' + s.slice(tailFrom, tailFrom + tailLen);
  }

  /** 结构化条件档案：只由用户手填 / 勾选的条件组成，不含简历原文（1.11.0） */
  function buildProfile(cfg) {
    cfg = cfg || {};
    var typeName = { social: '社招', campus: '校招', intern: '实习' }[cfg.recruitType] || '自动识别';
    var major = scrubPii(String(cfg.major || '').slice(0, 200));
    var langs = scrubPii(String(cfg.langOwned || '').slice(0, 300));
    var extraOn = cfg.aiSendProfile !== false;
    var p = {
      我的专业: major || '（未填，不设专业限制）',
      我会的编程语言: langs || '（未勾，不设语言限制）',
      专业是硬条件: cfg.majorFilter !== false && !!major,
      编程语言是硬条件: cfg.langFilter !== false && !!langs,
      最高学历: scrubPii(String(cfg.edu || '')) || '',
      工作年限: scrubPii(String(cfg.years || '')) || '',
      持有证书: scrubPii(String(cfg.certOwned || '')) || '',
      期望城市: scrubPii(String(cfg.cities || '')) || '',
      可接受薪资下限K: Number(cfg.minSalary) || 0,
      可接受薪资上限K: Number(cfg.maxSalary) || 0,
      不接受的工作条件: scrubPii(String(cfg.jdReject || '')) || '',
      招聘类型: typeName
    };
    if (extraOn) {
      p.目标岗位 = scrubPii(String(cfg.goalJob || '').slice(0, 200));
      p.技能标签 = scrubPii(String(cfg.skills || '').slice(0, 400));
    }
    return p;
  }

  /** 组装 system / user 两条消息。JD 全文放在 user 里，不做正则预处理。 */
  function buildAiMessages(payload) {
    payload = payload || {};
    var cfg = payload.cfg || {};
    var info = payload.info || {};
    var jd = clipJd(info.jd, cfg.aiMaxChars);

    var meta = [
      '职位：' + (info.title || '未知'),
      '公司：' + (info.company || '未知'),
      '薪资：' + (info.salary || '未标注'),
      '地点：' + (info.area || info.apiArea || '未标注'),
      '标签：' + ((info.tags || []).join(' / ') || '无'),
      '规则引擎已识别的要求：' + (info.reqSummary || '无')
    ].join('\n');

    var extra = String(cfg.aiExtra || '').trim();
    var user = [
      '【岗位元信息】',
      meta,
      '【岗位 JD 全文】',
      jd,
      '【候选人档案】',
      JSON.stringify(buildProfile(cfg), null, 2)
    ];
    if (extra) user.push('【我的补充要求（也要纳入判断）】', extra.slice(0, 600));
    user.push('请按系统提示，只输出 JSON。');

    return { system: SYSTEM_PROMPT, user: user.join('\n\n'), jdChars: jd.length };
  }

  /** 模型偶尔会裹 markdown、加解释文字或多写逗号，这里做容错提取 */
  function parseAiResponse(text) {
    var s = String(text == null ? '' : text).trim();
    if (!s) return null;
    var fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) s = fence[1].trim();
    var a = s.indexOf('{');
    var b = s.lastIndexOf('}');
    if (a < 0 || b <= a) return null;
    var body = s.slice(a, b + 1).replace(/,\s*([}\]])/g, '$1');
    try {
      var o = JSON.parse(body);
      return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
    } catch (e) {
      return null;
    }
  }

  function asBool(v, def) {
    if (v === true || v === 1 || v === 'true' || v === '是') return true;
    if (v === false || v === 0 || v === 'false' || v === '否') return false;
    return def;
  }

  function asList(v) {
    var arr;
    if (Array.isArray(v)) arr = v;
    else if (typeof v === 'string' && v.trim()) arr = v.split(/[；;\n]+/);
    else return [];
    return arr
      .map(function (x) { return String(x == null ? '' : x).trim().slice(0, 80); })
      .filter(Boolean)
      .slice(0, 4);
  }

  /** 归一化模型输出。没有证据的 hard_block 一律不认。 */
  function normalizeAiVerdict(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var score = Number(raw.score);
    if (!isFinite(score)) score = 50;
    score = Math.max(0, Math.min(100, Math.round(score)));

    var hardReasons = asList(raw.hard_reasons != null ? raw.hard_reasons : raw.hardReasons);
    var hardBlock = asBool(
      raw.hard_block != null ? raw.hard_block : raw.hardBlock,
      false
    );
    if (hardBlock && !hardReasons.length) hardBlock = false;

    var fit = asBool(raw.fit, !hardBlock);
    return {
      fit: fit,
      score: score,
      hardBlock: hardBlock,
      hardReasons: hardReasons,
      reasons: asList(raw.reasons),
      summary:
        String(raw.summary || '').trim().slice(0, 120) ||
        (hardBlock ? '存在硬性不符' : '未发现硬性不符')
    };
  }

  /** 按用户选的模式决定是否拦下这个岗位 */
  function aiDecision(v, cfg) {
    cfg = cfg || {};
    if (!v) return { block: false, degraded: true, why: '模型返回无法解析' };
    var mode = cfg.aiMode || 'veto';
    if (mode === 'log') return { block: false, code: null, why: 'AI 只记录不拦截' };
    if (v.hardBlock) {
      return {
        block: true,
        code: 'ai_hard',
        why: 'AI 判定硬性不符：' + v.hardReasons.slice(0, 2).join('；')
      };
    }
    if (mode === 'score') {
      var threshold = clamp(cfg.aiMinScore, 60, 0, 100);
      if (v.score < threshold) {
        return {
          block: true,
          code: 'ai_score',
          why: 'AI 匹配分 ' + v.score + ' < 阈值 ' + threshold
        };
      }
    }
    return { block: false, code: null, why: '' };
  }

  /** 同一份 JD + 同一套条件只调用一次模型，省时省钱 */
  function aiCacheKey(payload) {
    payload = payload || {};
    var cfg = payload.cfg || {};
    var info = payload.info || {};
    var extraOn = cfg.aiSendProfile !== false;
    var parts = [
      cfg.aiProvider || '', cfg.aiModel || '', cfg.aiMode || '',
      cfg.aiMinScore || 0, cfg.aiExtra || '', cfg.aiMaxChars || 0,
      extraOn ? (cfg.goalJob || '') : '', cfg.edu || '', cfg.years || '',
      extraOn ? (cfg.skills || '') : '',
      cfg.certOwned || '', cfg.jdReject || '', cfg.cities || '',
      cfg.recruitType || '', cfg.minSalary || 0, cfg.maxSalary || 0,
      cfg.major || '', cfg.majorFilter !== false,
      cfg.langOwned || '', cfg.langFilter !== false,
      extraOn ? 'extra' : 'noextra',
      info.title || '', info.company || '', String(info.jd || '')
    ];
    return hashStr(parts.join('\u0001'));
  }

  var API = {
    AI_PRESETS: AI_PRESETS,
    SYSTEM_PROMPT: SYSTEM_PROMPT,
    presetById: presetById,
    resolveEndpoint: resolveEndpoint,
    clipJd: clipJd,
    buildProfile: buildProfile,
    buildAiMessages: buildAiMessages,
    parseAiResponse: parseAiResponse,
    normalizeAiVerdict: normalizeAiVerdict,
    aiDecision: aiDecision,
    aiCacheKey: aiCacheKey,
    scrubPii: scrubPii,
    hashStr: hashStr
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (typeof globalThis !== 'undefined') globalThis.BaaAi = API;
})();
