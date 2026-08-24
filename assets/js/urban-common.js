(() => {
  "use strict";

  const translations = {
    zh: {
      "fixed-substrate": "固定城市基底",
      "demo-agents": "演示 Agent",
      "road-segments": "道路路段",
      "time-resolution": "时间分辨率",
      "contact-layers": "接触语义层",
      "boundary-copy": "示意性计算流行病学实验，不是预测、临床工具，也不对应经过校准的具体病原体。",
      "open-sandbox": "打开沙盒 ↗",
      "on-page": "本页目录",
      "toc-overview": "项目概览",
      "toc-architecture": "实现架构",
      "toc-modes": "模型规模",
      "toc-profiles": "传播机制",
      "toc-controls": "操作方式",
      "toc-reading": "结果解读",
      "toc-deployment": "部署边界",
      "not-pathogen": "所有 profile 均未针对具体病原体校准。",
      "arch-city": "城市空间",
      "arch-society": "合成社会",
      "arch-behaviour": "日常行为",
      "arch-contact": "时序接触",
      "arch-dynamics": "疾病动力学",
      "mode-demo-copy": "显示个体、实时移动并快速比较参数，用于讲解与开发。",
      "droplet-name": "近距离呼吸道传播",
      "droplet-copy": "家庭、学校与工作场所中的重复近距离接触占主导。",
      "airborne-name": "共享空气传播",
      "airborne-copy": "拥挤室内、社区和交通混合获得更高权重。",
      "contact-name": "接触媒介传播",
      "contact-copy": "持续性的近距离环境比短暂混合更加重要。",
      "op-one": "加载固定的 10K 城市与 Agent 基底。",
      "op-two": "选择一种通用传播机制。",
      "op-three": "设置 Target R0 与初始病例数量。",
      "op-four": "点击应用并重启。仅改变 R0 不会重新生成城市。",
      "op-five": "使用播放、暂停、单步与时间轴检查传播。",
      "op-six": "分别比较 Target R0、Expected network R0、Realized R 和当前 Rt。",
      "op-seven": "下载当前 run JSON，或上传先前保存的 10K run。",
      "op-eight": "进入传播网络页面，检查 Agent、边的最早时间和不同着色方案。",
      "gloss-target": "用户要求的实验传播强度",
      "gloss-expected": "在当前接触基底上的校准期望",
      "gloss-realized": "已完成病例实际产生的继发病例",
      "gloss-rt": "随时间变化的有效再生数",
      "documentation": "项目文档",
      "browser-preview": "浏览器预览",
      "sandbox-title": "同一座城市，不同的传播动力学。",
      "simulation-time": "模拟时间",
      "transmission-profile": "传播机制",
      "target-r0": "目标 R0",
      "initial-seeds": "初始病例",
      "apply-restart": "应用并重启",
      "city-state": "城市状态",
      "layer-urban": "城市构成",
      "layer-transit": "公共交通",
      "layer-state": "疾病状态",
      "layer-density": "感染密度",
      "layer-flow": "道路流量",
      "map-help": "滚轮缩放 · 拖动平移 · 点击 Agent",
      "timeline-resolution": "每步 15 分钟",
      "run-data": "RUN 数据",
      "upload-run": "上传 run JSON",
      "download-run": "下载当前 run",
      "publish-run": "分享 24 小时",
      "open-network": "传播网络",
      "run-data-ready": "本地 run · 尚未上传",
      "generation-panel": "各传播代感染数",
      "tree-panel": "传播树",
      "tree-help": "点击节点选择对应 Agent",
      "epidemic-summary": "疫情摘要",
      "susceptible": "易感",
      "exposed": "暴露",
      "infectious": "具有传染性",
      "recovered": "康复",
      "expected-r0": "期望网络 R0",
      "realized-r": "已完成病例 Realized R",
      "current-rt": "当前 Rt",
      "affected-blocks": "受影响 blocks",
      "affected-communities": "受影响社区",
      "active-mechanism": "当前传播机制",
      "natural-history": "自然史参数",
      "locked-profile": "标准通用 profile · 已锁定",
      "epidemic-curve": "疫情曲线",
      "layer-contribution": "接触图层实际贡献",
      "sandbox-boundary": "浏览器预览保留界面与定性 regime；科研结论需要服务端接触模拟和随机重复实验。"
      ,"network-lede": "检查谁感染了谁、连接最早何时出现，以及不同节点编码如何改变网络结构的可读性。"
      ,"network-title": "传播网络"
      ,"colour-by": "节点着色依据"
      ,"size-by": "节点大小"
      ,"filter-layer": "接触层"
      ,"find-agent": "查找 Agent"
      ,"select-agent": "选择 Agent"
      ,"reset-view": "重置视图"
      ,"infected-nodes": "感染节点"
      ,"transmission-edges": "传播边"
      ,"generations": "传播代数"
      ,"earliest-event": "最早事件"
      ,"latest-event": "最晚事件"
      ,"network-empty-title": "尚未加载 run"
      ,"network-empty-copy": "上传沙盒导出的 JSON，或打开一个 24 小时共享链接。"
      ,"network-help": "滚轮缩放 · 拖动平移 · 点击节点或边"
      ,"nothing-selected": "尚未选择"
      ,"inspector-prompt": "点击节点查看 Agent 身份和传播历史；点击边查看最早事件。"
      ,"network-local": "本地分析 · JSON 保留在浏览器中"
      ,"network-layout": "网络布局"
    }
  };

  const roots = document.querySelectorAll("[data-urban-page]");
  if (!roots.length) return;

  function applyLanguage(language) {
    const lang = language === "zh" ? "zh" : "en";
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
    document.querySelectorAll("[data-lang]").forEach((panel) => {
      panel.hidden = panel.dataset.lang !== lang;
    });
    document.querySelectorAll("[data-lang-button]").forEach((button) => {
      button.classList.toggle("active", button.dataset.langButton === lang);
    });
    document.querySelectorAll("[data-i18n]").forEach((element) => {
      if (!element.dataset.originalText) element.dataset.originalText = element.textContent;
      const key = element.dataset.i18n;
      element.textContent = lang === "zh" && translations.zh[key]
        ? translations.zh[key]
        : element.dataset.originalText;
    });
    document.querySelectorAll("option[data-label-en]").forEach((option) => {
      option.textContent = lang === "zh" ? option.dataset.labelZh : option.dataset.labelEn;
    });
    try { localStorage.setItem("urban-language", lang); } catch (_) { /* private mode */ }
    window.dispatchEvent(new CustomEvent("urban-language-change", { detail: { language: lang } }));
  }

  document.querySelectorAll("[data-lang-button]").forEach((button) => {
    button.addEventListener("click", () => applyLanguage(button.dataset.langButton));
  });

  let stored = "en";
  try { stored = localStorage.getItem("urban-language") || "en"; } catch (_) { /* private mode */ }
  applyLanguage(stored);
  window.urbanLanguage = () => document.documentElement.lang.startsWith("zh") ? "zh" : "en";
})();
