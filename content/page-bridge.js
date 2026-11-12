/* =========================================================================
 * BOSS 直聘 · 页面数据源桥接（运行在页面自身的 JS 世界）
 * -------------------------------------------------------------------------
 * 只「被动读取」页面自己已经收到的接口响应，不主动发任何请求：
 *   - 拦截 fetch / XMLHttpRequest 里 joblist.json、job/detail.json 的返回值
 *   - 抽出明文薪资、公司全称、公司唯一 ID、城市/区、学历经验标签、JD 摘要
 *   - 通过 sessionStorage（跨世界共享）+ postMessage 交给 content script
 *
 * 这样做的意义：插件不再靠卡片上几个字和正则猜岗位，薪资不用再破解字体，
 * 同公司不同 HR 可以用 encryptBrandId 精确去重，城市也不会再被页面兜底误判。
 * ========================================================================= */
(function () {
  'use strict';
  if (window.__BAA_PAGE_BRIDGE__) return;
  window.__BAA_PAGE_BRIDGE__ = true;

  var KEY = '__baa_page_jobs__';
  var URL_RE = /joblist\.json|job\/detail\.json|search\/joblist|joblist|positionCard/i;

  function slim(j) {
    if (!j || typeof j !== 'object') return null;
    return {
      encryptJobId: j.encryptJobId || j.jobId || j.encryptId || '',
      jobName: j.jobName || j.jobTitle || j.name || '',
      salaryDesc: j.salaryDesc || j.salary || j.salaryDescription || '',
      companyName: j.companyName || j.brandName || j.company || '',
      brandName: j.brandName || '',
      encryptBrandId:
        j.encryptBrandId || j.brandId || j.encryptCompanyId ||
        j.companyId || j.encryptBrandID || '',
      cityName: j.cityName || j.city || '',
      areaDistrict: j.areaDistrict || j.district || '',
      jobArea: j.jobArea || j.area || '',
      businessDistrict: j.businessDistrict || '',
      jobLabels: j.jobLabels || j.jobTags || j.labels || [],
      jobInfo: j.jobInfo || j.jobDescription || j.description || '',
      jobDegree: j.jobDegree || j.degree || j.education || '',
      jobExperience: j.jobExperience || j.experience || j.workYear || '',
      securityId: j.securityId || '',
      lid: j.lid || ''
    };
  }

  function put(list) {
    try {
      var map = {};
      try { map = JSON.parse(sessionStorage.getItem(KEY) || '{}') || {}; } catch (e) {}
      var added = [];
      (list || []).forEach(function (raw) {
        var j = slim(raw);
        if (!j) return;
        var id = j.encryptJobId || j.jobName + '|' + j.companyName;
        if (!id) return;
        map[id] = Object.assign({}, map[id] || {}, j);
        added.push(j);
      });
      if (!added.length) return;
      // sessionStorage 同源跨世界共享：content script 即使晚加载也能拿到最早一批数据
      try { sessionStorage.setItem(KEY, JSON.stringify(map)); } catch (e) {}
      window.postMessage({ __baa: 1, kind: 'jobs', jobs: added }, '*');
    } catch (e) {}
  }

  function harvest(data) {
    if (!data || typeof data !== 'object') return;
    var roots = [data];
    if (data.data && typeof data.data === 'object') roots.push(data.data);
    if (data.zpData && typeof data.zpData === 'object') roots.push(data.zpData);
    var out = [];
    roots.forEach(function (r) {
      var list = r.jobList || r.list || r.jobs || r.positions;
      if (Array.isArray(list)) out = out.concat(list);
      // 详情接口：data.jobInfo 里就是岗位对象
      if (r.jobInfo && typeof r.jobInfo === 'object') out.push(r.jobInfo);
      if (r.job && typeof r.job === 'object') out.push(r.job);
    });
    // 去重后写入，避免同一批被多个 root 收两次
    var seen = {};
    out = out.filter(function (j) {
      var k = (j && (j.encryptJobId || j.jobName)) || Math.random();
      if (seen[k]) return false;
      seen[k] = 1;
      return true;
    });
    if (out.length) put(out);
  }

  /* ---- fetch ---- */
  var originFetch = window.fetch;
  if (typeof originFetch === 'function') {
    window.fetch = function () {
      var res = originFetch.apply(this, arguments);
      try {
        var arg = arguments[0];
        var url = String((arg && arg.url) || arg || '');
        if (URL_RE.test(url)) {
          res.then(function (r) {
            try {
              r.clone().json().then(function (d) { harvest(d); })['catch'](function () {});
            } catch (e) {}
          })['catch'](function () {});
        }
      } catch (e) {}
      return res;
    };
  }

  /* ---- XMLHttpRequest ---- */
  try {
    var originOpen = XMLHttpRequest.prototype.open;
    var originSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function () {
      try { this.__baa_url = String(arguments[1] || ''); } catch (e) {}
      return originOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      var self = this;
      try {
        if (URL_RE.test(this.__baa_url || '')) {
          this.addEventListener('load', function () {
            try { harvest(JSON.parse(self.responseText)); } catch (e) {}
          });
        }
      } catch (e) {}
      return originSend.apply(this, arguments);
    };
  } catch (e) {}
})();
