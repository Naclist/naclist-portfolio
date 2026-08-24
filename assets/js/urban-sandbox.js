(() => {
  "use strict";

  const root = document.querySelector("[data-sandbox-root]");
  if (!root) return;

  const STEPS_PER_DAY = 96;
  const TOTAL_STEPS = 14 * STEPS_PER_DAY;
  const COLS = 32;
  const ROWS = 20;
  const BLOCKS = COLS * ROWS;
  const LAYERS = ["Household", "School", "Workplace", "Community", "Transport", "Healthcare", "Transient"];
  const LAYERS_ZH = ["家庭", "学校", "工作场所", "社区", "交通", "医疗", "短暂接触"];
  const profiles = {
    droplet: {
      name: { en: "Close-range respiratory", zh: "近距离呼吸道传播" },
      description: { en: "Repeated close contacts dominate.", zh: "重复性的近距离接触占主导。" },
      weights: [1.7, 1.2, 1.0, 0.55, 0.35, 0.7, 0.25], local: 0.88, global: 0.015, gain: 1.0
    },
    airborne: {
      name: { en: "Shared-air respiratory", zh: "共享空气传播" },
      description: { en: "Crowded shared spaces amplify mixing.", zh: "拥挤的共享空间放大混合。" },
      weights: [1.15, 1.1, 1.1, 1.2, 1.1, 0.9, 0.8], local: 0.66, global: 0.24, gain: 1.18
    },
    contact: {
      name: { en: "Contact-mediated", zh: "接触媒介传播" },
      description: { en: "Persistent environments outweigh transient mixing.", zh: "持续环境比短暂混合更重要。" },
      weights: [1.5, 1.0, 0.95, 0.55, 0.3, 1.1, 0.2], local: 0.93, global: 0.005, gain: 0.93
    }
  };

  const ui = Object.fromEntries([
    "city-canvas", "curve-canvas", "profile-select", "r0-range", "r0-value",
    "seed-count", "restart-button", "research-notice", "service-status",
    "clock-day", "clock-time", "metric-s", "metric-e", "metric-i", "metric-r",
    "metric-expected", "metric-realized", "metric-rt", "metric-blocks",
    "metric-communities", "profile-name", "profile-description", "profile-weights",
    "layer-bars", "timeline-range", "reset-button", "play-button", "step-button",
    "speed-select"
  ].map((id) => [id, document.getElementById(id)]));

  let mode = "demo";
  let populationSize = 10000;
  let selectedLayer = "state";
  let running = false;
  let timer = null;
  let rng = mulberry32(20260824);
  let step = 0;
  let targetR0 = 1.5;
  let activeProfile = profiles.droplet;
  let blockPopulation, blockS, blockE, blockI, blockR, blockExposedAt, blockLayer;
  let agents = null;
  let curves = null;
  let layerTotals = new Float64Array(7);
  let cumulativeInfections = 0;
  let initialSeeds = 5;

  function mulberry32(seed) {
    return function random() {
      let value = seed += 0x6D2B79F5;
      value = Math.imul(value ^ value >>> 15, value | 1);
      value ^= value + Math.imul(value ^ value >>> 7, value | 61);
      return ((value ^ value >>> 14) >>> 0) / 4294967296;
    };
  }

  function poisson(lambda) {
    if (lambda <= 0) return 0;
    if (lambda > 35) {
      const normal = Math.sqrt(-2 * Math.log(Math.max(rng(), 1e-9))) * Math.cos(2 * Math.PI * rng());
      return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * normal));
    }
    const limit = Math.exp(-lambda);
    let product = 1;
    let count = 0;
    do { count += 1; product *= rng(); } while (product > limit);
    return count - 1;
  }

  function cityWeight(index) {
    const x = index % COLS;
    const y = Math.floor(index / COLS);
    const dx = (x - COLS * .58) / COLS;
    const dy = (y - ROWS * .48) / ROWS;
    const cbd = Math.exp(-(dx * dx + dy * dy) * 25);
    const corridor = Math.exp(-Math.pow(y - ROWS * .57, 2) / 8) * .45;
    const satellite = Math.exp(-((x - 7) ** 2 + (y - 5) ** 2) / 18) * .5;
    return .18 + cbd * 2.4 + corridor + satellite;
  }

  function distributePopulation(total) {
    const weights = new Float64Array(BLOCKS);
    let sum = 0;
    for (let block = 0; block < BLOCKS; block += 1) { weights[block] = cityWeight(block); sum += weights[block]; }
    const result = new Int32Array(BLOCKS);
    let assigned = 0;
    for (let block = 0; block < BLOCKS; block += 1) {
      result[block] = Math.floor(total * weights[block] / sum);
      assigned += result[block];
    }
    for (let block = 0; assigned < total; assigned += 1, block = (block + 37) % BLOCKS) result[block] += 1;
    return result;
  }

  function createAgents(total) {
    const homeX = new Float32Array(total);
    const homeY = new Float32Array(total);
    const workX = new Float32Array(total);
    const workY = new Float32Array(total);
    const block = new Uint16Array(total);
    const state = new Uint8Array(total);
    const timer = new Uint16Array(total);
    let agent = 0;
    for (let b = 0; b < BLOCKS && agent < total; b += 1) {
      const bx = b % COLS;
      const by = Math.floor(b / COLS);
      for (let count = 0; count < blockPopulation[b] && agent < total; count += 1, agent += 1) {
        homeX[agent] = (bx + .12 + rng() * .76) / COLS;
        homeY[agent] = (by + .12 + rng() * .76) / ROWS;
        const careerPull = rng() < .58;
        workX[agent] = careerPull ? .5 + rng() * .24 : Math.min(.98, Math.max(.02, homeX[agent] + (rng() - .5) * .25));
        workY[agent] = careerPull ? .33 + rng() * .36 : Math.min(.98, Math.max(.02, homeY[agent] + (rng() - .5) * .22));
        block[agent] = b;
      }
    }
    return { homeX, homeY, workX, workY, block, state, timer };
  }

  function restart() {
    running = false;
    ui["play-button"].textContent = "▶";
    targetR0 = Number(ui["r0-range"].value);
    initialSeeds = Math.max(1, Number(ui["seed-count"].value) || 5);
    activeProfile = profiles[ui["profile-select"].value];
    populationSize = mode === "demo" ? 10000 : 100000;
    rng = mulberry32(20260824 + Math.round(targetR0 * 100) + initialSeeds * 17 + (mode === "research" ? 999 : 0) + Object.keys(profiles).indexOf(ui["profile-select"].value) * 111);
    step = 0;
    layerTotals = new Float64Array(7);
    blockPopulation = distributePopulation(populationSize);
    blockS = new Int32Array(blockPopulation);
    blockE = new Int32Array(BLOCKS);
    blockI = new Int32Array(BLOCKS);
    blockR = new Int32Array(BLOCKS);
    blockExposedAt = new Int32Array(BLOCKS);
    blockLayer = new Float64Array(BLOCKS * 7);
    curves = { s: [], e: [], i: [], r: [], incidence: [] };
    cumulativeInfections = initialSeeds;
    const seedBlock = Math.floor(ROWS * .53) * COLS + Math.floor(COLS * .58);
    const actualSeeds = Math.min(initialSeeds, blockS[seedBlock]);
    blockS[seedBlock] -= actualSeeds;
    blockE[seedBlock] += actualSeeds;
    if (mode === "demo") {
      agents = createAgents(populationSize);
      let seeded = 0;
      for (let a = 0; a < populationSize && seeded < actualSeeds; a += 1) {
        if (agents.block[a] === seedBlock) { agents.state[a] = 1; agents.timer[a] = 2 * STEPS_PER_DAY + Math.floor(rng() * 24); seeded += 1; }
      }
    } else {
      agents = null;
      blockExposedAt[seedBlock] = actualSeeds * 2 * STEPS_PER_DAY;
    }
    recordCurve(actualSeeds);
    ui["timeline-range"].value = 0;
    updateProfileCard();
    updateAll();
  }

  function neighborInfectious(block, globalPrevalence) {
    const x = block % COLS;
    const y = Math.floor(block / COLS);
    let total = 0;
    let population = 0;
    for (let oy = -1; oy <= 1; oy += 1) {
      for (let ox = -1; ox <= 1; ox += 1) {
        const nx = x + ox;
        const ny = y + oy;
        if (nx >= 0 && nx < COLS && ny >= 0 && ny < ROWS) {
          const other = ny * COLS + nx;
          const distanceWeight = ox === 0 && oy === 0 ? activeProfile.local : (1 - activeProfile.local) / 8;
          total += blockI[other] * distanceWeight;
          population += blockPopulation[other] * distanceWeight;
        }
      }
    }
    const localPrevalence = population ? total / population : 0;
    return activeProfile.gain * (
      localPrevalence * (1 - activeProfile.global)
      + globalPrevalence * activeProfile.global
    );
  }

  function chooseLayer() {
    const weights = activeProfile.weights;
    const sum = weights.reduce((a, b) => a + b, 0);
    let draw = rng() * sum;
    for (let layer = 0; layer < weights.length; layer += 1) {
      draw -= weights[layer];
      if (draw <= 0) return layer;
    }
    return weights.length - 1;
  }

  function advanceDemo() {
    const pressure = new Float64Array(BLOCKS);
    const infectiousDays = 5;
    let infectiousTotal = 0;
    for (let block = 0; block < BLOCKS; block += 1) infectiousTotal += blockI[block];
    const globalPrevalence = infectiousTotal / populationSize;
    for (let block = 0; block < BLOCKS; block += 1) pressure[block] = targetR0 / (infectiousDays * STEPS_PER_DAY) * neighborInfectious(block, globalPrevalence);
    let newInfections = 0;
    for (let agent = 0; agent < populationSize; agent += 1) {
      const state = agents.state[agent];
      if (state === 0 && rng() < Math.min(.45, pressure[agents.block[agent]])) {
        agents.state[agent] = 1;
        agents.timer[agent] = Math.round((1.4 + rng() * 1.3) * STEPS_PER_DAY);
        newInfections += 1;
        const layer = chooseLayer();
        layerTotals[layer] += 1;
      } else if (state === 1 || state === 2) {
        if (agents.timer[agent] > 0) agents.timer[agent] -= 1;
        if (agents.timer[agent] === 0 && state === 1) {
          agents.state[agent] = 2;
          agents.timer[agent] = Math.round((3.2 + rng() * 3.3) * STEPS_PER_DAY);
        } else if (agents.timer[agent] === 0 && state === 2) agents.state[agent] = 3;
      }
    }
    blockS.fill(0); blockE.fill(0); blockI.fill(0); blockR.fill(0);
    for (let agent = 0; agent < populationSize; agent += 1) {
      const block = agents.block[agent];
      const state = agents.state[agent];
      if (state === 0) blockS[block] += 1;
      else if (state === 1) blockE[block] += 1;
      else if (state === 2) blockI[block] += 1;
      else blockR[block] += 1;
    }
    cumulativeInfections += newInfections;
    return newInfections;
  }

  function advanceResearch() {
    const nextE = new Int32Array(BLOCKS);
    const nextI = new Int32Array(BLOCKS);
    const latentRate = 1 / (2 * STEPS_PER_DAY);
    const recoveryRate = 1 / (5 * STEPS_PER_DAY);
    let newInfections = 0;
    let infectiousTotal = 0;
    for (let block = 0; block < BLOCKS; block += 1) infectiousTotal += blockI[block];
    const globalPrevalence = infectiousTotal / populationSize;
    for (let block = 0; block < BLOCKS; block += 1) {
      const force = targetR0 / (5 * STEPS_PER_DAY) * neighborInfectious(block, globalPrevalence);
      nextE[block] = Math.min(blockS[block], poisson(blockS[block] * force));
      nextI[block] = Math.min(blockE[block], poisson(blockE[block] * latentRate));
      const recoveries = Math.min(blockI[block], poisson(blockI[block] * recoveryRate));
      blockS[block] -= nextE[block];
      blockE[block] += nextE[block] - nextI[block];
      blockI[block] += nextI[block] - recoveries;
      blockR[block] += recoveries;
      newInfections += nextE[block];
      for (let n = 0; n < nextE[block]; n += 1) layerTotals[chooseLayer()] += 1;
    }
    cumulativeInfections += newInfections;
    return newInfections;
  }

  function advanceOne() {
    if (step >= TOTAL_STEPS - 1) { running = false; ui["play-button"].textContent = "▶"; return; }
    step += 1;
    const incidence = mode === "demo" ? advanceDemo() : advanceResearch();
    recordCurve(incidence);
  }

  function totals() {
    let s = 0, e = 0, i = 0, r = 0, blocks = 0;
    const communities = new Set();
    for (let block = 0; block < BLOCKS; block += 1) {
      s += blockS[block]; e += blockE[block]; i += blockI[block]; r += blockR[block];
      if (blockE[block] + blockI[block] + blockR[block] > 0) { blocks += 1; communities.add(Math.floor((block % COLS) / 4) + Math.floor(Math.floor(block / COLS) / 4) * 8); }
    }
    return { s, e, i, r, blocks, communities: communities.size };
  }

  function recordCurve(incidence) {
    const value = totals();
    curves.s.push(value.s); curves.e.push(value.e); curves.i.push(value.i); curves.r.push(value.r); curves.incidence.push(incidence);
  }

  function format(value) { return Math.round(value).toLocaleString(); }
  function currentLanguage() { return window.urbanLanguage ? window.urbanLanguage() : "en"; }

  function updateMetrics() {
    const value = totals();
    ui["metric-s"].textContent = format(value.s);
    ui["metric-e"].textContent = format(value.e);
    ui["metric-i"].textContent = format(value.i);
    ui["metric-r"].textContent = format(value.r);
    ui["metric-expected"].textContent = `≈ ${targetR0.toFixed(2)}`;
    ui["metric-expected"].title = currentLanguage() === "zh"
      ? "浏览器聚合预览；服务端接触校准后显示精确值"
      : "Aggregate browser preview; exact value is reported after server-side contact calibration";
    ui["metric-realized"].textContent = value.r > 0 ? ((cumulativeInfections - initialSeeds) / value.r).toFixed(2) : "—";
    const recent = curves.incidence.slice(Math.max(0, curves.incidence.length - STEPS_PER_DAY)).reduce((a, b) => a + b, 0);
    ui["metric-rt"].textContent = value.i > 0 ? (recent * 5 / value.i).toFixed(2) : "—";
    ui["metric-blocks"].textContent = format(value.blocks);
    ui["metric-communities"].textContent = format(value.communities);
    ui["clock-day"].textContent = `${currentLanguage() === "zh" ? "第" : "DAY "}${String(Math.floor(step / STEPS_PER_DAY) + 1).padStart(2, "0")}${currentLanguage() === "zh" ? "天" : ""}`;
    const minutes = Math.floor((step % STEPS_PER_DAY) * 15);
    ui["clock-time"].textContent = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
    ui["timeline-range"].value = step;
  }

  function updateProfileCard() {
    const language = currentLanguage();
    ui["profile-name"].textContent = activeProfile.name[language];
    ui["profile-description"].textContent = activeProfile.description[language];
    const names = language === "zh" ? LAYERS_ZH : LAYERS;
    const max = Math.max(...activeProfile.weights);
    ui["profile-weights"].innerHTML = activeProfile.weights.map((weight, index) => `<div><span>${names[index]}</span><i><b style="width:${weight / max * 100}%"></b></i><strong>${weight.toFixed(2)}</strong></div>`).join("");
  }

  function updateLayerBars() {
    const language = currentLanguage();
    const names = language === "zh" ? LAYERS_ZH : LAYERS;
    const max = Math.max(1, ...layerTotals);
    ui["layer-bars"].innerHTML = Array.from(layerTotals).map((value, index) => `<div><span>${names[index]}</span><i><b style="width:${value / max * 100}%"></b></i><strong>${Math.round(value)}</strong></div>`).join("");
  }

  function resizeCanvas(canvas) {
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width * ratio));
    const height = Math.max(1, Math.round(rect.height * ratio));
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    return { width, height, ratio };
  }

  function blockGeometry(block, width, height) {
    const margin = Math.min(width, height) * .045;
    const cellW = (width - margin * 2) / COLS;
    const cellH = (height - margin * 2) / ROWS;
    return { x: margin + (block % COLS) * cellW, y: margin + Math.floor(block / COLS) * cellH, w: cellW, h: cellH };
  }

  function drawRoads(ctx, width, height) {
    ctx.save();
    ctx.strokeStyle = selectedLayer === "flow" ? "rgba(78,225,210,.45)" : "rgba(151,166,177,.18)";
    for (let x = 0; x <= COLS; x += 1) {
      const a = blockGeometry(Math.min(x, COLS - 1), width, height);
      ctx.lineWidth = x % 8 === 0 ? 2.4 : (x % 4 === 0 ? 1.2 : .45);
      ctx.beginPath(); ctx.moveTo(a.x, blockGeometry(0, width, height).y); ctx.lineTo(a.x, blockGeometry(BLOCKS - 1, width, height).y + a.h); ctx.stroke();
    }
    for (let y = 0; y <= ROWS; y += 1) {
      const a = blockGeometry(Math.min(y, ROWS - 1) * COLS, width, height);
      ctx.lineWidth = y % 5 === 0 ? 2.4 : (y % 3 === 0 ? 1.2 : .45);
      ctx.beginPath(); ctx.moveTo(blockGeometry(0, width, height).x, a.y); ctx.lineTo(blockGeometry(COLS - 1, width, height).x + a.w, a.y); ctx.stroke();
    }
    if (selectedLayer === "flow") {
      const hour = (step % STEPS_PER_DAY) / 4;
      const pulse = .35 + .65 * Math.max(Math.exp(-((hour - 8) ** 2) / 3), Math.exp(-((hour - 18) ** 2) / 4));
      ctx.strokeStyle = `rgba(199,255,74,${pulse * .58})`; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.moveTo(width * .15, height * .62); ctx.bezierCurveTo(width * .4, height * .58, width * .62, height * .52, width * .86, height * .35); ctx.stroke();
    }
    ctx.restore();
  }

  function drawCity() {
    const canvas = ui["city-canvas"];
    const { width, height } = resizeCanvas(canvas);
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#091016"; ctx.fillRect(0, 0, width, height);
    let maxPrevalence = 0;
    for (let block = 0; block < BLOCKS; block += 1) maxPrevalence = Math.max(maxPrevalence, (blockE[block] + blockI[block]) / Math.max(blockPopulation[block], 1));
    for (let block = 0; block < BLOCKS; block += 1) {
      const g = blockGeometry(block, width, height);
      const density = blockPopulation[block] / Math.max(...blockPopulation);
      const prevalence = (blockE[block] + blockI[block]) / Math.max(blockPopulation[block], 1);
      if (selectedLayer === "density") {
        const intensity = maxPrevalence ? prevalence / maxPrevalence : 0;
        ctx.fillStyle = `rgba(255,93,85,${.035 + intensity * .82})`;
      } else {
        const green = 22 + Math.round(density * 32);
        ctx.fillStyle = `rgb(12,${green},${29 + Math.round(density * 18)})`;
      }
      ctx.fillRect(g.x + 1, g.y + 1, Math.max(0, g.w - 2), Math.max(0, g.h - 2));
      if (prevalence > 0 && selectedLayer === "state") {
        ctx.fillStyle = `rgba(255,93,85,${Math.min(.8, .12 + prevalence * 4)})`;
        ctx.fillRect(g.x + 1, g.y + 1, Math.max(0, g.w - 2), Math.max(0, g.h - 2));
      }
    }
    drawRoads(ctx, width, height);
    if (mode === "demo" && agents && selectedLayer !== "density") {
      const hour = (step % STEPS_PER_DAY) / 4;
      const workFactor = hour < 7 ? 0 : hour < 9 ? (hour - 7) / 2 : hour < 17 ? 1 : hour < 19 ? 1 - (hour - 17) / 2 : 0;
      const colors = ["rgba(116,151,174,.30)", "#f2bd53", "#ff5d55", "#61cf8d"];
      const size = Math.max(1.2, Math.min(width, height) / 450);
      for (let agent = 0; agent < populationSize; agent += 1) {
        const x = agents.homeX[agent] + (agents.workX[agent] - agents.homeX[agent]) * workFactor;
        const y = agents.homeY[agent] + (agents.workY[agent] - agents.homeY[agent]) * workFactor;
        ctx.fillStyle = colors[agents.state[agent]];
        const g0 = blockGeometry(0, width, height);
        const px = g0.x + x * (width - 2 * g0.x);
        const py = g0.y + y * (height - 2 * g0.y);
        ctx.fillRect(px, py, agents.state[agent] === 2 ? size * 2.2 : size, agents.state[agent] === 2 ? size * 2.2 : size);
      }
    }
  }

  function drawCurve() {
    const canvas = ui["curve-canvas"];
    const { width, height } = resizeCanvas(canvas);
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, width, height); ctx.fillStyle = "#11171f"; ctx.fillRect(0, 0, width, height);
    const pad = { l: 44, r: 16, t: 15, b: 27 };
    ctx.strokeStyle = "rgba(130,145,157,.16)"; ctx.lineWidth = 1;
    for (let grid = 0; grid <= 4; grid += 1) { const y = pad.t + (height - pad.t - pad.b) * grid / 4; ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(width - pad.r, y); ctx.stroke(); }
    const max = Math.max(10, ...curves.e, ...curves.i, ...curves.r);
    const series = [[curves.e, "#f2bd53"], [curves.i, "#ff5d55"], [curves.r, "#61cf8d"]];
    series.forEach(([values, color]) => {
      ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath();
      values.forEach((value, index) => {
        const x = pad.l + index / (TOTAL_STEPS - 1) * (width - pad.l - pad.r);
        const y = height - pad.b - value / max * (height - pad.t - pad.b);
        if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
    });
    ctx.fillStyle = "#687582"; ctx.font = `${Math.max(9, width / 120)}px monospace`; ctx.textAlign = "center";
    [1, 4, 7, 10, 14].forEach((day) => { const x = pad.l + (day - 1) / 13 * (width - pad.l - pad.r); ctx.fillText(`D${String(day).padStart(2, "0")}`, x, height - 8); });
  }

  function updateAll() { updateMetrics(); updateLayerBars(); drawCity(); drawCurve(); }

  function tick() {
    if (!running) return;
    const speed = Number(ui["speed-select"].value);
    for (let n = 0; n < speed; n += 1) advanceOne();
    updateAll();
  }

  document.querySelectorAll("[data-mode]").forEach((button) => button.addEventListener("click", () => {
    mode = button.dataset.mode;
    document.querySelectorAll("[data-mode]").forEach((item) => item.classList.toggle("active", item === button));
    ui["research-notice"].hidden = mode !== "research";
    restart();
  }));
  document.querySelectorAll("[data-map-layer]").forEach((button) => button.addEventListener("click", () => {
    selectedLayer = button.dataset.mapLayer;
    document.querySelectorAll("[data-map-layer]").forEach((item) => item.classList.toggle("active", item === button));
    drawCity();
  }));
  ui["r0-range"].addEventListener("input", () => { ui["r0-value"].textContent = Number(ui["r0-range"].value).toFixed(2); });
  ui["restart-button"].addEventListener("click", restart);
  ui["profile-select"].addEventListener("change", () => { activeProfile = profiles[ui["profile-select"].value]; updateProfileCard(); });
  ui["play-button"].addEventListener("click", () => { running = !running; ui["play-button"].textContent = running ? "Ⅱ" : "▶"; });
  ui["step-button"].addEventListener("click", () => { running = false; advanceOne(); updateAll(); });
  ui["reset-button"].addEventListener("click", restart);
  ui["timeline-range"].addEventListener("change", () => {
    const target = Number(ui["timeline-range"].value);
    if (target < step) restart();
    while (step < target) advanceOne();
    updateAll();
  });
  window.addEventListener("resize", () => { drawCity(); drawCurve(); });
  window.addEventListener("urban-language-change", () => { updateProfileCard(); updateLayerBars(); updateMetrics(); });

  timer = window.setInterval(tick, 90);
  window.addEventListener("pagehide", () => window.clearInterval(timer));
  restart();
})();
