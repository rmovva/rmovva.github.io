const searchInput = document.getElementById('searchInput');
const queryChips = document.getElementById('queryChips');
const statusText = document.getElementById('statusText');
const trailBar = document.getElementById('trailBar');
const lookupBody = document.getElementById('lookupBody');
const neighborsBody = document.getElementById('neighborsBody');
const hoverTooltip = document.getElementById('hoverTooltip');

const DATA_BASE = './data';
const STOPWORDS = new Set([
  'a', 'an', 'and', 'any', 'as', 'at', 'be', 'by', 'for', 'from', 'in',
  'into', 'is', 'it', 'its', 'of', 'on', 'or', 'other', 'that', 'the',
  'their', 'this', 'to', 'usually', 'with',
]);
const BAD_DEFINITION_PREFIXES = [
  'plural of ',
  'alternative form of ',
  'alternative spelling of ',
  'alternative letter-case form of ',
  'simple past of ',
  'past participle of ',
];
const ALLOWED_POS = new Set(['noun', 'verb', 'adj', 'adv']);

const dataStore = {
  meta: null,
  senses: [],
  sortedWords: [],
  wordToSenseIndices: {},
  wordToFilteredSenseIndices: {},
  senseIdToIndex: new Map(),
  neighborIds: null,
  neighborScores: null,
  neighborRowCache: new Map(),
  neighborScoreCache: new Map(),
  neighborCanonicalSetCache: new Map(),
};

const state = {
  ready: false,
  entries: [],
  queryWords: [],
  trail: [],
  activeTrailIndex: -1,
  lookupRequestId: 0,
  neighborRequestId: 0,
};

let tooltipTimer = null;
let tooltipTarget = null;

async function boot() {
  statusText.textContent = 'loading index...';
  try {
    const [metaRes, sensesRes, lemmasRes, neighborIdsRes, neighborScoresRes] = await Promise.all([
      fetch(`${DATA_BASE}/meta.json`),
      fetch(`${DATA_BASE}/senses.json`),
      fetch(`${DATA_BASE}/lemmas.json`),
      fetch(`${DATA_BASE}/neighbor_ids.bin`),
      fetch(`${DATA_BASE}/neighbor_scores.bin`),
    ]);

    if (!metaRes.ok || !sensesRes.ok || !lemmasRes.ok || !neighborIdsRes.ok || !neighborScoresRes.ok) {
      throw new Error('Static dictionary files are unavailable.');
    }

    dataStore.meta = await metaRes.json();
    const rawSenses = await sensesRes.json();
    const lemmas = await lemmasRes.json();
    dataStore.sortedWords = lemmas.sorted_words || [];
    dataStore.wordToSenseIndices = lemmas.word_to_sense_indices || {};
    dataStore.wordToFilteredSenseIndices = lemmas.word_to_filtered_sense_indices || {};
    dataStore.neighborIds = new Uint32Array(await neighborIdsRes.arrayBuffer());
    dataStore.neighborScores = new Uint16Array(await neighborScoresRes.arrayBuffer());

    dataStore.senses = rawSenses.map((rawSense, index) => {
      const sense = {
        index,
        senseId: rawSense[0],
        word: rawSense[1],
        pos: rawSense[2],
        definition: rawSense[3],
        example: rawSense[4],
        exampleRef: rawSense[5],
        zipf: rawSense[6] || 0,
      };
      sense.canonical = canonicalLemma(sense.word);
      sense.keywords = keywordSet(sense.definition);
      dataStore.senseIdToIndex.set(sense.senseId, index);
      return sense;
    });

    state.ready = true;
    statusText.textContent = `${dataStore.meta.lemma_count} lemmas · ${dataStore.meta.sense_count} senses`;
  } catch (error) {
    console.error(error);
    statusText.textContent = 'index unavailable';
    lookupBody.innerHTML = '<div class="empty">Static data failed to load.</div>';
  }
}

searchInput.addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    event.preventDefault();
    submitSearchInput();
  } else if (event.key === 'Backspace' && !searchInput.value.trim() && state.queryWords.length) {
    event.preventDefault();
    removeQueryWord(state.queryWords[state.queryWords.length - 1]);
  }
});

function canonicalLemma(word) {
  const lowered = word.toLowerCase().trim();
  if (lowered.length > 4 && lowered.endsWith('ies')) {
    return `${lowered.slice(0, -3)}y`;
  }
  if (lowered.length > 4 && /(ches|shes|xes|zes|sses)$/.test(lowered)) {
    return lowered.slice(0, -2);
  }
  if (lowered.length > 3 && lowered.endsWith('s') && !lowered.endsWith('ss')) {
    return lowered.slice(0, -1);
  }
  return lowered;
}

function normalizeToken(token) {
  if (token.length > 4 && token.endsWith('ies')) {
    return `${token.slice(0, -3)}y`;
  }
  if (token.length > 4 && /(ches|shes|xes|zes|sses)$/.test(token)) {
    return token.slice(0, -2);
  }
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) {
    return token.slice(0, -1);
  }
  return token;
}

function keywordSet(text) {
  const keywords = new Set();
  const matches = text.toLowerCase().match(/[a-z]+/g) || [];
  for (const token of matches) {
    if (token.length < 4 || STOPWORDS.has(token)) {
      continue;
    }
    keywords.add(normalizeToken(token));
  }
  return keywords;
}

function isBadDefinition(definition) {
  const lowered = definition.toLowerCase();
  return BAD_DEFINITION_PREFIXES.some(prefix => lowered.startsWith(prefix));
}

function normalizeWords(parts) {
  const words = [];
  const seen = new Set();
  for (const rawPart of parts) {
    const word = rawPart.trim().toLowerCase();
    if (!word || seen.has(word)) {
      continue;
    }
    seen.add(word);
    words.push(word);
  }
  return words;
}

function parseInputWords(text) {
  const trimmed = text.trim();
  return trimmed ? [trimmed] : [];
}

function renderQueryChips() {
  searchInput.placeholder = state.queryWords.length ? '' : 'geode';
  queryChips.innerHTML = state.queryWords.map(word => `
    <span class="query-chip">
      <span>${escapeHtml(word)}</span>
      <button class="chip-remove" type="button" onclick="removeQueryWord('${escapeAttr(word)}')" aria-label="Remove ${escapeAttr(word)}">x</button>
    </span>
  `).join('');
}

function currentPreferredSenseMap() {
  const preferred = {};
  for (const entry of state.entries) {
    if (entry.selectedSenseId) {
      preferred[entry.query] = entry.selectedSenseId;
    }
  }
  return preferred;
}

function sameSnapshot(left, right) {
  if (!left || !right) {
    return false;
  }
  if (left.queryWords.length !== right.queryWords.length) {
    return false;
  }
  for (let i = 0; i < left.queryWords.length; i += 1) {
    if (left.queryWords[i] !== right.queryWords[i]) {
      return false;
    }
  }
  const leftKeys = Object.keys(left.preferredSenseIdMap).sort();
  const rightKeys = Object.keys(right.preferredSenseIdMap).sort();
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  for (let i = 0; i < leftKeys.length; i += 1) {
    if (leftKeys[i] !== rightKeys[i]) {
      return false;
    }
    if (left.preferredSenseIdMap[leftKeys[i]] !== right.preferredSenseIdMap[rightKeys[i]]) {
      return false;
    }
  }
  return true;
}

function trailLabel(item) {
  return item.queryWords.join(' + ');
}

function renderTrail() {
  if (!state.trail.length) {
    trailBar.innerHTML = '';
    return;
  }

  let html = '';
  state.trail.forEach((item, index) => {
    if (index > 0) {
      html += '<span class="trail-arrow">→</span>';
    }
    const active = index === state.activeTrailIndex ? ' active' : '';
    html += `
      <button class="trail-step${active}" type="button" onclick="restoreTrail(${index})">
        ${escapeHtml(trailLabel(item))}
      </button>`;
  });
  trailBar.innerHTML = html;

  const activeStep = trailBar.querySelector('.trail-step.active') || trailBar.lastElementChild;
  if (activeStep) {
    requestAnimationFrame(() => {
      activeStep.scrollIntoView({ behavior: 'smooth', inline: 'end', block: 'nearest' });
    });
  }
}

function positionTooltip(clientX, clientY) {
  const offset = 14;
  const maxX = window.innerWidth - hoverTooltip.offsetWidth - 12;
  const maxY = window.innerHeight - hoverTooltip.offsetHeight - 12;
  const left = Math.min(clientX + offset, Math.max(12, maxX));
  const top = Math.min(clientY + offset, Math.max(12, maxY));
  hoverTooltip.style.left = `${left}px`;
  hoverTooltip.style.top = `${top}px`;
}

function showTooltip(text, clientX, clientY) {
  hoverTooltip.textContent = text;
  hoverTooltip.hidden = false;
  positionTooltip(clientX, clientY);
  requestAnimationFrame(() => {
    hoverTooltip.classList.add('visible');
  });
}

function hideTooltip() {
  clearTimeout(tooltipTimer);
  tooltipTimer = null;
  tooltipTarget = null;
  hoverTooltip.classList.remove('visible');
  hoverTooltip.hidden = true;
}

function commitTrail(mode) {
  if (mode === 'none' || !state.queryWords.length) {
    renderTrail();
    return;
  }

  const snapshot = {
    queryWords: [...state.queryWords],
    preferredSenseIdMap: currentPreferredSenseMap(),
  };

  if (mode === 'replace' && state.activeTrailIndex >= 0) {
    state.trail[state.activeTrailIndex] = snapshot;
    renderTrail();
    return;
  }

  state.trail = state.trail.slice(0, state.activeTrailIndex + 1);
  const current = state.trail[state.trail.length - 1];
  if (sameSnapshot(current, snapshot)) {
    state.activeTrailIndex = state.trail.length - 1;
    renderTrail();
    return;
  }

  state.trail.push(snapshot);
  state.activeTrailIndex = state.trail.length - 1;
  renderTrail();
}

function resetPanels() {
  state.lookupRequestId += 1;
  state.neighborRequestId += 1;
  lookupBody.innerHTML = '<div class="empty">Start with a word.</div>';
  neighborsBody.innerHTML = '<div class="empty">Pick a sense to explore its neighborhood.</div>';
  state.entries = [];
}

function submitSearchInput() {
  const newWords = parseInputWords(searchInput.value);
  if (!newWords.length) {
    if (state.queryWords.length) {
      runLookupWords(state.queryWords);
    }
    return;
  }

  state.queryWords = normalizeWords([...state.queryWords, ...newWords]);
  searchInput.value = '';
  renderQueryChips();
  runLookupWords(state.queryWords);
}

function serializeSenseByIndex(index, includeScore = false, score = null) {
  const sense = dataStore.senses[index];
  const payload = {
    sense_id: sense.senseId,
    word: sense.word,
    pos: sense.pos,
    definition: sense.definition,
  };
  if (sense.example) {
    payload.example = sense.example;
  }
  if (sense.exampleRef) {
    payload.example_ref = sense.exampleRef;
  }
  if (sense.zipf != null) {
    payload.zipf = sense.zipf;
  }
  if (includeScore && score != null) {
    payload.score = score;
  }
  return payload;
}

function lookupWord(query) {
  const lowered = query.toLowerCase().trim();
  if (!lowered) {
    return { resolvedWord: null, senseIndices: [] };
  }
  const candidates = [lowered];
  const canonical = canonicalLemma(lowered);
  if (canonical !== lowered) {
    candidates.push(canonical);
  }
  for (const candidate of candidates) {
    if (dataStore.wordToSenseIndices[candidate]) {
      const filtered = dataStore.wordToFilteredSenseIndices[candidate] || dataStore.wordToSenseIndices[candidate];
      return { resolvedWord: candidate, senseIndices: filtered };
    }
  }
  return { resolvedWord: null, senseIndices: [] };
}

function prefixSuggestions(query, limit = 12) {
  const lowered = query.toLowerCase().trim();
  if (!lowered) {
    return [];
  }
  let left = 0;
  let right = dataStore.sortedWords.length;
  while (left < right) {
    const middle = Math.floor((left + right) / 2);
    if (dataStore.sortedWords[middle] < lowered) {
      left = middle + 1;
    } else {
      right = middle;
    }
  }
  const suggestions = [];
  for (let index = left; index < dataStore.sortedWords.length; index += 1) {
    const word = dataStore.sortedWords[index];
    if (!word.startsWith(lowered)) {
      break;
    }
    const senseIndices = dataStore.wordToFilteredSenseIndices[word] || dataStore.wordToSenseIndices[word] || [];
    suggestions.push({
      word,
      sense_count: senseIndices.length,
    });
    if (suggestions.length >= limit) {
      break;
    }
  }
  return suggestions;
}

function neighborRowEntries(senseIndex) {
  if (dataStore.neighborRowCache.has(senseIndex)) {
    return dataStore.neighborRowCache.get(senseIndex);
  }
  const entries = [];
  const start = senseIndex * dataStore.meta.top_k;
  const end = start + dataStore.meta.top_k;
  for (let offset = start; offset < end; offset += 1) {
    const neighborIndex = dataStore.neighborIds[offset];
    if (neighborIndex === dataStore.meta.missing_neighbor) {
      continue;
    }
    entries.push({
      idx: neighborIndex,
      score: dataStore.neighborScores[offset] / dataStore.meta.score_scale,
    });
  }
  dataStore.neighborRowCache.set(senseIndex, entries);
  return entries;
}

function neighborScoreMap(senseIndex) {
  if (dataStore.neighborScoreCache.has(senseIndex)) {
    return dataStore.neighborScoreCache.get(senseIndex);
  }
  const scoreMap = new Map();
  for (const entry of neighborRowEntries(senseIndex)) {
    scoreMap.set(entry.idx, entry.score);
  }
  dataStore.neighborScoreCache.set(senseIndex, scoreMap);
  return scoreMap;
}

function neighborCanonicalSet(senseIndex, limit = 16) {
  const cacheKey = `${senseIndex}:${limit}`;
  if (dataStore.neighborCanonicalSetCache.has(cacheKey)) {
    return dataStore.neighborCanonicalSetCache.get(cacheKey);
  }
  const canonicalSet = new Set();
  for (const entry of neighborRowEntries(senseIndex).slice(0, limit)) {
    canonicalSet.add(dataStore.senses[entry.idx].canonical);
  }
  dataStore.neighborCanonicalSetCache.set(cacheKey, canonicalSet);
  return canonicalSet;
}

function setOverlapRatio(leftSet, rightSet) {
  if (!leftSet.size || !rightSet.size) {
    return 0;
  }
  let overlap = 0;
  for (const value of leftSet) {
    if (rightSet.has(value)) {
      overlap += 1;
    }
  }
  return overlap / Math.max(1, Math.min(leftSet.size, rightSet.size));
}

function posCompatibility(leftPos, rightPos) {
  if (leftPos === rightPos) {
    return 0.18;
  }
  if ((leftPos === 'noun' && rightPos === 'adj') || (leftPos === 'adj' && rightPos === 'noun')) {
    return 0.06;
  }
  if ((leftPos === 'adj' && rightPos === 'adv') || (leftPos === 'adv' && rightPos === 'adj')) {
    return 0.03;
  }
  return -0.05;
}

function candidateKeywordBonus(sourceKeywords, candidateKeywords) {
  const leftSize = sourceKeywords.size;
  const rightSize = candidateKeywords.size;
  let shared = 0;
  for (const keyword of sourceKeywords) {
    if (candidateKeywords.has(keyword)) {
      shared += 1;
    }
  }
  let overlapBonus = 0.08 * (shared / Math.max(1, Math.min(leftSize, rightSize || 1)));
  if (!shared && rightSize <= 2) {
    overlapBonus -= 0.08;
  }
  return overlapBonus;
}

function pairAffinity(leftIdx, rightIdx) {
  const left = dataStore.senses[leftIdx];
  const right = dataStore.senses[rightIdx];
  const leftDirect = neighborScoreMap(leftIdx).get(rightIdx) || 0;
  const rightDirect = neighborScoreMap(rightIdx).get(leftIdx) || 0;
  const neighborOverlap = setOverlapRatio(neighborCanonicalSet(leftIdx), neighborCanonicalSet(rightIdx));
  const keywordOverlap = setOverlapRatio(left.keywords, right.keywords);
  const meanZipf = (left.zipf + right.zipf) / 2;
  return (
    (leftDirect + rightDirect) * 0.95
    + neighborOverlap * 0.9
    + keywordOverlap * 0.65
    + posCompatibility(left.pos, right.pos)
    + meanZipf * 0.018
  );
}

function selfReferencePenalty(sense) {
  const loweredDefinition = sense.definition.toLowerCase();
  const loweredWord = sense.word.toLowerCase();
  const canonical = sense.canonical;
  const exactPattern = new RegExp(`\\b${escapeRegExp(loweredWord)}\\b`);
  const canonicalPattern = canonical !== loweredWord
    ? new RegExp(`\\b${escapeRegExp(canonical)}\\b`)
    : null;
  if (exactPattern.test(loweredDefinition)) {
    return 2.0;
  }
  if (canonicalPattern && canonicalPattern.test(loweredDefinition)) {
    return 1.5;
  }
  return 0;
}

function combinationScore(sourceIndices) {
  if (!sourceIndices.length) {
    return Number.NEGATIVE_INFINITY;
  }
  if (sourceIndices.length === 1) {
    return dataStore.senses[sourceIndices[0]].zipf * 0.02;
  }

  const pairScores = [];
  const keywordScores = [];
  let posMatches = 0;
  let pairCount = 0;

  for (let i = 0; i < sourceIndices.length; i += 1) {
    for (let j = i + 1; j < sourceIndices.length; j += 1) {
      const leftIdx = sourceIndices[i];
      const rightIdx = sourceIndices[j];
      const left = dataStore.senses[leftIdx];
      const right = dataStore.senses[rightIdx];
      pairScores.push(pairAffinity(leftIdx, rightIdx));
      keywordScores.push(setOverlapRatio(left.keywords, right.keywords));
      pairCount += 1;
      if (left.pos === right.pos) {
        posMatches += 1;
      }
    }
  }

  const meanPair = pairScores.length ? pairScores.reduce((sum, value) => sum + value, 0) / pairScores.length : 0;
  const meanKeyword = keywordScores.length ? keywordScores.reduce((sum, value) => sum + value, 0) / keywordScores.length : 0;
  const posRatio = posMatches / Math.max(1, pairCount);
  const meanZipf = sourceIndices.reduce((sum, index) => sum + dataStore.senses[index].zipf, 0) / sourceIndices.length;
  const selfReferenceCost = sourceIndices.reduce((sum, index) => sum + selfReferencePenalty(dataStore.senses[index]), 0);
  const neighborQuality = combinationNeighborQuality(sourceIndices);
  return (
    meanPair * 1.25
    + meanKeyword * 0.45
    + posRatio * 0.16
    + meanZipf * 0.015
    + neighborQuality * 0.42
    - selfReferenceCost
  );
}

function combinationNeighborQuality(sourceIndices) {
  const ranked = scoreCandidateMap(collectCandidateMap(sourceIndices), sourceIndices);
  const topStrict = ranked.strict.slice(0, 6);
  const topTheme = ranked.theme.slice(0, Math.max(0, 6 - topStrict.length));
  const combined = [...topStrict, ...topTheme];
  if (!combined.length) {
    return -0.5;
  }

  const strictCoverage = topStrict.filter(item => item.coverage_count >= Math.min(2, sourceIndices.length)).length;
  const meanTopScore = combined.reduce((sum, item) => sum + item.score, 0) / combined.length;
  const fullCoverage = combined.filter(item => item.coverage_count === sourceIndices.length).length;

  return (
    strictCoverage * 0.35
    + fullCoverage * 0.25
    + meanTopScore * 0.2
  );
}

function chooseDefaultCombination(senseGroups) {
  const validGroups = senseGroups.filter(group => group.length);
  if (!validGroups.length) {
    return [];
  }

  let totalCombinations = 1;
  for (const group of validGroups) {
    totalCombinations *= group.length;
  }

  let bestCombo = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  if (totalCombinations <= 256) {
    const combo = new Array(validGroups.length);
    function visit(position) {
      if (position === validGroups.length) {
        const score = combinationScore(combo);
        if (score > bestScore) {
          bestScore = score;
          bestCombo = [...combo];
        }
        return;
      }
      for (const index of validGroups[position]) {
        combo[position] = index;
        visit(position + 1);
      }
    }
    visit(0);
  } else {
    let beam = [{ combo: [], score: 0 }];
    for (const group of validGroups) {
      const candidates = [];
      for (const partial of beam) {
        for (const index of group) {
          const nextCombo = [...partial.combo, index];
          candidates.push({ combo: nextCombo, score: combinationScore(nextCombo) });
        }
      }
      candidates.sort((left, right) => right.score - left.score);
      beam = candidates.slice(0, 24);
    }
    if (beam.length) {
      bestCombo = beam[0].combo;
    }
  }

  return bestCombo || validGroups.map(group => group[0]);
}

async function runLookupWords(words, preferredSenseIdMap = {}, options = {}) {
  if (!state.ready) {
    return;
  }
  const requestedWords = normalizeWords(words);
  if (!requestedWords.length) {
    return;
  }

  const trailMode = options.trailMode ?? 'push';
  const lookupRequestId = state.lookupRequestId + 1;
  state.lookupRequestId = lookupRequestId;
  state.queryWords = requestedWords;
  renderQueryChips();

  lookupBody.innerHTML = '<div class="empty">Looking up dictionary senses...</div>';
  neighborsBody.innerHTML = '<div class="empty">Pick a sense to explore its neighborhood.</div>';
  state.entries = [];

  const responses = requestedWords.map(word => {
    const { resolvedWord, senseIndices } = lookupWord(word);
    if (resolvedWord) {
      return {
        query: word,
        resolved_word: resolvedWord,
        senses: senseIndices.map(index => serializeSenseByIndex(index)),
        suggestions: [],
      };
    }
    return {
      query: word,
      resolved_word: null,
      senses: [],
      suggestions: prefixSuggestions(word),
    };
  });

  if (lookupRequestId !== state.lookupRequestId) {
    return;
  }

  let recommendedSenseIds = [];
  const hasExplicitPreferences = Object.keys(preferredSenseIdMap).length > 0;
  if (!hasExplicitPreferences) {
    const senseGroups = [];
    const validPositions = [];
    responses.forEach((response, position) => {
      const group = (response.senses || [])
        .map(sense => dataStore.senseIdToIndex.get(sense.sense_id))
        .filter(index => index != null);
      senseGroups.push(group);
      if (group.length) {
        validPositions.push(position);
      }
    });
    if (validPositions.length > 1) {
      const chosenIndices = chooseDefaultCombination(senseGroups);
      recommendedSenseIds = new Array(responses.length).fill(null);
      chosenIndices.forEach((senseIndex, groupPosition) => {
        const responsePosition = validPositions[groupPosition];
        recommendedSenseIds[responsePosition] = dataStore.senses[senseIndex].senseId;
      });
    }
  }

  state.entries = responses.map((response, index) => {
    const preferredSenseId = preferredSenseIdMap[requestedWords[index]];
    const recommendedSenseId = recommendedSenseIds[index];
    const selectedSense = response.senses.length
      ? (
        response.senses.find(sense => sense.sense_id === preferredSenseId)
        || response.senses.find(sense => sense.sense_id === recommendedSenseId)
        || response.senses[0]
      )
      : null;
    return {
      query: requestedWords[index],
      resolvedWord: response.resolved_word,
      senses: response.senses || [],
      suggestions: response.suggestions || [],
      selectedSenseId: selectedSense ? selectedSense.sense_id : null,
    };
  });

  renderLookupResults();

  const readyEntries = state.entries.filter(entry => entry.selectedSenseId);
  if (!readyEntries.length) {
    neighborsBody.innerHTML = '<div class="empty">No dictionary entry found for that query.</div>';
    return;
  }

  computeNeighbors();
  commitTrail(trailMode);
}

function renderLookupResults() {
  if (!state.entries.length) {
    lookupBody.innerHTML = '<div class="empty">Start with a word.</div>';
    return;
  }

  let html = '';
  for (const entry of state.entries) {
    html += '<div class="word-group">';
    html += `
      <div class="group-head">
        <div class="group-word">${escapeHtml(entry.resolvedWord || entry.query)}</div>
        ${entry.senses.length ? `<div class="score">${entry.senses.length} sense${entry.senses.length === 1 ? '' : 's'}</div>` : ''}
      </div>`;

    if (entry.senses.length) {
      html += '<div class="sense-grid">';
      for (const sense of entry.senses) {
        const selected = entry.selectedSenseId === sense.sense_id ? ' selected' : '';
        html += `
          <article class="card clickable${selected}" onclick="pickSense('${escapeAttr(entry.query)}', '${escapeAttr(sense.sense_id)}')">
            <div class="wordline">
              <div class="word">${escapeHtml(sense.word)}</div>
              <div class="pos">${escapeHtml(sense.pos)}</div>
            </div>
            <div class="definition">${escapeHtml(sense.definition)}</div>
          </article>`;
      }
      html += '</div>';
    } else if (entry.suggestions.length) {
      html += '<div class="section-note">No exact match. Try one of these nearby lemmas.</div>';
      html += '<div class="suggestion-grid">';
      for (const suggestion of entry.suggestions) {
        html += `
          <button class="pill" onclick="pickSuggestion('${escapeAttr(entry.query)}', '${escapeAttr(suggestion.word)}')">
            <span>${escapeHtml(suggestion.word)}</span>
            <span class="score">${suggestion.sense_count} senses</span>
          </button>`;
      }
      html += '</div>';
    } else {
      html += '<div class="empty">No dictionary entry found for this word.</div>';
    }

    html += '</div>';
  }
  lookupBody.innerHTML = html;
}

function scoreCandidateMap(candidateMap, sourceIndices) {
  const sourceKeywords = new Set();
  const posCounts = new Map();
  for (const sourceIndex of sourceIndices) {
    for (const keyword of dataStore.senses[sourceIndex].keywords) {
      sourceKeywords.add(keyword);
    }
    const pos = dataStore.senses[sourceIndex].pos;
    posCounts.set(pos, (posCounts.get(pos) || 0) + 1);
  }

  let majorityPos = 'noun';
  let majorityCount = -1;
  for (const [pos, count] of posCounts) {
    if (count > majorityCount) {
      majorityPos = pos;
      majorityCount = count;
    }
  }

  const strict = [];
  const theme = [];

  for (const [candidateIdx, item] of candidateMap) {
    if (sourceIndices.includes(candidateIdx)) {
      continue;
    }
    const candidate = dataStore.senses[candidateIdx];
    if (!ALLOWED_POS.has(candidate.pos) || isBadDefinition(candidate.definition)) {
      continue;
    }

    const scores = item.scores;
    const coverageCount = scores.filter(score => score >= 0.22).length;
    const meanScore = scores.reduce((sum, value) => sum + value, 0) / scores.length;
    const minScore = Math.min(...scores);
    const maxScore = Math.max(...scores);
    const spreadPenalty = maxScore - minScore;
    const freqBonus = Math.max(0, Math.min(candidate.zipf, 5.5) - 2.0) * 0.04;
    const posMatchBonus = candidate.pos === majorityPos ? 0.08 : 0;
    const overlapBonus = candidateKeywordBonus(sourceKeywords, candidate.keywords);

    const strictMinimumCoverage = sourceIndices.length === 1 ? 1 : Math.min(2, sourceIndices.length);
    if (coverageCount >= strictMinimumCoverage) {
      strict.push({
        idx: candidateIdx,
        score: coverageCount * 2.0 + minScore * 1.15 + meanScore * 0.95 - spreadPenalty * 0.25 + freqBonus + posMatchBonus + overlapBonus,
        coverage_count: coverageCount,
        coverage_total: sourceIndices.length,
        mean_similarity: meanScore,
        min_similarity: minScore,
      });
      continue;
    }

    if (coverageCount > 0) {
      theme.push({
        idx: candidateIdx,
        score: meanScore * 1.35 + maxScore * 0.35 + coverageCount * 0.5 + freqBonus + posMatchBonus + overlapBonus,
        coverage_count: coverageCount,
        coverage_total: sourceIndices.length,
        mean_similarity: meanScore,
        min_similarity: minScore,
        theme_backfill: true,
      });
    }
  }

  strict.sort((left, right) => right.score - left.score);
  theme.sort((left, right) => right.score - left.score);
  return { strict, theme };
}

function collectCandidateMap(sourceIndices) {
  const candidateMap = new Map();
  const sourceCount = sourceIndices.length;
  const registerScore = (candidateIdx, sourcePosition, score) => {
    if (score <= 0) {
      return;
    }
    let candidate = candidateMap.get(candidateIdx);
    if (!candidate) {
      candidate = { scores: new Array(sourceCount).fill(0) };
      candidateMap.set(candidateIdx, candidate);
    }
    candidate.scores[sourcePosition] = Math.max(candidate.scores[sourcePosition], score);
  };

  sourceIndices.forEach((sourceIdx, sourcePosition) => {
    const directNeighbors = neighborRowEntries(sourceIdx).slice(0, 28);
    for (const direct of directNeighbors) {
      registerScore(direct.idx, sourcePosition, direct.score);
    }

    const bridgeSeeds = directNeighbors.slice(0, 10);
    for (const seed of bridgeSeeds) {
      const secondaryNeighbors = neighborRowEntries(seed.idx).slice(0, 10);
      for (const bridge of secondaryNeighbors) {
        if (bridge.idx === sourceIdx) {
          continue;
        }
        const bridgedScore = Math.min(seed.score, bridge.score) * 0.58;
        if (bridgedScore < 0.12) {
          continue;
        }
        registerScore(bridge.idx, sourcePosition, bridgedScore);
      }
    }
  });

  return candidateMap;
}

function nearestNeighborsSingle(sourceIndex, limit = 24) {
  const source = dataStore.senses[sourceIndex];
  const seenLemmas = new Set([source.canonical]);
  const neighbors = [];

  for (const entry of neighborRowEntries(sourceIndex)) {
    const candidate = dataStore.senses[entry.idx];
    if (seenLemmas.has(candidate.canonical)) {
      continue;
    }
    if (!ALLOWED_POS.has(candidate.pos) || isBadDefinition(candidate.definition)) {
      continue;
    }
    seenLemmas.add(candidate.canonical);
    neighbors.push(serializeSenseByIndex(entry.idx, true, entry.score));
    if (neighbors.length >= limit) {
      break;
    }
  }

  return {
    source: serializeSenseByIndex(sourceIndex),
    neighbors,
  };
}

function nearestNeighborsMulti(sourceIndices, limit = 24) {
  const sourceLemmas = new Set(sourceIndices.map(index => dataStore.senses[index].canonical));
  const candidateMap = collectCandidateMap(sourceIndices);
  const ranked = scoreCandidateMap(candidateMap, sourceIndices);
  const seenLemmas = new Set(sourceLemmas);
  const results = [];

  for (const bucket of [ranked.strict, ranked.theme]) {
    for (const item of bucket) {
      const candidate = dataStore.senses[item.idx];
      if (seenLemmas.has(candidate.canonical)) {
        continue;
      }
      seenLemmas.add(candidate.canonical);
      const payload = serializeSenseByIndex(item.idx, true, item.score);
      payload.coverage_count = item.coverage_count;
      payload.coverage_total = item.coverage_total;
      payload.mean_similarity = item.mean_similarity;
      payload.min_similarity = item.min_similarity;
      if (item.theme_backfill) {
        payload.theme_backfill = true;
      }
      results.push(payload);
      if (results.length >= limit) {
        return {
          sources: sourceIndices.map(index => serializeSenseByIndex(index)),
          neighbors: results,
        };
      }
    }
  }

  return {
    sources: sourceIndices.map(index => serializeSenseByIndex(index)),
    neighbors: results,
  };
}

function computeNeighbors() {
  const selectedEntries = state.entries.filter(entry => entry.selectedSenseId);
  if (!selectedEntries.length) {
    neighborsBody.innerHTML = '<div class="empty">Pick a sense to explore its neighborhood.</div>';
    return;
  }

  const neighborRequestId = state.neighborRequestId + 1;
  state.neighborRequestId = neighborRequestId;
  neighborsBody.innerHTML = '<div class="empty">Computing nearest neighbors...</div>';

  requestAnimationFrame(() => {
    if (neighborRequestId !== state.neighborRequestId) {
      return;
    }

    if (selectedEntries.length === 1) {
      const sourceIndex = dataStore.senseIdToIndex.get(selectedEntries[0].selectedSenseId);
      if (sourceIndex == null) {
        neighborsBody.innerHTML = '<div class="empty">No neighbors available for that sense.</div>';
        return;
      }
      const data = nearestNeighborsSingle(sourceIndex, 24);
      renderNeighbors([data.source], data.neighbors || []);
      return;
    }

    const sourceIndices = selectedEntries
      .map(entry => dataStore.senseIdToIndex.get(entry.selectedSenseId))
      .filter(index => index != null);
    const data = nearestNeighborsMulti(sourceIndices, 24);
    renderNeighbors(data.sources || [], data.neighbors || []);
  });
}

function pickSense(query, senseId) {
  const entry = state.entries.find(item => item.query === query);
  if (!entry) {
    return;
  }
  entry.selectedSenseId = senseId;
  renderLookupResults();
  commitTrail('replace');
  computeNeighbors();
}

function renderNeighbors(sources, neighbors) {
  const sourceList = Array.isArray(sources) ? sources : [sources];
  let html = '';

  if (sourceList.length > 1) {
    html += '<div class="source-wrap">';
    for (const source of sourceList) {
      html += `<div class="source-bubble" data-tooltip="${escapeAttr(source.definition)}">${escapeHtml(source.word)} · ${escapeHtml(source.pos)}</div>`;
    }
    html += '</div>';
  }

  if (sourceList.length === 1) {
    const source = sourceList[0];
    html += `
      <div class="neighbor-source">
        <div class="wordline">
          <div class="word">${escapeHtml(source.word)}</div>
          <div class="pos">${escapeHtml(source.pos)}</div>
        </div>
        <div class="definition">${escapeHtml(source.definition)}</div>
      </div>`;
  }

  if (!neighbors.length) {
    html += '<div class="empty">No neighbors available for that sense.</div>';
    neighborsBody.innerHTML = html;
    return;
  }

  html += '<div class="bubble-wrap">';
  for (const neighbor of neighbors) {
    const meta = neighbor.coverage_count
      ? `${neighbor.word} (${neighbor.pos}) — ${neighbor.definition} • ${neighbor.coverage_count}/${neighbor.coverage_total} words`
      : `${neighbor.word} (${neighbor.pos}) — ${neighbor.definition}`;
    html += `
      <button
        class="bubble"
        onclick="jumpToWord('${escapeAttr(neighbor.word)}', '${escapeAttr(neighbor.sense_id)}')"
        data-tooltip="${escapeAttr(meta)}"
      >
        ${escapeHtml(neighbor.word)}
      </button>`;
  }
  html += '</div>';

  const exampleSources = sourceList.filter(source => source && source.example);
  if (exampleSources.length) {
    html += '<div class="seed-examples">';
    for (const source of exampleSources) {
      html += `
        <div class="seed-example">
          <strong>${escapeHtml(source.word)}:</strong> ${escapeHtml(source.example)}
          ${source.example_ref ? `<div class="seed-citation">${escapeHtml(source.example_ref)}</div>` : ''}
        </div>`;
    }
    html += '</div>';
  }

  neighborsBody.innerHTML = html;
}

function pickSuggestion(originalWord, suggestedWord) {
  state.queryWords = state.queryWords.map(word => (word === originalWord ? suggestedWord : word));
  state.queryWords = normalizeWords(state.queryWords);
  renderQueryChips();
  runLookupWords(state.queryWords);
}

function removeQueryWord(word) {
  hideTooltip();
  state.queryWords = state.queryWords.filter(item => item !== word);
  renderQueryChips();
  if (!state.queryWords.length) {
    resetPanels();
    return;
  }
  runLookupWords(state.queryWords, {}, { trailMode: 'push' });
}

function jumpToWord(word, preferredSenseId = null) {
  hideTooltip();
  state.queryWords = [word.toLowerCase()];
  searchInput.value = '';
  renderQueryChips();
  const preferredMap = preferredSenseId ? { [word.toLowerCase()]: preferredSenseId } : {};
  runLookupWords(state.queryWords, preferredMap, { trailMode: 'push' });
}

function restoreTrail(index) {
  hideTooltip();
  const item = state.trail[index];
  if (!item) {
    return;
  }
  state.activeTrailIndex = index;
  state.queryWords = [...item.queryWords];
  searchInput.value = '';
  renderQueryChips();
  renderTrail();
  runLookupWords(item.queryWords, item.preferredSenseIdMap, { trailMode: 'none' });
}

document.addEventListener('pointerover', event => {
  const target = event.target.closest('[data-tooltip]');
  if (!target || target === tooltipTarget) {
    return;
  }
  if (target.contains(event.relatedTarget)) {
    return;
  }

  clearTimeout(tooltipTimer);
  tooltipTarget = target;
  const text = target.getAttribute('data-tooltip');
  tooltipTimer = setTimeout(() => {
    if (tooltipTarget !== target || !text) {
      return;
    }
    showTooltip(text, event.clientX, event.clientY);
  }, 150);
});

document.addEventListener('pointermove', event => {
  if (!tooltipTarget || hoverTooltip.hidden) {
    return;
  }
  positionTooltip(event.clientX, event.clientY);
});

document.addEventListener('pointerout', event => {
  const target = event.target.closest('[data-tooltip]');
  if (!target) {
    return;
  }
  if (target.contains(event.relatedTarget)) {
    return;
  }
  if (target !== tooltipTarget) {
    return;
  }
  hideTooltip();
});

window.addEventListener('scroll', hideTooltip, true);

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

window.pickSense = pickSense;
window.pickSuggestion = pickSuggestion;
window.removeQueryWord = removeQueryWord;
window.jumpToWord = jumpToWord;
window.restoreTrail = restoreTrail;

renderQueryChips();
renderTrail();
boot();
