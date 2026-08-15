(() => {
  const root = document.querySelector('[data-mutation-viewer]');
  if (!root) return;

  const plot = root.querySelector('[data-mutation-plot]');
  const details = root.querySelector('[data-mutation-details]');
  const status = root.querySelector('[data-viewer-status]');
  const workspace = root.querySelector('[data-viewer-workspace]');
  const effectSelect = root.querySelector('[data-effect-select]');
  const effectLabel = root.querySelector('[data-effect-label]');
  const recordFilter = root.querySelector('[data-record-filter]');
  const detailsLink = root.querySelector('[data-details-link]');

  if (!plot || !details || !status || !workspace || !effectSelect || !recordFilter) return;

  const palette = {
    'ESL2.5': { base: '#e95f2a', highlight: '#f8b27e' },
    'non-ESL2.5': { base: '#202348', highlight: '#9ca0c5' }
  };
  const effectNames = {
    'protein-changing': 'Protein-changing',
    synonymous: 'Synonymous',
    'regulatory/flanking': 'Regulatory/flanking',
    other: 'Other'
  };

  let payload = null;
  let selectedKey = null;

  if (detailsLink) detailsLink.href = root.dataset.detailsUrl;
  effectSelect.addEventListener('change', draw);
  recordFilter.addEventListener('input', renderDetails);

  fetch(root.dataset.dataUrl)
    .then(response => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    })
    .then(data => {
      payload = data;
      const first = data.blocks.slice().sort((a, b) => b.density - a.density)[0];
      selectedKey = first ? first.key : null;
      workspace.hidden = false;
      status.hidden = true;
      draw();
      renderDetails();
    })
    .catch(error => {
      status.textContent = `The mutation annotation data could not be loaded (${error.message}).`;
      status.classList.add('is-error');
    });

  function svgElement(name, attributes = {}, parent = plot) {
    const element = document.createElementNS('http://www.w3.org/2000/svg', name);
    Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, value));
    parent.appendChild(element);
    return element;
  }

  function svgText(x, y, value, options = {}) {
    const text = svgElement('text', {
      x,
      y,
      'font-size': options.size || 14,
      fill: options.fill || '#222',
      'font-weight': options.weight || '400',
      'text-anchor': options.anchor || 'start'
    });
    text.textContent = value;
    return text;
  }

  function draw() {
    if (!payload) return;

    const effect = effectSelect.value;
    effectLabel.textContent = effectNames[effect] || effect;
    plot.innerHTML = '';

    const width = 1200;
    const marginLeft = 88;
    const marginRight = 34;
    const plotTop = 72;
    const middle = 305;
    const plotBottom = 548;
    const plotWidth = width - marginLeft - marginRight;
    const yMax = payload.ymax;
    const maxBlock = Math.max(1, payload.maxBlock);
    const xScale = block => marginLeft + block / maxBlock * plotWidth;
    const yScale = (value, group) => group === 'ESL2.5'
      ? middle - value / yMax * (middle - plotTop)
      : middle + value / yMax * (plotBottom - middle);

    svgElement('rect', { x: 0, y: 0, width, height: 620, fill: '#fff' });
    svgElement('line', { x1: marginLeft, y1: middle, x2: width - marginRight, y2: middle, stroke: '#222', 'stroke-width': 1.5 });
    svgElement('line', { x1: marginLeft, y1: plotTop, x2: marginLeft, y2: plotBottom, stroke: '#222', 'stroke-width': 1.2 });

    for (let value = 1; value <= yMax; value += 1) {
      svgText(marginLeft - 15, yScale(value, 'ESL2.5') + 5, value, { size: 13, anchor: 'end' });
      svgText(marginLeft - 15, yScale(value, 'non-ESL2.5') + 5, value, { size: 13, anchor: 'end' });
    }

    const genomeMb = Math.ceil((maxBlock * 10000) / 1000000);
    for (let mb = 0; mb <= genomeMb; mb += 1) {
      const block = Math.min(maxBlock, mb * 100);
      const x = xScale(block);
      svgElement('line', { x1: x, y1: middle - 4, x2: x, y2: middle + 4, stroke: '#222' });
      svgText(x, middle + 28, `${mb} Mb`, { size: 15, anchor: 'middle' });
    }

    svgText(23, 315, 'Mutation records per window (%)', { size: 15, weight: '600', anchor: 'middle' })
      .setAttribute('transform', 'rotate(-90 23 315)');
    svgText(640, middle + 55, 'MDR-TJ chromosome position', { size: 17, anchor: 'middle' });
    svgText(marginLeft + 8, plotTop - 20, 'ESL2.5', { size: 16, weight: '700', fill: palette['ESL2.5'].base });
    svgText(marginLeft + 8, plotBottom + 30, 'Non-ESL2.5', { size: 16, weight: '700', fill: palette['non-ESL2.5'].base });

    const barWidth = Math.max(1.2, plotWidth / (maxBlock + 1) * 0.88);
    const highlightWidth = Math.max(0.8, barWidth * 0.42);

    payload.blocks.forEach(block => {
      const x = xScale(block.block);
      const baseY = yScale(block.density, block.group);
      const baseHeight = Math.abs(baseY - middle);
      const baseTop = block.group === 'ESL2.5' ? baseY : middle;
      const effectCount = Number(block.effect_counts[effect] || 0);
      const effectDensity = block.count ? block.density * effectCount / block.count : 0;
      const highlightY = yScale(effectDensity, block.group);
      const highlightHeight = Math.abs(highlightY - middle);
      const highlightTop = block.group === 'ESL2.5' ? highlightY : middle;

      const bar = svgElement('rect', {
        x: x - barWidth / 2,
        y: baseTop,
        width: barWidth,
        height: Math.max(0.8, baseHeight),
        fill: palette[block.group].base,
        class: `mutation-bar${block.key === selectedKey ? ' is-selected' : ''}`,
        tabindex: 0,
        role: 'button',
        'aria-label': `${block.group}, ${formatNumber(block.start)} to ${formatNumber(block.end)} base pairs, ${block.count} mutation records`
      });
      bar.dataset.key = block.key;

      svgElement('rect', {
        x: x - highlightWidth / 2,
        y: highlightTop,
        width: highlightWidth,
        height: highlightHeight,
        fill: palette[block.group].highlight,
        'pointer-events': 'none'
      });

      const title = svgElement('title', {}, bar);
      title.textContent = `${block.group}\n${formatNumber(block.start)}-${formatNumber(block.end)} bp\nAll: ${block.count}\n${effectNames[effect]}: ${effectCount}`;
      bar.addEventListener('click', () => selectBlock(block.key));
      bar.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          selectBlock(block.key);
        }
      });
    });
  }

  function selectBlock(key) {
    selectedKey = key;
    recordFilter.value = '';
    draw();
    renderDetails();
  }

  function renderDetails() {
    if (!payload || !selectedKey) return;
    const selected = payload.blocks.find(block => block.key === selectedKey);
    if (!selected) return;

    const query = recordFilter.value.trim().toLowerCase();
    const records = (selected.records_preview || []).filter(record => {
      if (!query) return true;
      return [record.label, record.locus_tag, record.product, record.effect, record.aa_change]
        .join(' ')
        .toLowerCase()
        .includes(query);
    });
    const effectOrder = ['protein-changing', 'synonymous', 'regulatory/flanking', 'other'];
    const effectCounts = effectOrder.map(effect => `
      <div class="mutation-count-card">
        <span>${escapeHtml(effectNames[effect])}</span>
        <strong>${Number(selected.effect_counts[effect] || 0).toLocaleString()}</strong>
      </div>
    `).join('');
    const topGenes = selected.top_genes.map(gene => `
      <li><strong>${escapeHtml(gene.label)}</strong> <span>${escapeHtml(gene.locus_tag)}</span><br>
      <small>${escapeHtml(gene.product || 'Product not available')} · n=${gene.count}</small></li>
    `).join('');
    const rows = records.map(record => `
      <tr>
        <td>${escapeHtml(record.label || '–')}</td>
        <td>${escapeHtml(record.locus_tag || 'Intergenic/NA')}</td>
        <td>${escapeHtml(record.product || 'Product not available')}</td>
        <td>${escapeHtml(effectNames[record.effect] || record.effect)}</td>
        <td>${escapeHtml(record.aa_change || '–')}</td>
        <td>${record.count}</td>
      </tr>
    `).join('');

    details.innerHTML = `
      <span class="mutation-group-badge ${selected.group === 'ESL2.5' ? 'is-esl' : 'is-other'}">${escapeHtml(selected.group)}</span>
      <h2>${formatNumber(selected.start)}-${formatNumber(selected.end)} bp</h2>
      <p class="mutation-window-summary">
        ${selected.count.toLocaleString()} mutation records; ${selected.density.toFixed(2)}% of the lineage-group total.
      </p>
      <div class="mutation-count-grid">${effectCounts}</div>
      <h3>Most frequently annotated genes</h3>
      <ol class="mutation-gene-list">${topGenes || '<li>No gene annotation available.</li>'}</ol>
      <h3>Aggregated annotations</h3>
      <p class="mutation-table-note">
        Showing ${records.length} summary rows${query ? ' matching the filter' : ''}; the selected window contains
        ${selected.record_count.toLocaleString()} per-site records. Use the download link for the complete table.
      </p>
      <div class="mutation-table-wrap">
        <table>
          <thead><tr><th>Label</th><th>Locus tag</th><th>Product</th><th>Effect</th><th>AA change</th><th>Count</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="6">No records match this filter.</td></tr>'}</tbody>
        </table>
      </div>
    `;
  }

  function formatNumber(value) {
    return Number(value).toLocaleString('en-US');
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
  }
})();
