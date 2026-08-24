(() => {
  "use strict";

  const root = document.querySelector("[data-sandbox-root]");
  if (!root) return;

  const STEPS_PER_DAY = 96;
  const TOTAL_STEPS = 14 * STEPS_PER_DAY;
  const BASE_PLAYBACK_MS = 240;
  const COLS = 20;
  const ROWS = 20;
  const BLOCKS = COLS * ROWS;
  const LAYERS = ["Household", "School", "Workplace", "Community", "Transport", "Healthcare", "Transient"];
  const LAYERS_ZH = ["家庭", "学校", "工作场所", "社区", "交通", "医疗", "短暂接触"];
  const OCCUPATIONS = ["student", "office/professional", "education", "healthcare", "retail/service", "manufacturing", "logistics/transport", "construction", "public administration", "hospitality", "unemployed", "retired"];
  const OCCUPATIONS_ZH = ["学生", "办公室/专业人员", "教育", "医疗", "零售/服务", "制造业", "物流/交通", "建筑", "公共管理", "餐旅服务", "未就业", "退休"];
  const MOBILITY = ["walk", "public transport", "private vehicle"];
  const MOBILITY_ZH = ["步行", "公共交通", "私家车"];
  const LIFE_STAGES = ["infant/toddler", "preschool", "primary student", "lower secondary", "upper secondary", "tertiary/worker", "working age", "retired/older"];
  const LIFE_STAGES_ZH = ["婴幼儿", "学龄前", "小学生", "初中生", "高中生", "大学生/工作者", "工作年龄", "退休/老年"];
  const SHIFTS = ["day", "evening", "night", "rotating"];
  const SHIFTS_ZH = ["日班", "晚班", "夜班", "轮班"];
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
    "city-canvas", "curve-canvas", "generation-canvas", "tree-canvas", "profile-select", "r0-range", "r0-value",
    "seed-count", "restart-button",
    "clock-day", "clock-time", "metric-s", "metric-e", "metric-i", "metric-r",
    "metric-expected", "metric-realized", "metric-rt", "metric-blocks",
    "metric-communities", "profile-name", "profile-description", "profile-weights",
    "layer-bars", "timeline-range", "reset-button", "play-button", "step-button",
    "speed-select", "spatial-legend", "zoom-in", "zoom-out", "zoom-reset",
    "agent-inspector", "agent-inspector-close", "agent-inspector-title",
    "agent-inspector-content", "run-upload", "download-run", "publish-run", "run-data-status"
  ].map((id) => [id, document.getElementById(id)]));

  let populationSize = 10000;
  let selectedLayer = "urban";
  let running = false;
  let timer = null;
  let rng = mulberry32(20260824);
  let step = 0;
  let targetR0 = 1.5;
  let activeProfile = profiles.droplet;
  let blockPopulation, blockPresent, blockS, blockE, blockI, blockR, blockExposedAt, blockLayer;
  let agents = null;
  let curves = null;
  let layerTotals = new Float64Array(7);
  let cumulativeInfections = 0;
  let initialSeeds = 5;
  let transmissions = [];
  let generationTotals = new Uint32Array(32);
  let treeHitAreas = [];
  let realCity = null;
  let realMobility = null;
  let selectedAgent = -1;
  const viewport = { scale: 1, x: 0, y: 0 };
  let pointerGesture = null;

  function mulberry32(seed) {
    return function random() {
      let value = seed += 0x6D2B79F5;
      value = Math.imul(value ^ value >>> 15, value | 1);
      value ^= value + Math.imul(value ^ value >>> 7, value | 61);
      return ((value ^ value >>> 14) >>> 0) / 4294967296;
    };
  }

  async function decompressedBuffer(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Unable to load ${url}: ${response.status}`);
    const compressed = await response.arrayBuffer();
    const bytes = new Uint8Array(compressed);
    if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return compressed;
    if (!("DecompressionStream" in window)) {
      throw new Error("This browser does not support gzip DecompressionStream");
    }
    return new Response(
      new Blob([compressed]).stream().pipeThrough(new DecompressionStream("gzip"))
    ).arrayBuffer();
  }

  async function loadRealCityBundle() {
    const base = new URL(root.dataset.bundleUrl, window.location.origin);
    const [manifestResponse, cityBuffer, mobilityBuffer] = await Promise.all([
      fetch(new URL("manifest.json", base)),
      decompressedBuffer(new URL("city-10k.json.gz", base)),
      decompressedBuffer(new URL("mobility-10k.bin.gz", base))
    ]);
    if (!manifestResponse.ok) throw new Error("Unable to load city manifest");
    const manifest = await manifestResponse.json();
    realCity = JSON.parse(new TextDecoder().decode(cityBuffer));
    const view = new DataView(mobilityBuffer);
    const magic = String.fromCharCode(...new Uint8Array(mobilityBuffer, 0, 4));
    if (magic !== "ABM1") throw new Error("Invalid mobility bundle");
    realMobility = {
      agentCount: view.getUint32(4, true),
      samples: view.getUint16(8, true),
      stride: view.getUint16(10, true),
      positions: new Uint16Array(mobilityBuffer, 16)
    };
    if (realMobility.agentCount !== manifest.population) {
      throw new Error("Population and mobility bundle disagree");
    }
    const status = document.querySelector(".sandbox-pagebar .live-dot span");
    if (status) {
      status.removeAttribute("data-i18n");
      status.textContent = currentLanguage() === "zh" ? "真实 10K 数据已加载" : "REAL 10K DATA LOADED";
    }
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

  function cityPopulation(total) {
    if (!realCity || !realCity.blocks || realCity.blocks.length !== BLOCKS) {
      return distributePopulation(total);
    }
    const source = realCity.blocks.map((block) => Number(block[6]));
    const sourceTotal = source.reduce((sum, value) => sum + value, 0);
    const result = new Int32Array(BLOCKS);
    let assigned = 0;
    source.forEach((value, block) => {
      result[block] = Math.floor(total * value / Math.max(sourceTotal, 1));
      assigned += result[block];
    });
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
    const generation = new Int16Array(total);
    generation.fill(-1);
    const source = new Int32Array(total);
    source.fill(-1);
    const infectedAt = new Int16Array(total);
    infectedAt.fill(-1);
    const secondary = new Uint16Array(total);
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
    return { homeX, homeY, workX, workY, block, state, timer, generation, source, infectedAt, secondary };
  }

  function restart() {
    running = false;
    window.clearTimeout(timer);
    timer = null;
    ui["play-button"].textContent = "▶";
    targetR0 = Number(ui["r0-range"].value);
    initialSeeds = Math.max(1, Number(ui["seed-count"].value) || 5);
    activeProfile = profiles[ui["profile-select"].value];
    populationSize = 10000;
    rng = mulberry32(20260824 + Math.round(targetR0 * 100) + initialSeeds * 17 + Object.keys(profiles).indexOf(ui["profile-select"].value) * 111);
    step = 0;
    layerTotals = new Float64Array(7);
    transmissions = [];
    generationTotals = new Uint32Array(32);
    blockPopulation = cityPopulation(populationSize);
    blockPresent = new Int32Array(blockPopulation);
    blockS = new Int32Array(blockPopulation);
    blockE = new Int32Array(BLOCKS);
    blockI = new Int32Array(BLOCKS);
    blockR = new Int32Array(BLOCKS);
    blockExposedAt = new Int32Array(BLOCKS);
    blockLayer = new Float64Array(BLOCKS * 7);
    curves = { s: [], e: [], i: [], r: [], incidence: [] };
    cumulativeInfections = initialSeeds;
    const preferredSeedBlock = Math.floor(ROWS * .53) * COLS + Math.floor(COLS * .58);
    let seedBlock = preferredSeedBlock;
    if (blockPopulation[seedBlock] < initialSeeds) {
      const preferredX = preferredSeedBlock % COLS;
      const preferredY = Math.floor(preferredSeedBlock / COLS);
      let bestDistance = Number.POSITIVE_INFINITY;
      for (let block = 0; block < BLOCKS; block += 1) {
        if (blockPopulation[block] < initialSeeds) continue;
        const distance = Math.abs(block % COLS - preferredX) + Math.abs(Math.floor(block / COLS) - preferredY);
        if (distance < bestDistance) { bestDistance = distance; seedBlock = block; }
      }
    }
    const actualSeeds = Math.min(initialSeeds, blockS[seedBlock]);
    generationTotals[0] = actualSeeds;
    blockS[seedBlock] -= actualSeeds;
    blockE[seedBlock] += actualSeeds;
    agents = createAgents(populationSize);
    if (realCity && realCity.agents && realCity.agents.block.length === populationSize) {
      agents.block.set(realCity.agents.block.map((value) => Math.max(0, value)));
    }
    let seeded = 0;
    for (let a = 0; a < populationSize && seeded < actualSeeds; a += 1) {
      if (agents.block[a] === seedBlock) {
        agents.state[a] = 1;
        agents.timer[a] = 2 * STEPS_PER_DAY + Math.floor(rng() * 24);
        agents.generation[a] = 0;
        agents.infectedAt[a] = 0;
        seeded += 1;
      }
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
          population += blockPresent[other] * distanceWeight;
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

  function blockFromPosition(position) {
    const x = Math.max(0, Math.min(COLS - 1, Math.floor(position.x * COLS)));
    const y = Math.max(0, Math.min(ROWS - 1, Math.floor(position.y * ROWS)));
    return y * COLS + x;
  }

  function updateAgentBlocks() {
    for (let agent = 0; agent < populationSize; agent += 1) {
      agents.block[agent] = blockFromPosition(agentPosition(agent));
    }
  }

  function rebuildBlockStateCounts() {
    blockPresent.fill(0); blockS.fill(0); blockE.fill(0); blockI.fill(0); blockR.fill(0);
    for (let agent = 0; agent < populationSize; agent += 1) {
      const block = agents.block[agent];
      const state = agents.state[agent];
      blockPresent[block] += 1;
      if (state === 0) blockS[block] += 1;
      else if (state === 1) blockE[block] += 1;
      else if (state === 2) blockI[block] += 1;
      else blockR[block] += 1;
    }
  }

  function chooseWeightedAvailableLayer(pools) {
    const available = [];
    let total = 0;
    for (let layer = 0; layer < pools.length; layer += 1) {
      if (!pools[layer].length) continue;
      total += activeProfile.weights[layer];
      available.push([layer, total]);
    }
    if (!available.length) return null;
    const draw = rng() * total;
    const layer = (available.find((entry) => draw <= entry[1]) || available[available.length - 1])[0];
    const pool = pools[layer];
    return { layer, source: pool[Math.floor(rng() * pool.length)] };
  }

  function semanticContactPools(target, candidates, excludeHousehold = false) {
    const pools = Array.from({ length: 7 }, () => []);
    const data = realCity && realCity.agents;
    if (!data) {
      candidates.forEach((source) => pools[6].push(source));
      return pools;
    }
    const targetBlock = agents.block[target];
    const targetHome = data.block[target];
    const targetPrimary = data.primary_location[target];
    const targetPrimaryBlock = data.primary_block ? data.primary_block[target] : -1;
    const targetDetail = data.occupation_detail ? data.occupation_detail[target] : data.occupation[target];
    for (const source of candidates) {
      if (agents.block[source] !== targetBlock) continue;
      const sameHousehold = data.household[source] === data.household[target];
      const atSharedHome = targetBlock === targetHome && targetBlock === data.block[source];
      if (sameHousehold && atSharedHome) {
        if (!excludeHousehold) pools[0].push(source);
        continue;
      }
      const sourceDetail = data.occupation_detail ? data.occupation_detail[source] : data.occupation[source];
      const sharedPrimary = targetPrimary >= 0 && targetPrimary === data.primary_location[source];
      const atPrimary = targetBlock === targetPrimaryBlock && targetBlock === (data.primary_block ? data.primary_block[source] : -2);
      if ((targetDetail === 3 || sourceDetail === 3) && (atPrimary || targetBlock === (data.primary_block ? data.primary_block[targetDetail === 3 ? target : source] : -2))) {
        pools[5].push(source); continue;
      }
      if (sharedPrimary && atPrimary && (targetDetail === 0 || targetDetail === 2 || sourceDetail === 0 || sourceDetail === 2)) {
        pools[1].push(source); continue;
      }
      if (sharedPrimary && atPrimary) { pools[2].push(source); continue; }
      const targetMoving = targetBlock !== targetHome && targetBlock !== targetPrimaryBlock;
      const sourceMoving = targetBlock !== data.block[source] && targetBlock !== (data.primary_block ? data.primary_block[source] : -1);
      if (data.mobility[target] === 1 && data.mobility[source] === 1 && targetMoving && sourceMoving) {
        pools[4].push(source); continue;
      }
      if (data.community[target] === data.community[source]) { pools[3].push(source); continue; }
      pools[6].push(source);
    }
    return pools;
  }

  function advanceDemo() {
    updateAgentBlocks();
    rebuildBlockStateCounts();
    const pressure = new Float64Array(BLOCKS);
    const infectiousDays = 5;
    let infectiousTotal = 0;
    const infectiousByBlock = Array.from({ length: BLOCKS }, () => []);
    const infectiousByHousehold = new Map();
    for (let agent = 0; agent < populationSize; agent += 1) {
      if (agents.state[agent] !== 2) continue;
      infectiousByBlock[agents.block[agent]].push(agent);
      if (realCity && realCity.agents) {
        const household = realCity.agents.household[agent];
        if (!infectiousByHousehold.has(household)) infectiousByHousehold.set(household, []);
        infectiousByHousehold.get(household).push(agent);
      }
      infectiousTotal += 1;
    }
    const globalPrevalence = infectiousTotal / populationSize;
    for (let block = 0; block < BLOCKS; block += 1) pressure[block] = targetR0 / (infectiousDays * STEPS_PER_DAY) * neighborInfectious(block, globalPrevalence);
    let newInfections = 0;
    for (let agent = 0; agent < populationSize; agent += 1) {
      const state = agents.state[agent];
      if (state === 0) {
        const block = agents.block[agent];
        const candidates = infectiousByBlock[block];
        if (!candidates.length) continue;
        let householdCandidates = [];
        if (realCity && realCity.agents) {
          householdCandidates = (infectiousByHousehold.get(realCity.agents.household[agent]) || []).filter((source) =>
            agents.block[source] === block && block === realCity.agents.block[agent] && block === realCity.agents.block[source]
          );
        }
        const baseHazard = pressure[block];
        const householdHazard = householdCandidates.length
          ? targetR0 / (infectiousDays * STEPS_PER_DAY) * activeProfile.weights[0] * .32 * Math.min(2, householdCandidates.length)
          : 0;
        const totalHazard = Math.min(.6, baseHazard + householdHazard);
        if (rng() >= -Math.expm1(-totalHazard)) continue;
        let contact = null;
        if (householdCandidates.length && rng() < householdHazard / Math.max(totalHazard, Number.EPSILON)) {
          contact = { layer: 0, source: householdCandidates[Math.floor(rng() * householdCandidates.length)] };
        } else {
          contact = chooseWeightedAvailableLayer(semanticContactPools(agent, candidates, true));
          if (!contact && householdCandidates.length) contact = { layer: 0, source: householdCandidates[Math.floor(rng() * householdCandidates.length)] };
        }
        if (!contact) continue;
        const { source, layer } = contact;
        agents.state[agent] = 1;
        agents.timer[agent] = Math.round((1.4 + rng() * 1.3) * STEPS_PER_DAY);
        agents.source[agent] = source;
        agents.infectedAt[agent] = step;
        agents.generation[agent] = Math.max(1, agents.generation[source] + 1);
        agents.secondary[source] += 1;
        generationTotals[Math.min(generationTotals.length - 1, agents.generation[agent])] += 1;
        transmissions.push({
          source, target: agent, time: step, layer,
          generation: agents.generation[agent], source_block: agents.block[source], target_block: block
        });
        newInfections += 1;
        layerTotals[layer] += 1;
      } else if (state === 1 || state === 2) {
        if (agents.timer[agent] > 0) agents.timer[agent] -= 1;
        if (agents.timer[agent] === 0 && state === 1) {
          agents.state[agent] = 2;
          agents.timer[agent] = Math.round((3.2 + rng() * 3.3) * STEPS_PER_DAY);
        } else if (agents.timer[agent] === 0 && state === 2) agents.state[agent] = 3;
      }
    }
    rebuildBlockStateCounts();
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
    const incidence = advanceDemo();
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

  function agentPosition(agent) {
    if (realMobility && realMobility.agentCount === populationSize) {
      const sample = step / realMobility.stride;
      const first = Math.min(realMobility.samples - 1, Math.floor(sample));
      const second = Math.min(realMobility.samples - 1, first + 1);
      const alpha = sample - first;
      const firstIndex = (first * populationSize + agent) * 2;
      const secondIndex = (second * populationSize + agent) * 2;
      return {
        x: (realMobility.positions[firstIndex] * (1 - alpha) + realMobility.positions[secondIndex] * alpha) / 65535,
        y: (realMobility.positions[firstIndex + 1] * (1 - alpha) + realMobility.positions[secondIndex + 1] * alpha) / 65535
      };
    }
    const hour = (step % STEPS_PER_DAY) / 4;
    const workFactor = hour < 7 ? 0 : hour < 9 ? (hour - 7) / 2 : hour < 17 ? 1 : hour < 19 ? 1 - (hour - 17) / 2 : 0;
    return {
      x: agents.homeX[agent] + (agents.workX[agent] - agents.homeX[agent]) * workFactor,
      y: agents.homeY[agent] + (agents.workY[agent] - agents.homeY[agent]) * workFactor
    };
  }

  function agentCanvasPoint(agent, width, height) {
    const position = agentPosition(agent);
    const margin = Math.min(width, height) * .045;
    return {
      x: margin + position.x * (width - margin * 2),
      y: margin + (1 - position.y) * (height - margin * 2),
      normalized: position
    };
  }

  function updateAgentInspector() {
    if (selectedAgent < 0 || !agents) {
      ui["agent-inspector"].hidden = true;
      return;
    }
    const zh = currentLanguage() === "zh";
    const data = realCity && realCity.agents ? realCity.agents : null;
    const point = agentPosition(selectedAgent);
    let currentBlock = agents.block[selectedAgent];
    if (realCity && realCity.blocks) {
      const x = point.x * 25;
      const y = point.y * 25;
      const match = realCity.blocks.find((block) => x >= block[1] && x <= block[3] && y >= block[2] && y <= block[4]);
      if (match) currentBlock = match[0];
    }
    const stateNames = ["S", "E", "I", "R"];
    const values = [
      [zh ? "状态" : "State", stateNames[agents.state[selectedAgent]]],
      [zh ? "传播代" : "Generation", agents.generation[selectedAgent] >= 0 ? agents.generation[selectedAgent] : "—"],
      [zh ? "感染来源" : "Source", agents.source[selectedAgent] >= 0 ? `Agent ${agents.source[selectedAgent]}` : (agents.generation[selectedAgent] === 0 ? (zh ? "初始种子" : "Seed case") : "—")],
      [zh ? "继发感染" : "Secondary cases", agents.secondary[selectedAgent]],
      [zh ? "年龄" : "Age", data ? data.age[selectedAgent] : "—"],
      [zh ? "性别" : "Sex", data ? (data.sex[selectedAgent] === 0 ? (zh ? "女" : "Female") : (zh ? "男" : "Male")) : "—"],
      [zh ? "职业" : "Occupation", data ? (zh ? OCCUPATIONS_ZH : OCCUPATIONS)[data.occupation_detail ? data.occupation_detail[selectedAgent] : data.occupation[selectedAgent]] : "—"],
      [zh ? "生命阶段" : "Life stage", data ? (zh ? LIFE_STAGES_ZH : LIFE_STAGES)[data.life_stage[selectedAgent]] : "—"],
      [zh ? "交通方式" : "Mobility", data ? (zh ? MOBILITY_ZH : MOBILITY)[data.mobility[selectedAgent]] : "—"],
      [zh ? "班次" : "Work shift", data ? (zh ? SHIFTS_ZH : SHIFTS)[data.work_shift[selectedAgent]] : "—"],
      [zh ? "收入" : "Income", data ? Math.round(data.income[selectedAgent]).toLocaleString() : "—"],
      [zh ? "家庭" : "Household", data ? `#${data.household[selectedAgent]}` : "—"],
      [zh ? "社区" : "Community", data ? `#${data.community[selectedAgent]}` : "—"],
      [zh ? "所在街区" : "Current block", `#${currentBlock}`],
      [zh ? "坐标" : "Position", `${(point.x * 25).toFixed(2)}, ${(point.y * 25).toFixed(2)}`]
    ];
    ui["agent-inspector-title"].textContent = `${zh ? "Agent" : "Agent"} ${selectedAgent}`;
    ui["agent-inspector-content"].innerHTML = values.map(([label, value]) => `<span>${label}</span><b>${value ?? "—"}</b>`).join("");
    ui["agent-inspector"].hidden = false;
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
    if (realCity && realCity.blocks && realCity.blocks[block]) {
      const value = realCity.blocks[block];
      const plotWidth = width - margin * 2;
      const plotHeight = height - margin * 2;
      return {
        x: margin + value[1] / 25 * plotWidth,
        y: margin + (25 - value[4]) / 25 * plotHeight,
        w: (value[3] - value[1]) / 25 * plotWidth,
        h: (value[4] - value[2]) / 25 * plotHeight
      };
    }
    const cellW = (width - margin * 2) / COLS;
    const cellH = (height - margin * 2) / ROWS;
    return { x: margin + (block % COLS) * cellW, y: margin + Math.floor(block / COLS) * cellH, w: cellW, h: cellH };
  }

  function drawRoads(ctx, width, height) {
    ctx.save();
    if (realCity && realCity.roads) {
      const margin = Math.min(width, height) * .045;
      const plotWidth = width - margin * 2;
      const plotHeight = height - margin * 2;
      let maxFlow = 1;
      let maxTransit = 1;
      realCity.roads.forEach((road) => {
        maxFlow = Math.max(maxFlow, road[6]);
        maxTransit = Math.max(maxTransit, road[7]);
      });
      realCity.roads.forEach((road) => {
        const roadType = road[4];
        if (selectedLayer === "transit") {
          const intensity = Math.log1p(road[7]) / Math.log1p(maxTransit);
          if (intensity < .04) return;
          ctx.strokeStyle = `rgba(78,225,210,${.12 + intensity * .82})`;
          ctx.lineWidth = .5 + intensity * 5;
        } else if (selectedLayer === "flow") {
          const intensity = Math.log1p(road[6]) / Math.log1p(maxFlow);
          const ratio = Math.min(1, road[10]);
          const red = Math.round(90 + ratio * 165);
          const green = Math.round(205 - ratio * 135);
          ctx.strokeStyle = `rgba(${red},${green},68,${.10 + intensity * .78})`;
          ctx.lineWidth = .45 + intensity * 4.4;
        } else {
          const alpha = [0.19, 0.28, 0.48, 0.14, 0.12][roadType] || .16;
          ctx.strokeStyle = `rgba(190,204,214,${alpha})`;
          ctx.lineWidth = [0.55, 1.0, 2.1, 0.45, 0.35][roadType] || .5;
        }
        ctx.beginPath();
        ctx.moveTo(margin + road[0] / 25 * plotWidth, margin + (25 - road[1]) / 25 * plotHeight);
        ctx.lineTo(margin + road[2] / 25 * plotWidth, margin + (25 - road[3]) / 25 * plotHeight);
        ctx.stroke();
      });
      ctx.restore();
      return;
    }
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

  function drawBuildings(ctx, width, height) {
    if (!realCity || !realCity.buildings || selectedLayer === "density") return;
    const margin = Math.min(width, height) * .045;
    const plotWidth = width - margin * 2;
    const plotHeight = height - margin * 2;
    const palette = ["#28485a", "#514635", "#5b4735", "#3b5748", "#4a3e5b", "#365662", "#615636"];
    realCity.buildings.forEach((building) => {
      const x = margin + building[1] / 25 * plotWidth;
      const y = margin + (25 - building[4]) / 25 * plotHeight;
      const w = Math.max(.55, (building[3] - building[1]) / 25 * plotWidth);
      const h = Math.max(.55, (building[4] - building[2]) / 25 * plotHeight);
      ctx.fillStyle = palette[building[5] % palette.length];
      ctx.globalAlpha = selectedLayer === "urban" ? .78 : .30;
      ctx.fillRect(x, y, w, h);
    });
    ctx.globalAlpha = 1;
  }

  function drawFacilities(ctx, width, height) {
    if (!realCity || !realCity.facilities) return;
    const margin = Math.min(width, height) * .045;
    const plotWidth = width - margin * 2;
    const plotHeight = height - margin * 2;
    realCity.facilities.forEach((facility) => {
      const x = margin + facility[2] / 25 * plotWidth;
      const y = margin + (25 - facility[3]) / 25 * plotHeight;
      ctx.fillStyle = facility[1] === 2 ? "#ff6d67" : "#d8f5f1";
      ctx.strokeStyle = "rgba(8,15,20,.8)";
      ctx.lineWidth = 1;
      ctx.fillRect(x - 2.5, y - 2.5, 5, 5);
      ctx.strokeRect(x - 2.5, y - 2.5, 5, 5);
    });
  }

  function drawCity() {
    const canvas = ui["city-canvas"];
    const { width, height } = resizeCanvas(canvas);
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#091016"; ctx.fillRect(0, 0, width, height);
    ctx.save();
    ctx.translate(viewport.x, viewport.y);
    ctx.scale(viewport.scale, viewport.scale);
    let maxPrevalence = 0;
    let maxTransitAccess = 1;
    for (let block = 0; block < BLOCKS; block += 1) maxPrevalence = Math.max(maxPrevalence, (blockE[block] + blockI[block]) / Math.max(blockPopulation[block], 1));
    if (realCity && realCity.blocks) realCity.blocks.forEach((block) => { maxTransitAccess = Math.max(maxTransitAccess, block[9]); });
    const landUsePalette = ["#18352e", "#243e35", "#3f3430", "#343b4b", "#453b31", "#343944", "#394049", "#3b2f3e", "#1c4230"];
    const maxBlockPopulation = Math.max(...blockPopulation);
    for (let block = 0; block < BLOCKS; block += 1) {
      const g = blockGeometry(block, width, height);
      const density = blockPopulation[block] / maxBlockPopulation;
      const prevalence = (blockE[block] + blockI[block]) / Math.max(blockPopulation[block], 1);
      if (selectedLayer === "density") {
        const intensity = maxPrevalence ? prevalence / maxPrevalence : 0;
        ctx.fillStyle = `rgba(255,93,85,${.035 + intensity * .82})`;
      } else if (selectedLayer === "transit" && realCity) {
        const access = realCity.blocks[block][9] / maxTransitAccess;
        ctx.fillStyle = `rgba(24,${38 + Math.round(access * 85)},${45 + Math.round(access * 100)},${.22 + access * .58})`;
      } else if (selectedLayer === "urban" && realCity) {
        ctx.fillStyle = landUsePalette[realCity.blocks[block][5] % landUsePalette.length];
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
    drawBuildings(ctx, width, height);
    drawRoads(ctx, width, height);
    drawFacilities(ctx, width, height);
    if (agents && selectedLayer !== "density") {
      const colors = ["rgba(116,151,174,.30)", "#f2bd53", "#ff5d55", "#61cf8d"];
      const size = Math.max(1.2, Math.min(width, height) / 450);
      for (let agent = 0; agent < populationSize; agent += 1) {
        if (agent === selectedAgent) continue;
        const point = agentCanvasPoint(agent, width, height);
        ctx.fillStyle = colors[agents.state[agent]];
        ctx.fillRect(point.x, point.y, agents.state[agent] === 2 ? size * 2.2 : size, agents.state[agent] === 2 ? size * 2.2 : size);
      }
      if (selectedAgent >= 0 && selectedAgent < populationSize) {
        const point = agentCanvasPoint(selectedAgent, width, height);
        ctx.strokeStyle = "#ffe239";
        ctx.lineWidth = 2.5 / viewport.scale;
        ctx.beginPath();
        ctx.arc(point.x, point.y, 8 / viewport.scale, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(point.x, point.y, 2.2 / viewport.scale, 0, Math.PI * 2);
        ctx.fillStyle = "#ffffff";
        ctx.fill();
      }
    }
    ctx.restore();
  }

  function updateSpatialLegend() {
    const zh = currentLanguage() === "zh";
    const legends = {
      urban: [
        ["#18352e", zh ? "住宅" : "Residential"], ["#3f3430", zh ? "商业" : "Commercial"],
        ["#343b4b", zh ? "办公" : "Office"], ["#453b31", zh ? "工业" : "Industrial"],
        ["#1c4230", zh ? "绿地" : "Green"]
      ],
      transit: [
        ["#18302d", zh ? "低可达性" : "Low access"], ["#187b91", zh ? "高可达性" : "High access"],
        ["#4ee1d2", zh ? "公共交通走廊" : "Transit corridor"]
      ],
      flow: [
        ["#4ee1d2", zh ? "畅通" : "Free flow"], ["#f2bd53", zh ? "繁忙" : "Busy"],
        ["#ff5d55", zh ? "接近容量" : "Near capacity"]
      ],
      state: [["#5b6874", "S"], ["#f2bd53", "E"], ["#ff5d55", "I"], ["#61cf8d", "R"]],
      density: [["rgba(255,93,85,.18)", zh ? "低感染密度" : "Low density"], ["#ff5d55", zh ? "高感染密度" : "High density"]]
    };
    ui["spatial-legend"].innerHTML = legends[selectedLayer].map(([color, label]) =>
      `<span><i style="--legend-color:${color}"></i>${label}</span>`
    ).join("");
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

  function drawGeneration() {
    const canvas = ui["generation-canvas"];
    const { width, height } = resizeCanvas(canvas);
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#11171f"; ctx.fillRect(0, 0, width, height);
    const values = Array.from(generationTotals);
    let last = values.length - 1;
    while (last > 0 && values[last] === 0) last -= 1;
    const shown = values.slice(0, last + 1);
    const max = Math.max(1, ...shown);
    const pad = { l: 35, r: 14, t: 18, b: 30 };
    const gap = 5;
    const barWidth = Math.max(3, (width - pad.l - pad.r - gap * shown.length) / shown.length);
    shown.forEach((value, generation) => {
      const x = pad.l + generation * (barWidth + gap);
      const barHeight = value / max * (height - pad.t - pad.b);
      const hue = (generation * 47 + 175) % 360;
      ctx.fillStyle = `hsl(${hue} 68% 58%)`;
      ctx.fillRect(x, height - pad.b - barHeight, barWidth, barHeight);
      ctx.fillStyle = "#7d8a95"; ctx.font = "9px monospace"; ctx.textAlign = "center";
      ctx.fillText(`G${generation}`, x + barWidth / 2, height - 10);
      if (value > 0) {
        ctx.fillStyle = "#d9e1e6";
        ctx.fillText(String(value), x + barWidth / 2, Math.max(11, height - pad.b - barHeight - 5));
      }
    });
  }

  function drawTree() {
    const canvas = ui["tree-canvas"];
    const { width, height } = resizeCanvas(canvas);
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#11171f"; ctx.fillRect(0, 0, width, height);
    treeHitAreas = [];
    if (!agents) return;
    const visibleEdges = transmissions.filter((edge) => edge.time <= step).slice(0, 3000);
    const nodes = new Map();
    for (let agent = 0; agent < populationSize; agent += 1) {
      if (agents.generation[agent] === 0) nodes.set(agent, 0);
    }
    visibleEdges.forEach((edge) => { nodes.set(edge.source, Math.max(0, agents.generation[edge.source])); nodes.set(edge.target, edge.generation); });
    const groups = new Map();
    nodes.forEach((generation, agent) => {
      if (!groups.has(generation)) groups.set(generation, []);
      groups.get(generation).push(agent);
    });
    const generations = [...groups.keys()].sort((a, b) => a - b);
    const positions = new Map();
    const pad = { l: 24, r: 24, t: 16, b: 18 };
    generations.forEach((generation, generationIndex) => {
      const group = groups.get(generation);
      group.forEach((agent, index) => positions.set(agent, {
        x: pad.l + generationIndex / Math.max(1, generations.length - 1) * (width - pad.l - pad.r),
        y: pad.t + (index + 1) / (group.length + 1) * (height - pad.t - pad.b)
      }));
    });
    ctx.strokeStyle = "rgba(132,151,165,.22)"; ctx.lineWidth = 1;
    visibleEdges.forEach((edge) => {
      const source = positions.get(edge.source); const target = positions.get(edge.target);
      if (!source || !target) return;
      ctx.beginPath(); ctx.moveTo(source.x, source.y); ctx.lineTo(target.x, target.y); ctx.stroke();
    });
    nodes.forEach((generation, agent) => {
      const position = positions.get(agent);
      const radius = Math.min(8, 2.2 + Math.sqrt(agents.secondary[agent] || 0));
      ctx.fillStyle = `hsl(${(generation * 47 + 175) % 360} 72% 58%)`;
      ctx.beginPath(); ctx.arc(position.x, position.y, radius, 0, Math.PI * 2); ctx.fill();
      if (agent === selectedAgent) {
        ctx.strokeStyle = "#ffe239"; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(position.x, position.y, radius + 4, 0, Math.PI * 2); ctx.stroke();
      }
      treeHitAreas.push({ agent, x: position.x, y: position.y, radius: Math.max(14, radius + 6) });
    });
  }

  function buildRunDocument() {
    const value = totals();
    return {
      schema: "synthetic-city-epidemic-run-v1",
      created_at: new Date().toISOString(),
      current_step: step,
      timestep_minutes: 15,
      population: populationSize,
      config: { target_r0: targetR0, initial_seeds: initialSeeds, profile: ui["profile-select"].value, deterministic_seed: 20260824 },
      summary: { ...value, cumulative_infections: cumulativeInfections },
      timeseries: curves,
      layer_totals: Array.from(layerTotals),
      generation_totals: Array.from(generationTotals),
      transmissions,
      agent_metadata: realCity && realCity.agents ? realCity.agents : null,
      agent_state: agents ? {
        state: Array.from(agents.state), generation: Array.from(agents.generation), source: Array.from(agents.source),
        infected_at: Array.from(agents.infectedAt), secondary: Array.from(agents.secondary), timer: Array.from(agents.timer)
      } : null
    };
  }

  function downloadRunDocument() {
    const blob = new Blob([JSON.stringify(buildRunDocument())], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `synthetic-city-run-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  function loadRunDocument(documentData) {
    if (!documentData || documentData.schema !== "synthetic-city-epidemic-run-v1") throw new Error("Unsupported run JSON schema");
    if (documentData.population !== 10000 || !documentData.agent_state) throw new Error("The public model accepts individual 10K run JSON files only");
    ui["r0-range"].value = documentData.config.target_r0;
    ui["r0-value"].textContent = Number(documentData.config.target_r0).toFixed(2);
    ui["seed-count"].value = documentData.config.initial_seeds;
    ui["profile-select"].value = documentData.config.profile;
    restart();
    step = Math.max(0, Math.min(TOTAL_STEPS - 1, Number(documentData.current_step) || 0));
    transmissions = Array.isArray(documentData.transmissions) ? documentData.transmissions : [];
    layerTotals = new Float64Array(7);
    layerTotals.set((documentData.layer_totals || []).slice(0, 7));
    generationTotals = new Uint32Array(32);
    generationTotals.set((documentData.generation_totals || []).slice(0, 32));
    curves = documentData.timeseries || curves;
    agents.state.set(documentData.agent_state.state);
    agents.generation.set(documentData.agent_state.generation);
    agents.source.set(documentData.agent_state.source);
    agents.infectedAt.set(documentData.agent_state.infected_at);
    agents.secondary.set(documentData.agent_state.secondary);
    if (documentData.agent_state.timer) agents.timer.set(documentData.agent_state.timer);
    updateAgentBlocks();
    rebuildBlockStateCounts();
    cumulativeInfections = 0;
    for (let agent = 0; agent < populationSize; agent += 1) {
      const state = agents.state[agent];
      if (state !== 0) cumulativeInfections += 1;
    }
    ui["timeline-range"].value = step;
    ui["run-data-status"].textContent = currentLanguage() === "zh" ? "已载入本地 run JSON" : "Local run JSON loaded";
    updateAll();
  }

  async function publishRunDocument() {
    ui["publish-run"].disabled = true;
    ui["run-data-status"].textContent = currentLanguage() === "zh" ? "正在上传…" : "Uploading…";
    try {
      const response = await fetch(new URL("runs", root.dataset.runApi), {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(buildRunDocument())
      });
      if (!response.ok) throw new Error(`Upload failed: ${response.status}`);
      const result = await response.json();
      const networkUrl = new URL("../network/", window.location.href);
      networkUrl.searchParams.set("run", result.id);
      await navigator.clipboard?.writeText(networkUrl.href);
      ui["run-data-status"].innerHTML = `<a href="${networkUrl.href}">${currentLanguage() === "zh" ? "24 小时链接已复制" : "24-hour link copied"}</a>`;
    } catch (error) {
      console.warn(error);
      ui["run-data-status"].textContent = currentLanguage() === "zh" ? "临时存储 API 尚不可用" : "Temporary storage API unavailable";
    } finally {
      ui["publish-run"].disabled = false;
    }
  }

  async function checkRunApi() {
    try {
      const response = await fetch(new URL("health", root.dataset.runApi), { cache: "no-store" });
      if (!response.ok) throw new Error(String(response.status));
      ui["publish-run"].disabled = false;
    } catch (_) {
      ui["publish-run"].disabled = true;
      ui["run-data-status"].textContent = currentLanguage() === "zh" ? "本地 run · 24 小时分享等待 HTTPS" : "Local run · 24-hour sharing awaits HTTPS";
    }
  }

  function updateAll() { updateMetrics(); updateLayerBars(); updateSpatialLegend(); updateAgentInspector(); drawCity(); drawCurve(); drawGeneration(); drawTree(); }

  function tick() {
    if (!running) return;
    advanceOne();
    updateAll();
    scheduleTick();
  }

  function scheduleTick() {
    window.clearTimeout(timer);
    timer = null;
    if (!running) return;
    const speed = Math.max(1, Number(ui["speed-select"].value));
    timer = window.setTimeout(tick, Math.max(20, BASE_PLAYBACK_MS / speed));
  }

  function zoomAt(canvasX, canvasY, factor) {
    const next = Math.min(8, Math.max(1, viewport.scale * factor));
    const ratio = next / viewport.scale;
    viewport.x = canvasX - (canvasX - viewport.x) * ratio;
    viewport.y = canvasY - (canvasY - viewport.y) * ratio;
    viewport.scale = next;
    if (next === 1) { viewport.x = 0; viewport.y = 0; }
    drawCity();
  }

  function canvasCoordinates(event) {
    const canvas = ui["city-canvas"];
    const rect = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * canvas.width / rect.width,
      y: (event.clientY - rect.top) * canvas.height / rect.height
    };
  }

  function selectAgentAt(point) {
    if (!agents) return;
    const canvas = ui["city-canvas"];
    const mapX = (point.x - viewport.x) / viewport.scale;
    const mapY = (point.y - viewport.y) / viewport.scale;
    const threshold = 11 * Math.min(2, window.devicePixelRatio || 1) / viewport.scale;
    let nearest = -1;
    let nearestDistance = threshold * threshold;
    for (let agent = 0; agent < populationSize; agent += 1) {
      const candidate = agentCanvasPoint(agent, canvas.width, canvas.height);
      const distance = (candidate.x - mapX) ** 2 + (candidate.y - mapY) ** 2;
      if (distance < nearestDistance) { nearestDistance = distance; nearest = agent; }
    }
    selectedAgent = nearest;
    updateAgentInspector();
    drawCity();
  }

  document.querySelectorAll("[data-map-layer]").forEach((button) => button.addEventListener("click", () => {
    selectedLayer = button.dataset.mapLayer;
    document.querySelectorAll("[data-map-layer]").forEach((item) => item.classList.toggle("active", item === button));
    updateSpatialLegend();
    drawCity();
  }));
  ui["r0-range"].addEventListener("input", () => { ui["r0-value"].textContent = Number(ui["r0-range"].value).toFixed(2); });
  ui["restart-button"].addEventListener("click", restart);
  ui["download-run"].addEventListener("click", downloadRunDocument);
  ui["publish-run"].addEventListener("click", publishRunDocument);
  ui["run-upload"].addEventListener("change", async () => {
    const file = ui["run-upload"].files && ui["run-upload"].files[0];
    if (!file) return;
    try { loadRunDocument(JSON.parse(await file.text())); }
    catch (error) { ui["run-data-status"].textContent = error.message; }
    finally { ui["run-upload"].value = ""; }
  });
  ui["profile-select"].addEventListener("change", () => { activeProfile = profiles[ui["profile-select"].value]; updateProfileCard(); });
  ui["play-button"].addEventListener("click", () => {
    running = !running;
    ui["play-button"].textContent = running ? "Ⅱ" : "▶";
    scheduleTick();
  });
  ui["step-button"].addEventListener("click", () => { running = false; window.clearTimeout(timer); advanceOne(); updateAll(); });
  ui["reset-button"].addEventListener("click", restart);
  ui["speed-select"].addEventListener("change", scheduleTick);
  ui["timeline-range"].addEventListener("change", () => {
    const target = Number(ui["timeline-range"].value);
    if (target < step) restart();
    while (step < target) advanceOne();
    updateAll();
  });
  ui["zoom-in"].addEventListener("click", () => zoomAt(ui["city-canvas"].width / 2, ui["city-canvas"].height / 2, 1.5));
  ui["zoom-out"].addEventListener("click", () => zoomAt(ui["city-canvas"].width / 2, ui["city-canvas"].height / 2, 1 / 1.5));
  ui["zoom-reset"].addEventListener("click", () => { viewport.scale = 1; viewport.x = 0; viewport.y = 0; drawCity(); });
  ui["agent-inspector-close"].addEventListener("click", () => { selectedAgent = -1; updateAgentInspector(); drawCity(); });
  ui["city-canvas"].addEventListener("wheel", (event) => {
    event.preventDefault();
    const point = canvasCoordinates(event);
    zoomAt(point.x, point.y, event.deltaY < 0 ? 1.28 : 1 / 1.28);
  }, { passive: false });
  ui["city-canvas"].addEventListener("pointerdown", (event) => {
    const point = canvasCoordinates(event);
    pointerGesture = { startX: point.x, startY: point.y, lastX: point.x, lastY: point.y, moved: false };
    ui["city-canvas"].setPointerCapture(event.pointerId);
  });
  ui["city-canvas"].addEventListener("pointermove", (event) => {
    if (!pointerGesture) return;
    const point = canvasCoordinates(event);
    const dx = point.x - pointerGesture.lastX;
    const dy = point.y - pointerGesture.lastY;
    if (Math.abs(point.x - pointerGesture.startX) + Math.abs(point.y - pointerGesture.startY) > 5) pointerGesture.moved = true;
    if (pointerGesture.moved) {
      viewport.x += dx;
      viewport.y += dy;
      ui["city-canvas"].classList.add("is-panning");
      drawCity();
    }
    pointerGesture.lastX = point.x;
    pointerGesture.lastY = point.y;
  });
  ui["city-canvas"].addEventListener("pointerup", (event) => {
    if (!pointerGesture) return;
    const point = canvasCoordinates(event);
    if (!pointerGesture.moved) selectAgentAt(point);
    pointerGesture = null;
    ui["city-canvas"].classList.remove("is-panning");
  });
  ui["city-canvas"].addEventListener("pointercancel", () => {
    pointerGesture = null;
    ui["city-canvas"].classList.remove("is-panning");
  });
  ui["tree-canvas"].addEventListener("click", (event) => {
    const rect = ui["tree-canvas"].getBoundingClientRect();
    const x = (event.clientX - rect.left) * ui["tree-canvas"].width / rect.width;
    const y = (event.clientY - rect.top) * ui["tree-canvas"].height / rect.height;
    let nearest = null;
    let distance = Number.POSITIVE_INFINITY;
    treeHitAreas.forEach((node) => {
      const candidate = (node.x - x) ** 2 + (node.y - y) ** 2;
      if (candidate <= node.radius ** 2 && candidate < distance) { nearest = node.agent; distance = candidate; }
    });
    if (nearest !== null) { selectedAgent = nearest; updateAgentInspector(); drawCity(); drawTree(); }
  });
  window.addEventListener("resize", () => { drawCity(); drawCurve(); drawGeneration(); drawTree(); });
  window.addEventListener("urban-language-change", () => {
    updateProfileCard(); updateLayerBars(); updateMetrics(); updateSpatialLegend(); updateAgentInspector();
    if (realCity) {
      const status = document.querySelector(".sandbox-pagebar .live-dot span");
      if (status) status.textContent = currentLanguage() === "zh" ? "真实 10K 数据已加载" : "REAL 10K DATA LOADED";
    }
  });

  window.addEventListener("pagehide", () => window.clearTimeout(timer));
  loadRealCityBundle()
    .catch((error) => console.warn("Using synthetic fallback city:", error))
    .finally(() => { restart(); checkRunApi(); });
})();
