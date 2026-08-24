(() => {
  "use strict";

  const root = document.querySelector("[data-network-root]");
  if (!root) return;
  const ids = ["network-run-upload", "network-layout", "network-colour", "network-size", "network-layer", "network-search", "network-find", "network-reset-view", "network-canvas", "network-force", "network-empty", "network-legend", "network-inspector-title", "network-inspector-content", "network-node-count", "network-edge-count", "network-generation-count", "network-earliest", "network-latest", "network-status", "network-download"];
  const ui = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
  const OCCUPATIONS = ["Student", "Office / professional", "Education", "Healthcare", "Retail / service", "Manufacturing", "Logistics / transport", "Construction", "Public administration", "Hospitality", "Unemployed", "Retired"];
  const OCCUPATIONS_ZH = ["学生", "办公室 / 专业人员", "教育", "医疗", "零售 / 服务", "制造业", "物流 / 交通", "建筑", "公共管理", "餐旅服务", "未就业", "退休"];
  const MOBILITY = ["Walk", "Public transport", "Private vehicle"];
  const MOBILITY_ZH = ["步行", "公共交通", "私家车"];
  const LAYERS = ["Household", "School", "Workplace", "Community", "Transport", "Healthcare", "Transient"];
  const LAYERS_ZH = ["家庭", "学校", "工作场所", "社区", "交通", "医疗", "短暂接触"];
  const STATE = ["S", "E", "I", "R"];
  const STATE_COLORS = ["#657480", "#f2bd53", "#ff5d55", "#61cf8d"];
  const viewport = { scale: 1, x: 0, y: 0 };
  let run = null;
  let nodes = [];
  let nodeById = new Map();
  let edges = [];
  let selectedNode = null;
  let selectedEdge = null;
  let pointer = null;
  let forceGraph = null;
  let forceFitPending = false;
  let forceFitTimer = null;
  let forceResizeTimer = null;
  const forceTuning = { nodeScale: 1, edgeScale: 1, arrowLength: 3, padding: 55 };

  function language() { return window.urbanLanguage ? window.urbanLanguage() : "en"; }
  function updateControlLabels() {
    const zh = language() === "zh";
    const colour = zh ? ["传播代", "职业", "年龄组", "社区", "疾病状态"] : ["Generation", "Occupation", "Age group", "Community", "Disease state"];
    const size = zh ? ["继发感染数", "度", "统一大小"] : ["Secondary infections", "Degree", "Uniform"];
    const layer = [zh ? "全部真实传播层" : "All realized layers", ...(zh ? LAYERS_ZH : LAYERS)];
    const layout = zh ? ["按传播代分层", "力导向网状结构"] : ["Transmission generations", "Force-directed mesh"];
    [...ui["network-layout"].options].forEach((option, index) => { option.textContent = layout[index]; });
    [...ui["network-colour"].options].forEach((option, index) => { option.textContent = colour[index]; });
    [...ui["network-size"].options].forEach((option, index) => { option.textContent = size[index]; });
    [...ui["network-layer"].options].forEach((option, index) => { option.textContent = layer[index]; });
  }
  function resizeCanvas() {
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const rect = ui["network-canvas"].getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width * ratio));
    const height = Math.max(1, Math.round(rect.height * ratio));
    if (ui["network-canvas"].width !== width || ui["network-canvas"].height !== height) { ui["network-canvas"].width = width; ui["network-canvas"].height = height; }
    return { width, height, ratio };
  }
  function formatTime(step) {
    if (step === null || step === undefined || step < 0) return "—";
    const minutes = Number(step) * 15;
    return `D${String(Math.floor(minutes / 1440) + 1).padStart(2, "0")} ${String(Math.floor((minutes % 1440) / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  }
  function ageGroup(age) {
    if (age < 18) return "0–17";
    if (age < 35) return "18–34";
    if (age < 50) return "35–49";
    if (age < 65) return "50–64";
    return "65+";
  }
  function hashHue(value) { return (Number(value) * 47 + 174) % 360; }
  function metadataValue(key, id, fallback = null) {
    const values = run && run.agent_metadata && run.agent_metadata[key];
    return values && id < values.length ? values[id] : fallback;
  }
  function occupationValue(id) {
    const detailed = metadataValue("occupation_detail", id, null);
    return detailed === null || detailed === undefined ? metadataValue("occupation", id, 0) : detailed;
  }

  function buildGraph(documentData) {
    if (!documentData || documentData.schema !== "synthetic-city-epidemic-run-v1") throw new Error("Unsupported run JSON schema");
    run = documentData;
    const stateData = run.agent_state || {};
    const nodeIds = new Set();
    (run.transmissions || []).forEach((event) => { nodeIds.add(Number(event.source)); nodeIds.add(Number(event.target)); });
    (stateData.generation || []).forEach((generation, id) => { if (generation >= 0) nodeIds.add(id); });
    nodes = [...nodeIds].sort((a, b) => a - b).map((id) => ({
      id,
      generation: stateData.generation ? stateData.generation[id] : 0,
      state: stateData.state ? stateData.state[id] : 3,
      source: stateData.source ? stateData.source[id] : -1,
      infectedAt: stateData.infected_at ? stateData.infected_at[id] : -1,
      secondary: stateData.secondary ? stateData.secondary[id] : 0,
      degree: 0,
      x: 0,
      y: 0
    }));
    nodeById = new Map(nodes.map((node) => [node.id, node]));
    const edgeMap = new Map();
    (run.transmissions || []).forEach((event) => {
      const key = `${event.source}:${event.target}`;
      if (!edgeMap.has(key)) edgeMap.set(key, { source: Number(event.source), target: Number(event.target), earliest: Number(event.time), latest: Number(event.time), count: 0, layers: new Set() });
      const edge = edgeMap.get(key);
      edge.earliest = Math.min(edge.earliest, Number(event.time));
      edge.latest = Math.max(edge.latest, Number(event.time));
      edge.count += 1;
      edge.layers.add(Number(event.layer));
    });
    edges = [...edgeMap.values()].map((edge) => ({ ...edge, layers: [...edge.layers].sort() }));
    edges.forEach((edge) => { if (nodeById.has(edge.source)) nodeById.get(edge.source).degree += 1; if (nodeById.has(edge.target)) nodeById.get(edge.target).degree += 1; });
    const groups = new Map();
    nodes.forEach((node) => { if (!groups.has(node.generation)) groups.set(node.generation, []); groups.get(node.generation).push(node); });
    const generations = [...groups.keys()].sort((a, b) => a - b);
    generations.forEach((generation, generationIndex) => {
      const group = groups.get(generation).sort((a, b) => a.id - b.id);
      group.forEach((node, index) => {
        node.x = .07 + generationIndex / Math.max(1, generations.length - 1) * .86;
        node.y = .04 + (index + 1) / (group.length + 1) * .92;
      });
    });
    selectedNode = null; selectedEdge = null;
    viewport.scale = 1; viewport.x = 0; viewport.y = 0;
    ui["network-empty"].hidden = true;
    ui["network-download"].disabled = false;
    updateSummary(); updateInspector();
    if (ui["network-layout"].value === "force") updateForceData(true);
    else draw();
  }

  function filteredEdges() {
    const layer = ui["network-layer"].value;
    return layer === "all" ? edges : edges.filter((edge) => edge.layers.includes(Number(layer)));
  }
  function nodeColour(node) {
    const scheme = ui["network-colour"].value;
    if (scheme === "state") return STATE_COLORS[node.state] || STATE_COLORS[0];
    if (scheme === "generation") return `hsl(${hashHue(node.generation)} 72% 58%)`;
    if (scheme === "occupation") return `hsl(${hashHue(occupationValue(node.id))} 62% 57%)`;
    if (scheme === "community") return `hsl(${hashHue(metadataValue("community", node.id, 0))} 66% 56%)`;
    const groupIndex = ["0–17", "18–34", "35–49", "50–64", "65+"].indexOf(ageGroup(metadataValue("age", node.id, 0)));
    return `hsl(${[202, 168, 48, 18, 295][groupIndex]} 67% 58%)`;
  }
  function nodeRadius(node) {
    const scheme = ui["network-size"].value;
    const value = scheme === "secondary" ? node.secondary : scheme === "degree" ? node.degree : 0;
    return Math.min(11, 2.6 + Math.sqrt(Math.max(0, value)) * 1.45);
  }
  function screenPoint(node, width, height) {
    const margin = Math.min(width, height) * .06;
    return { x: margin + node.x * (width - margin * 2), y: margin + node.y * (height - margin * 2) };
  }

  function visibleNodeIds() {
    const ids = new Set();
    filteredEdges().forEach((edge) => { ids.add(edge.source); ids.add(edge.target); });
    nodes.filter((node) => node.generation === 0).forEach((node) => ids.add(node.id));
    return ids;
  }
  function forceNodeLabel(node) {
    const zh = language() === "zh";
    const occupation = occupationValue(node.id);
    return `Agent ${node.id}\n${zh ? "传播代" : "Generation"}: ${node.generation}\n${zh ? "职业" : "Occupation"}: ${(zh ? OCCUPATIONS_ZH : OCCUPATIONS)[occupation] || occupation}`;
  }
  function forceLinkHighlighted(link) {
    const edge = link._edge;
    return selectedEdge === edge || (selectedNode && edge && (edge.source === selectedNode.id || edge.target === selectedNode.id));
  }
  function forceNodeDisplayRadius(node) { return Math.max(.75, nodeRadius(node) * forceTuning.nodeScale); }
  function forceNodeValue(node) { return Math.max(.04, (forceNodeDisplayRadius(node) / 3.8) ** 2); }
  function forceLinkWidth(link) { return forceLinkHighlighted(link) ? 2.4 : Math.max(.22, .8 * forceTuning.edgeScale); }
  function calculateForceTuning(nodeCount, width, height) {
    const count = Math.max(1, nodeCount);
    const spacing = Math.sqrt(Math.max(1, width * height) / count);
    forceTuning.nodeScale = Math.max(.28, Math.min(1.45, spacing / 45));
    forceTuning.edgeScale = Math.max(.24, Math.min(1, spacing / 42));
    forceTuning.arrowLength = count > 1200 ? 0 : count > 450 ? 1.5 : 3;
    forceTuning.padding = Math.max(28, Math.min(70, Math.min(width, height) * .07));
    return {
      charge: -Math.max(18, Math.min(160, spacing * 1.65)),
      linkDistance: Math.max(12, Math.min(66, spacing * 1.2)),
      distanceMax: Math.max(180, Math.min(950, Math.max(width, height) * .72)),
      cooldownTicks: count > 2500 ? 280 : count > 800 ? 210 : 140
    };
  }
  function fitForceGraph(duration = 500) {
    if (!forceGraph || !forceGraph.graphData().nodes.length || ui["network-layout"].value !== "force") return;
    forceGraph.zoomToFit(duration, forceTuning.padding);
  }
  function scheduleForceFit(delay = 350) {
    clearTimeout(forceFitTimer);
    forceFitTimer = setTimeout(() => fitForceGraph(450), delay);
  }
  function tuneForceGraph(reheat = false) {
    if (!forceGraph) return;
    const rect = ui["network-force"].getBoundingClientRect();
    const count = forceGraph.graphData().nodes.length;
    const tuning = calculateForceTuning(count, Math.max(1, rect.width), Math.max(1, rect.height));
    forceGraph
      .nodeVal(forceNodeValue)
      .linkWidth(forceLinkWidth)
      .linkDirectionalArrowLength(forceTuning.arrowLength)
      .cooldownTicks(tuning.cooldownTicks);
    forceGraph.d3Force("charge")?.strength(tuning.charge).distanceMin(4).distanceMax(tuning.distanceMax);
    forceGraph.d3Force("link")?.distance(tuning.linkDistance).strength(count > 1200 ? .32 : .5);
    if (typeof forceGraph.d3AlphaDecay === "function") forceGraph.d3AlphaDecay(count > 1200 ? .022 : .028);
    if (typeof forceGraph.d3VelocityDecay === "function") forceGraph.d3VelocityDecay(.34);
    if (reheat) forceGraph.d3ReheatSimulation();
  }
  function adaptForceToCanvas() {
    if (!forceGraph || ui["network-layout"].value !== "force") return;
    sizeForceGraph();
    tuneForceGraph(true);
    refreshForceStyles();
    forceFitPending = true;
    scheduleForceFit(500);
  }
  function ensureForceGraph() {
    if (forceGraph) return true;
    if (typeof ForceGraph !== "function") return false;
    forceGraph = ForceGraph()(ui["network-force"])
      .backgroundColor("#091016")
      .nodeId("id")
      .nodeLabel(forceNodeLabel)
      .nodeColor(nodeColour)
      .nodeVal(forceNodeValue)
      .nodeRelSize(3.8)
      .linkColor((link) => forceLinkHighlighted(link) ? "rgba(255,226,57,.9)" : "rgba(122,148,164,.24)")
      .linkWidth(forceLinkWidth)
      .linkDirectionalArrowLength(forceTuning.arrowLength)
      .linkDirectionalArrowRelPos(1)
      .linkDirectionalParticles((link) => forceLinkHighlighted(link) ? 1 : 0)
      .linkDirectionalParticleWidth(1.4)
      .enableNodeDrag(true)
      .minZoom(.15)
      .maxZoom(18)
      .cooldownTicks(130)
      .nodeCanvasObjectMode(() => "after")
      .nodeCanvasObject((node, ctx, globalScale) => {
        if (!selectedNode || node.id !== selectedNode.id) return;
        ctx.beginPath();
        ctx.arc(node.x, node.y, forceNodeDisplayRadius(node) + 5 / globalScale, 0, Math.PI * 2);
        ctx.strokeStyle = "#ffe239";
        ctx.lineWidth = 2 / globalScale;
        ctx.stroke();
      })
      .onNodeClick((node) => selectAgent(node.id, false))
      .onLinkClick((link) => {
        selectedNode = null;
        selectedEdge = link._edge;
        updateInspector();
        refreshForceStyles();
      })
      .onEngineStop(() => {
        if (!forceFitPending) return;
        forceFitPending = false;
        fitForceGraph(650);
      });
    return true;
  }
  function sizeForceGraph() {
    if (!forceGraph) return { width: 0, height: 0 };
    const rect = ui["network-force"].getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    forceGraph.width(width).height(height);
    return { width, height };
  }
  function refreshForceStyles() {
    if (!forceGraph) return;
    forceGraph
      .nodeColor(nodeColour)
      .nodeVal(forceNodeValue)
      .nodeLabel(forceNodeLabel)
      .linkColor((link) => forceLinkHighlighted(link) ? "rgba(255,226,57,.9)" : "rgba(122,148,164,.24)")
      .linkWidth(forceLinkWidth)
      .linkDirectionalArrowLength(forceTuning.arrowLength);
  }
  function forceInitialNode(node, index, count, width, height) {
    const spacing = Math.max(6, Math.min(24, Math.sqrt(Math.max(1, width * height) / Math.max(1, count)) * .65));
    const angle = (index + 1) * 2.399963229728653 + (node.generation % 7) * .07;
    const radius = spacing * Math.sqrt(index + 1);
    return { ...node, x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, vx: 0, vy: 0 };
  }
  function updateForceData(fit = false) {
    if (!ensureForceGraph()) {
      ui["network-layout"].value = "generation";
      ui["network-status"].textContent = language() === "zh" ? "力导向组件加载失败，已回到传播代视图" : "Force layout failed to load; showing the generation view";
      draw();
      return;
    }
    const dimensions = sizeForceGraph();
    const visible = visibleNodeIds();
    const visibleNodes = nodes.filter((node) => visible.has(node.id));
    const graphNodes = visibleNodes.map((node, index) => forceInitialNode(node, index, visibleNodes.length, dimensions.width, dimensions.height));
    const graphLinks = filteredEdges().map((edge) => ({ source: edge.source, target: edge.target, _edge: edge }));
    forceGraph.graphData({ nodes: graphNodes, links: graphLinks });
    tuneForceGraph(true);
    refreshForceStyles();
    if (fit && graphNodes.length) {
      forceFitPending = true;
      scheduleForceFit(graphNodes.length > 800 ? 800 : 350);
    }
  }

  function draw() {
    const forceMode = ui["network-layout"].value === "force";
    ui["network-canvas"].hidden = forceMode;
    ui["network-force"].hidden = !forceMode;
    if (forceMode) {
      drawLegend();
      if (run && (!forceGraph || !forceGraph.graphData().nodes.length)) updateForceData(true);
      else { sizeForceGraph(); refreshForceStyles(); }
      return;
    }
    const { width, height } = resizeCanvas();
    const ctx = ui["network-canvas"].getContext("2d");
    ctx.clearRect(0, 0, width, height); ctx.fillStyle = "#091016"; ctx.fillRect(0, 0, width, height);
    if (!run) return;
    const visibleEdges = filteredEdges();
    const visibleNodes = visibleNodeIds();
    ctx.save(); ctx.translate(viewport.x, viewport.y); ctx.scale(viewport.scale, viewport.scale);
    ctx.lineWidth = .75 / viewport.scale;
    visibleEdges.forEach((edge) => {
      const source = screenPoint(nodeById.get(edge.source), width, height); const target = screenPoint(nodeById.get(edge.target), width, height);
      const highlighted = selectedEdge === edge || (selectedNode && (edge.source === selectedNode.id || edge.target === selectedNode.id));
      ctx.strokeStyle = highlighted ? "rgba(255,226,57,.86)" : "rgba(122,148,164,.20)";
      ctx.lineWidth = (highlighted ? 2.2 : .75) / viewport.scale;
      ctx.beginPath(); ctx.moveTo(source.x, source.y); ctx.lineTo(target.x, target.y); ctx.stroke();
    });
    nodes.forEach((node) => {
      if (!visibleNodes.has(node.id)) return;
      const point = screenPoint(node, width, height); const radius = nodeRadius(node) / viewport.scale;
      ctx.fillStyle = nodeColour(node); ctx.beginPath(); ctx.arc(point.x, point.y, radius, 0, Math.PI * 2); ctx.fill();
      if (selectedNode === node) { ctx.strokeStyle = "#ffe239"; ctx.lineWidth = 2 / viewport.scale; ctx.beginPath(); ctx.arc(point.x, point.y, radius + 5 / viewport.scale, 0, Math.PI * 2); ctx.stroke(); }
    });
    ctx.restore();
    drawLegend();
  }

  function legendEntries() {
    const scheme = ui["network-colour"].value;
    if (scheme === "state") return STATE.map((label, index) => [label, STATE_COLORS[index]]);
    if (scheme === "age") return ["0–17", "18–34", "35–49", "50–64", "65+"].map((label, index) => [label, `hsl(${[202,168,48,18,295][index]} 67% 58%)`]);
    if (scheme === "generation") return [...new Set(nodes.map((node) => node.generation))].sort((a,b)=>a-b).slice(0,16).map((value) => [`G${value}`, `hsl(${hashHue(value)} 72% 58%)`]);
    if (scheme === "occupation") return [...new Set(nodes.map((node) => occupationValue(node.id)))].sort((a,b)=>a-b).map((value) => [(language() === "zh" ? OCCUPATIONS_ZH : OCCUPATIONS)[value] || value, `hsl(${hashHue(value)} 62% 57%)`]);
    return [...new Set(nodes.map((node) => metadataValue("community", node.id, 0)))].sort((a,b)=>a-b).slice(0,16).map((value) => [`C${value}`, `hsl(${hashHue(value)} 66% 56%)`]);
  }
  function drawLegend() { ui["network-legend"].innerHTML = legendEntries().map(([label,color]) => `<span><i style="background:${color}"></i>${label}</span>`).join(""); }
  function updateSummary() {
    const eventTimes = edges.flatMap((edge) => [edge.earliest, edge.latest]);
    ui["network-node-count"].textContent = nodes.length.toLocaleString();
    ui["network-edge-count"].textContent = edges.length.toLocaleString();
    ui["network-generation-count"].textContent = nodes.length ? (Math.max(...nodes.map((node) => node.generation)) + 1).toLocaleString() : "0";
    ui["network-earliest"].textContent = eventTimes.length ? formatTime(Math.min(...eventTimes)) : "—";
    ui["network-latest"].textContent = eventTimes.length ? formatTime(Math.max(...eventTimes)) : "—";
  }
  function updateInspector() {
    const zh = language() === "zh";
    if (selectedNode) {
      const node = selectedNode; const occupation = occupationValue(node.id); const age = metadataValue("age", node.id, "—");
      const inbound = edges.filter((edge) => edge.target === node.id); const outbound = edges.filter((edge) => edge.source === node.id).sort((a,b)=>a.earliest-b.earliest);
      ui["network-inspector-title"].textContent = `Agent ${node.id}`;
      const details = [[zh ? "状态" : "State", STATE[node.state]], [zh ? "传播代" : "Generation", node.generation], [zh ? "感染时间" : "Infected", formatTime(node.infectedAt)], [zh ? "感染来源" : "Source", node.source >= 0 ? `Agent ${node.source}` : (zh ? "初始种子" : "Seed case")], [zh ? "继发感染" : "Secondary cases", node.secondary], [zh ? "度" : "Degree", node.degree], [zh ? "年龄" : "Age", age], [zh ? "年龄组" : "Age group", ageGroup(Number(age))], [zh ? "职业" : "Occupation", (zh ? OCCUPATIONS_ZH : OCCUPATIONS)[occupation] || occupation], [zh ? "社区" : "Community", `#${metadataValue("community", node.id, "—")}`], [zh ? "家庭" : "Household", `#${metadataValue("household", node.id, "—")}`], [zh ? "交通方式" : "Mobility", (zh ? MOBILITY_ZH : MOBILITY)[metadataValue("mobility", node.id, 0)]], [zh ? "最早入边" : "Earliest inbound", inbound.length ? formatTime(Math.min(...inbound.map((edge)=>edge.earliest))) : "—"]];
      ui["network-inspector-content"].innerHTML = `<div class="network-detail-grid">${details.map(([label,value])=>`<span>${label}</span><b>${value}</b>`).join("")}</div><div class="network-neighbours"><h3>${zh ? "传播给" : "Transmitted to"}</h3>${outbound.length ? outbound.slice(0,30).map((edge)=>`<button data-select-agent="${edge.target}"><span>Agent ${edge.target}</span><b>${formatTime(edge.earliest)}</b></button>`).join("") : `<p>${zh ? "没有已实现的继发传播" : "No realized secondary transmissions"}</p>`}</div>`;
    } else if (selectedEdge) {
      const edge = selectedEdge;
      ui["network-inspector-title"].textContent = `Agent ${edge.source} → ${edge.target}`;
      const details = [[zh ? "最早传播时间" : "Earliest transmission", formatTime(edge.earliest)], [zh ? "最晚记录时间" : "Latest recorded", formatTime(edge.latest)], [zh ? "记录数" : "Event count", edge.count], [zh ? "接触层" : "Contact layer", edge.layers.map((layer)=>(zh ? LAYERS_ZH : LAYERS)[layer]).join(", ")], [zh ? "来源传播代" : "Source generation", nodeById.get(edge.source)?.generation ?? "—"], [zh ? "目标传播代" : "Target generation", nodeById.get(edge.target)?.generation ?? "—"]];
      ui["network-inspector-content"].innerHTML = `<div class="network-detail-grid">${details.map(([label,value])=>`<span>${label}</span><b>${value}</b>`).join("")}</div><div class="network-neighbours"><button data-select-agent="${edge.source}"><span>${zh ? "选择来源" : "Select source"}</span><b>Agent ${edge.source}</b></button><button data-select-agent="${edge.target}"><span>${zh ? "选择目标" : "Select target"}</span><b>Agent ${edge.target}</b></button></div>`;
    } else {
      ui["network-inspector-title"].textContent = zh ? "尚未选择" : "Nothing selected";
      ui["network-inspector-content"].innerHTML = `<p>${zh ? "点击节点查看 Agent 身份与传播历史；点击边查看其最早传播时间。" : "Select a node to inspect its Agent identity and transmission history. Select an edge to inspect its earliest event."}</p>`;
    }
  }

  function canvasCoordinates(event) { const rect = ui["network-canvas"].getBoundingClientRect(); return { x:(event.clientX-rect.left)*ui["network-canvas"].width/rect.width, y:(event.clientY-rect.top)*ui["network-canvas"].height/rect.height }; }
  function segmentDistance(point, a, b) { const dx=b.x-a.x, dy=b.y-a.y; const length=dx*dx+dy*dy || 1; const t=Math.max(0,Math.min(1,((point.x-a.x)*dx+(point.y-a.y)*dy)/length)); return (point.x-(a.x+t*dx))**2+(point.y-(a.y+t*dy))**2; }
  function selectAt(point) {
    if (!run) return;
    const mapPoint = { x:(point.x-viewport.x)/viewport.scale, y:(point.y-viewport.y)/viewport.scale };
    let nearestNode=null, nearestDistance=Number.POSITIVE_INFINITY;
    nodes.forEach((node)=>{ const candidate=screenPoint(node,ui["network-canvas"].width,ui["network-canvas"].height); const distance=(candidate.x-mapPoint.x)**2+(candidate.y-mapPoint.y)**2; const radius=(nodeRadius(node)+6)/viewport.scale; if(distance<radius*radius&&distance<nearestDistance){nearestNode=node;nearestDistance=distance;} });
    selectedNode=nearestNode; selectedEdge=null;
    if (!nearestNode) {
      let edgeDistance=(8/viewport.scale)**2;
      filteredEdges().forEach((edge)=>{ const distance=segmentDistance(mapPoint,screenPoint(nodeById.get(edge.source),ui["network-canvas"].width,ui["network-canvas"].height),screenPoint(nodeById.get(edge.target),ui["network-canvas"].width,ui["network-canvas"].height)); if(distance<edgeDistance){selectedEdge=edge;edgeDistance=distance;} });
    }
    updateInspector(); draw();
  }
  function selectAgent(id, focus = true) {
    const node = nodeById.get(Number(id));
    if (!node) return false;
    selectedNode = node; selectedEdge = null; updateInspector(); draw();
    if (focus && ui["network-layout"].value === "force" && forceGraph) {
      const forceNode = forceGraph.graphData().nodes.find((candidate) => candidate.id === node.id);
      if (forceNode && Number.isFinite(forceNode.x) && Number.isFinite(forceNode.y)) {
        forceGraph.centerAt(forceNode.x, forceNode.y, 500);
        forceGraph.zoom(5, 500);
      }
    }
    return true;
  }
  async function loadDocument(documentData, label) { buildGraph(documentData); ui["network-status"].textContent=label; }
  async function loadShared(id) { ui["network-status"].textContent=language()==="zh"?"正在加载 24 小时链接…":"Loading 24-hour link…"; const response=await fetch(new URL(`runs/${encodeURIComponent(id)}`,root.dataset.runApi)); if(!response.ok)throw new Error(response.status===404?"Run expired or not found":`Load failed: ${response.status}`); await loadDocument(await response.json(),language()==="zh"?"已载入 24 小时共享 run":"24-hour shared run loaded"); }
  function downloadRun(){if(!run)return;const blob=new Blob([JSON.stringify(run)],{type:"application/json"});const link=document.createElement("a");link.href=URL.createObjectURL(blob);link.download="synthetic-city-run.json";link.click();setTimeout(()=>URL.revokeObjectURL(link.href),1000);}

  ui["network-run-upload"].addEventListener("change",async()=>{const file=ui["network-run-upload"].files?.[0];if(!file)return;try{await loadDocument(JSON.parse(await file.text()),language()==="zh"?"本地 run JSON 已加载":"Local run JSON loaded");}catch(error){ui["network-status"].textContent=error.message;}finally{ui["network-run-upload"].value="";}});
  ui["network-layout"].addEventListener("change", () => {
    forceFitPending = false;
    if (ui["network-layout"].value === "force" && run) {
      ui["network-canvas"].hidden = true;
      ui["network-force"].hidden = false;
      updateForceData(true);
      drawLegend();
    } else draw();
  });
  ["network-colour","network-size"].forEach((id)=>ui[id].addEventListener("change",draw));
  ui["network-layer"].addEventListener("change", () => {
    if (ui["network-layout"].value === "force") updateForceData(true);
    else draw();
  });
  ui["network-find"].addEventListener("click",()=>{if(!selectAgent(ui["network-search"].value))ui["network-status"].textContent=language()==="zh"?"该 Agent 不在传播网络中":"Agent is not present in this transmission network";});
  ui["network-search"].addEventListener("keydown",(event)=>{if(event.key==="Enter")ui["network-find"].click();});
  ui["network-reset-view"].addEventListener("click",()=>{
    if (ui["network-layout"].value === "force" && forceGraph) fitForceGraph(500);
    else { viewport.scale=1;viewport.x=0;viewport.y=0;draw(); }
  });
  ui["network-download"].addEventListener("click",downloadRun);
  ui["network-inspector-content"].addEventListener("click",(event)=>{const button=event.target.closest("[data-select-agent]");if(button)selectAgent(button.dataset.selectAgent);});
  ui["network-canvas"].addEventListener("wheel",(event)=>{event.preventDefault();const point=canvasCoordinates(event);const next=Math.min(12,Math.max(1,viewport.scale*(event.deltaY<0?1.25:.8)));const ratio=next/viewport.scale;viewport.x=point.x-(point.x-viewport.x)*ratio;viewport.y=point.y-(point.y-viewport.y)*ratio;viewport.scale=next;if(next===1){viewport.x=0;viewport.y=0;}draw();},{passive:false});
  ui["network-canvas"].addEventListener("pointerdown",(event)=>{const point=canvasCoordinates(event);pointer={startX:point.x,startY:point.y,lastX:point.x,lastY:point.y,moved:false};ui["network-canvas"].setPointerCapture(event.pointerId);});
  ui["network-canvas"].addEventListener("pointermove",(event)=>{if(!pointer)return;const point=canvasCoordinates(event);if(Math.abs(point.x-pointer.startX)+Math.abs(point.y-pointer.startY)>5)pointer.moved=true;if(pointer.moved){viewport.x+=point.x-pointer.lastX;viewport.y+=point.y-pointer.lastY;ui["network-canvas"].classList.add("is-panning");draw();}pointer.lastX=point.x;pointer.lastY=point.y;});
  ui["network-canvas"].addEventListener("pointerup",(event)=>{if(!pointer)return;const point=canvasCoordinates(event);if(!pointer.moved)selectAt(point);pointer=null;ui["network-canvas"].classList.remove("is-panning");});
  ui["network-canvas"].addEventListener("pointercancel",()=>{pointer=null;ui["network-canvas"].classList.remove("is-panning");});
  window.addEventListener("resize",()=>{ if (ui["network-layout"].value !== "force") draw(); });
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(() => {
      if (ui["network-layout"].value !== "force" || !forceGraph) return;
      clearTimeout(forceResizeTimer);
      forceResizeTimer = setTimeout(adaptForceToCanvas, 120);
    }).observe(ui["network-force"].parentElement);
  }
  window.addEventListener("urban-language-change",()=>{updateControlLabels();updateInspector();drawLegend();});

  const runId=new URLSearchParams(window.location.search).get("run");
  updateControlLabels();
  if(runId)loadShared(runId).catch((error)=>{ui["network-status"].textContent=error.message;});
  draw();
})();
