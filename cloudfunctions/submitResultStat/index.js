const tcb = require('@cloudbase/node-sdk');

const app = tcb.init({
  env: tcb.SYMBOL_DEFAULT_ENV
});

const db = app.database();

const OUTER_PERSONA_CODES = Array.from({ length: 16 }, (_, index) => `O${String(index + 1).padStart(2, '0')}`);
const INNER_PERSONA_CODES = Array.from({ length: 16 }, (_, index) => `I${String(index + 1).padStart(2, '0')}`);
const HIDDEN_PERSONA_CODES = ['H01', 'H02', 'H03', 'H07'];
const ATLAS_HIDDEN_PERSONA_CODES = ['H01', 'H02', 'H03'];
const LABEL_AXIS_ORDER = ['X', 'M', 'V', 'T', 'P'];
const LABEL_SIDES = ['left', 'right'];
const COMBO_BADGE_IDS = Array.from({ length: 11 }, (_, index) => `cb${String(index + 1).padStart(2, '0')}`);
const COMBO_BADGE_TIER = 'rainbow';
const PERSONA_TIER_ORDER = ['rainbow', 'color', 'gold', 'silver'];
const RARITY_SCORE_RANGES = {
  silver: { min: 13000, max: 13999 },
  gold: { min: 14000, max: 14999 },
  color: { min: 15000, max: 15999 },
  rainbow: { min: 16000, max: 16750 },
  hidden: { min: 16000, max: 16750 }
};
const STAT_SMOOTHING = {
  outer: { alpha: 20, bucketCount: 16 },
  inner: { alpha: 20, bucketCount: 16 },
  hidden: { alpha: 10, bucketCount: HIDDEN_PERSONA_CODES.length },
  label: { alpha: 10, bucketCount: 10 },
  comboBadge: { alpha: 10, bucketCount: 11 }
};

exports.main = async event => {
  if (event?.action === 'atlasStats') {
    return getAtlasStats();
  }

  const payload = normalizePayload(event);
  if (!payload.resultKey || !payload.outerTypeCode || !payload.innerTypeCode) {
    return {
      ok: false,
      error: 'missing_required_fields'
    };
  }

  const now = Date.now();

  try {
    const metaRef = db.collection('wmti_meta').doc('global');
    const resultRef = db.collection('wmti_results').doc(payload.resultKey);
    const outerRef = db.collection('wmti_personas').doc(`outer:${payload.outerTypeCode}`);
    const innerRef = db.collection('wmti_personas').doc(`inner:${payload.innerTypeCode}`);
    const hiddenRef = payload.hiddenTypeCode ? db.collection('wmti_personas').doc(`hidden:${payload.hiddenTypeCode}`) : null;
    const labelRefs = payload.labels.map(label => db.collection('wmti_labels').doc(`label:${label.axisCode}:${label.side}`));
    const comboBadgeRefs = payload.comboBadges.map(comboBadge => db.collection('wmti_combo_badges').doc(`combo:${comboBadge.id}`));

    const [metaDoc, resultDoc, outerDoc, innerDoc, hiddenDoc, ...statDocs] = await Promise.all([
      getDoc(metaRef),
      getDoc(resultRef),
      getDoc(outerRef),
      getDoc(innerRef),
      hiddenRef ? getDoc(hiddenRef) : Promise.resolve(null),
      ...labelRefs.map(ref => getDoc(ref)),
      ...comboBadgeRefs.map(ref => getDoc(ref))
    ]);
    const labelDocs = statDocs.slice(0, labelRefs.length);
    const comboBadgeDocs = statDocs.slice(labelRefs.length);

    const currentTotal = metaDoc?.total_submissions || 0;
    const nextTotal = currentTotal + 1;

    await writeDoc(metaRef, {
      total_submissions: nextTotal,
      updated_at: now
    });

    const nextResultCount = (resultDoc?.count || 0) + 1;
    await writeDoc(resultRef, {
      outer_type_code: payload.outerTypeCode,
      outer_type_name: payload.outerTypeName,
      inner_type_code: payload.innerTypeCode,
      inner_type_name: payload.innerTypeName,
      hidden_type_code: payload.hiddenTypeCode,
      hidden_type_name: payload.hiddenTypeName,
      count: nextResultCount,
      updated_at: now
    });

    const nextOuterCount = (outerDoc?.count || 0) + 1;
    await writeDoc(outerRef, {
      category: 'outer',
      code: payload.outerTypeCode,
      name: payload.outerTypeName,
      count: nextOuterCount,
      updated_at: now
    });

    const nextInnerCount = (innerDoc?.count || 0) + 1;
    await writeDoc(innerRef, {
      category: 'inner',
      code: payload.innerTypeCode,
      name: payload.innerTypeName,
      count: nextInnerCount,
      updated_at: now
    });

    let nextHiddenCount = 0;
    if (hiddenRef) {
      nextHiddenCount = (hiddenDoc?.count || 0) + 1;
      await writeDoc(hiddenRef, {
        category: 'hidden',
        code: payload.hiddenTypeCode,
        name: payload.hiddenTypeName,
        count: nextHiddenCount,
        updated_at: now
      });
    }

    for (let index = 0; index < payload.labels.length; index += 1) {
      const label = payload.labels[index];
      const existingDoc = labelDocs[index];
      const nextCount = (existingDoc?.count || 0) + 1;
      await writeDoc(labelRefs[index], {
        axis_code: label.axisCode,
        side: label.side,
        name: label.name,
        count: nextCount,
        updated_at: now
      });
    }

    for (let index = 0; index < payload.comboBadges.length; index += 1) {
      const comboBadge = payload.comboBadges[index];
      const existingDoc = comboBadgeDocs[index];
      const nextCount = (existingDoc?.count || 0) + 1;
      await writeDoc(comboBadgeRefs[index], {
        id: comboBadge.id,
        name: comboBadge.name,
        count: nextCount,
        updated_at: now
      });
    }

    const [personaDocs, labelAllDocs, comboBadgeAllDocs] = await Promise.all([
      getCollectionDocs('wmti_personas'),
      getCollectionDocs('wmti_labels'),
      getCollectionDocs('wmti_combo_badges')
    ]);

    const personaMap = new Map(
      personaDocs
        .filter(doc => doc?.category && doc?.code)
        .map(doc => [`${doc.category}:${doc.code}`, doc])
    );
    const labelMap = new Map(
      labelAllDocs
        .filter(doc => doc?.axis_code && doc?.side)
        .map(doc => [`${doc.axis_code}:${doc.side}`, doc])
    );
    const comboBadgeMap = new Map(
      comboBadgeAllDocs
        .filter(doc => doc?.id)
        .map(doc => [doc.id, doc])
    );

    const outerPresentationMap = buildPersonaPresentationMap('outer', OUTER_PERSONA_CODES, personaMap, nextTotal);
    const innerPresentationMap = buildPersonaPresentationMap('inner', INNER_PERSONA_CODES, personaMap, nextTotal);
    const hiddenPresentationMap = buildHiddenPresentationMap(HIDDEN_PERSONA_CODES, personaMap, nextTotal);
    const labelPresentationMap = buildLabelPresentationMap(labelMap, nextTotal);
    const comboBadgePresentationMap = buildComboBadgePresentationMap(comboBadgeMap, payload.comboBadges, nextTotal);
    const labelStats = payload.labels.map(label => {
      const key = `${label.axisCode}:${label.side}`;
      const doc = labelMap.get(key);
      const count = doc?.count || 0;
      const presentation = labelPresentationMap.get(key) || {
        tier: 'silver',
        rarityScore: midpointScore('silver')
      };
      return {
        axisCode: label.axisCode,
        side: label.side,
        name: label.name,
        rank: count,
        percent: toPercent(count, nextTotal),
        tier: presentation.tier,
        rarityScore: presentation.rarityScore
      };
    });
    const comboBadgeStats = payload.comboBadges.map(comboBadge => buildComboBadgeStat(comboBadge, comboBadgeMap, nextTotal, comboBadgePresentationMap));

    const result = {
      total: nextTotal,
      resultStat: {
        rank: nextResultCount,
        percent: toPercent(nextResultCount, nextTotal)
      },
      personaStats: {
        outer: buildPersonaStat('outer', payload.outerTypeCode, personaMap, nextTotal, outerPresentationMap),
        inner: buildPersonaStat('inner', payload.innerTypeCode, personaMap, nextTotal, innerPresentationMap),
        hidden: payload.hiddenTypeCode
          ? buildHiddenPersonaStat(payload.hiddenTypeCode, personaMap, nextTotal, hiddenPresentationMap)
          : null
      },
      labelStats,
      comboBadgeStats
    };

    return {
      ok: true,
      ...result
    };
  } catch (error) {
    console.error('submitResultStat failed', error);
    return {
      ok: false,
      error: error.message || 'transaction_failed'
    };
  }
};

function normalizePayload(event) {
  const labels = Array.isArray(event?.labels)
    ? event.labels
        .filter(label => label?.axisCode && label?.side && label?.name)
        .map(label => ({
          axisCode: label.axisCode,
          side: label.side,
          name: label.name
        }))
    : [];
  const comboBadges = Array.isArray(event?.comboBadges)
    ? event.comboBadges
        .filter(comboBadge => comboBadge?.id && comboBadge?.name)
        .map(comboBadge => ({
          id: String(comboBadge.id),
          name: String(comboBadge.name)
        }))
    : [];

  return {
    resultKey: event?.resultKey || '',
    outerTypeCode: event?.outerTypeCode || '',
    outerTypeName: event?.outerTypeName || '',
    innerTypeCode: event?.innerTypeCode || '',
    innerTypeName: event?.innerTypeName || '',
    hiddenTypeCode: event?.hiddenTypeCode || '',
    hiddenTypeName: event?.hiddenTypeName || '',
    labels,
    comboBadges
  };
}

async function getDoc(ref) {
  try {
    const result = await ref.get();
    const data = result?.data;
    if (Array.isArray(data)) return data[0] || null;
    return data || null;
  } catch (error) {
    return null;
  }
}

async function getCollectionDocs(collectionName) {
  try {
    const result = await db.collection(collectionName).limit(100).get();
    const data = result?.data;
    return Array.isArray(data) ? data : [];
  } catch (error) {
    return [];
  }
}

async function writeDoc(ref, data) {
  await ref.set(data);
}

async function getAtlasStats() {
  try {
    const [metaDoc, personaDocs, labelDocs, comboBadgeDocs] = await Promise.all([
      getDoc(db.collection('wmti_meta').doc('global')),
      getCollectionDocs('wmti_personas'),
      getCollectionDocs('wmti_labels'),
      getCollectionDocs('wmti_combo_badges')
    ]);

    const total = metaDoc?.total_submissions || 0;
    const personaMap = new Map(
      personaDocs
        .filter(doc => doc?.category && doc?.code)
        .map(doc => [`${doc.category}:${doc.code}`, doc])
    );
    const labelMap = new Map(
      labelDocs
        .filter(doc => doc?.axis_code && doc?.side)
        .map(doc => [`${doc.axis_code}:${doc.side}`, doc])
    );
    const comboBadgeMap = new Map(
      comboBadgeDocs
        .filter(doc => doc?.id)
        .map(doc => [doc.id, doc])
    );

    const outerPresentationMap = buildPersonaPresentationMap('outer', OUTER_PERSONA_CODES, personaMap, total);
    const innerPresentationMap = buildPersonaPresentationMap('inner', INNER_PERSONA_CODES, personaMap, total);
    const hiddenPresentationMap = buildHiddenPresentationMap(HIDDEN_PERSONA_CODES, personaMap, total);
    const labelPresentationMap = buildLabelPresentationMap(labelMap, total);
    const comboBadgePresentationMap = buildComboBadgePresentationMap(
      comboBadgeMap,
      COMBO_BADGE_IDS.map(id => ({ id })),
      total
    );

    return {
      ok: true,
      total,
      personaStats: {
        outer: OUTER_PERSONA_CODES.map(code => buildAtlasPersonaStat('outer', code, personaMap, total, outerPresentationMap)),
        inner: INNER_PERSONA_CODES.map(code => buildAtlasPersonaStat('inner', code, personaMap, total, innerPresentationMap)),
        hidden: ATLAS_HIDDEN_PERSONA_CODES.map(code => buildAtlasPersonaStat('hidden', code, personaMap, total, hiddenPresentationMap))
      },
      labelStats: LABEL_AXIS_ORDER.flatMap(axisCode => LABEL_SIDES.map(side => {
        const key = `${axisCode}:${side}`;
        const doc = labelMap.get(key);
        const count = doc?.count || 0;
        const presentation = labelPresentationMap.get(key) || {
          tier: 'silver',
          rarityScore: midpointScore('silver')
        };
        return {
          axisCode,
          side,
          name: doc?.name || '',
          rank: count,
          percent: toPercent(count, total),
          tier: presentation.tier,
          rarityScore: presentation.rarityScore
        };
      })),
      comboBadgeStats: COMBO_BADGE_IDS.map(id => {
        const doc = comboBadgeMap.get(id);
        const count = doc?.count || 0;
        const presentation = comboBadgePresentationMap.get(id) || {
          tier: COMBO_BADGE_TIER,
          rarityScore: midpointScore(COMBO_BADGE_TIER)
        };
        return {
          id,
          name: doc?.name || '',
          rank: count,
          percent: toPercent(count, total),
          tier: COMBO_BADGE_TIER,
          rarityScore: presentation.rarityScore
        };
      })
    };
  } catch (error) {
    console.error('atlasStats failed', error);
    return {
      ok: false,
      error: error.message || 'atlas_stats_failed'
    };
  }
}

function buildAtlasPersonaStat(category, code, personaMap, total, presentationMap) {
  const doc = personaMap.get(`${category}:${code}`);
  const count = doc?.count || 0;
  const fallbackTier = category === 'hidden' ? 'hidden' : 'silver';
  const presentation = presentationMap.get(code) || {
    tier: fallbackTier,
    rarityScore: midpointScore(fallbackTier)
  };
  return {
    code,
    category,
    name: doc?.name || '',
    rank: count,
    percent: toPercent(count, total),
    tier: presentation.tier,
    tierType: category === 'hidden' ? 'hidden' : presentation.tier,
    rarityScore: presentation.rarityScore
  };
}

function buildPersonaStat(category, currentCode, personaMap, total, presentationMap) {
  const doc = personaMap.get(`${category}:${currentCode}`);
  const count = doc?.count || 0;
  const presentation = presentationMap.get(currentCode) || {
    tier: 'silver',
    rarityScore: midpointScore('silver')
  };
  return {
    rank: count,
    percent: toPercent(count, total),
    tier: presentation.tier,
    rarityScore: presentation.rarityScore
  };
}

function buildHiddenPersonaStat(currentCode, personaMap, total, presentationMap) {
  const doc = personaMap.get(`hidden:${currentCode}`);
  const count = doc?.count || 0;
  const presentation = presentationMap.get(currentCode) || {
    tier: 'hidden',
    rarityScore: midpointScore('hidden')
  };
  return {
    rank: count,
    percent: toPercent(count, total),
    tier: presentation.tier,
    tierType: 'hidden',
    rarityScore: presentation.rarityScore
  };
}

function buildPersonaPresentationMap(category, codes, personaMap, total) {
  const smoothing = STAT_SMOOTHING[category];
  const sorted = codes
    .map(code => {
      const doc = personaMap.get(`${category}:${code}`);
      const count = doc?.count || 0;
      return {
        code,
        count,
        smoothPercent: getSmoothedPercent(count, total, smoothing)
      };
    })
    .sort((left, right) => {
      if (left.smoothPercent !== right.smoothPercent) return left.smoothPercent - right.smoothPercent;
      if (left.count !== right.count) return left.count - right.count;
      return left.code.localeCompare(right.code);
    });

  const tierMap = new Map();
  const tierSize = Math.ceil(sorted.length / PERSONA_TIER_ORDER.length);
  sorted.forEach((entry, index) => {
    const tierIndex = Math.min(PERSONA_TIER_ORDER.length - 1, Math.floor(index / tierSize));
    entry.tier = PERSONA_TIER_ORDER[tierIndex];
  });
  assignRarityScores(sorted, entry => entry.code);
  sorted.forEach(entry => {
    tierMap.set(entry.code, {
      tier: entry.tier,
      rarityScore: entry.rarityScore
    });
  });
  return tierMap;
}

function buildHiddenPresentationMap(codes, personaMap, total) {
  const smoothing = STAT_SMOOTHING.hidden;
  const sorted = codes
    .map(code => {
      const doc = personaMap.get(`hidden:${code}`);
      const count = doc?.count || 0;
      return {
        code,
        count,
        smoothPercent: getSmoothedPercent(count, total, smoothing),
        tier: 'hidden'
      };
    })
    .sort(compareByRarity);

  const presentationMap = new Map();
  assignRarityScores(sorted, entry => entry.code);
  sorted.forEach(entry => {
    presentationMap.set(entry.code, {
      tier: entry.tier,
      rarityScore: entry.rarityScore
    });
  });
  return presentationMap;
}

function buildLabelPresentationMap(labelMap, total) {
  const smoothing = STAT_SMOOTHING.label;
  const pairStats = LABEL_AXIS_ORDER.map((axisCode, axisIndex) => {
    const leftCount = getLabelCount(labelMap, axisCode, 'left');
    const rightCount = getLabelCount(labelMap, axisCode, 'right');
    return {
      axisCode,
      axisIndex,
      left: {
        count: leftCount,
        smoothPercent: getSmoothedPercent(leftCount, total, smoothing)
      },
      right: {
        count: rightCount,
        smoothPercent: getSmoothedPercent(rightCount, total, smoothing)
      },
      diff: Math.abs(getSmoothedPercent(leftCount, total, smoothing) - getSmoothedPercent(rightCount, total, smoothing))
    };
  }).sort((left, right) => {
    if (left.diff !== right.diff) return right.diff - left.diff;
    return left.axisIndex - right.axisIndex;
  });

  const tierMap = new Map();
  pairStats.forEach((pair, index) => {
    if (index <= 2) {
      assignRareCommonPairTiers(tierMap, pair, 'color', 'silver');
      return;
    }
    if (index === pairStats.length - 1) {
      tierMap.set(`${pair.axisCode}:left`, 'gold');
      tierMap.set(`${pair.axisCode}:right`, 'gold');
      return;
    }
    assignRareCommonPairTiers(tierMap, pair, 'gold', 'silver');
  });

  const entries = LABEL_AXIS_ORDER.flatMap(axisCode => LABEL_SIDES.map(side => {
    const key = `${axisCode}:${side}`;
    const count = getLabelCount(labelMap, axisCode, side);
    return {
      key,
      axisCode,
      side,
      count,
      smoothPercent: getSmoothedPercent(count, total, smoothing),
      tier: tierMap.get(key) || 'silver'
    };
  })).sort((left, right) => {
    const rarityOrder = compareByRarity(left, right);
    if (rarityOrder !== 0) return rarityOrder;
    return left.key.localeCompare(right.key);
  });

  const presentationMap = new Map();
  assignRarityScores(entries, entry => entry.key);
  entries.forEach(entry => {
    presentationMap.set(entry.key, {
      tier: entry.tier,
      rarityScore: entry.rarityScore
    });
  });
  return presentationMap;
}

function buildComboBadgePresentationMap(comboBadgeMap, currentComboBadges, total) {
  const smoothing = STAT_SMOOTHING.comboBadge;
  const comboIds = new Set([
    ...comboBadgeMap.keys(),
    ...currentComboBadges.map(comboBadge => comboBadge.id)
  ]);
  const entries = [...comboIds]
    .map(id => {
      const doc = comboBadgeMap.get(id);
      const count = doc?.count || 0;
      return {
        key: id,
        id,
        count,
        smoothPercent: getSmoothedPercent(count, total, smoothing),
        tier: COMBO_BADGE_TIER
      };
    })
    .sort(compareByRarity);

  const presentationMap = new Map();
  assignRarityScores(entries, entry => entry.id);
  entries.forEach(entry => {
    presentationMap.set(entry.id, {
      tier: COMBO_BADGE_TIER,
      rarityScore: entry.rarityScore
    });
  });
  return presentationMap;
}

function buildComboBadgeStat(comboBadge, comboBadgeMap, total, presentationMap) {
  const doc = comboBadgeMap.get(comboBadge.id);
  const count = doc?.count || 0;
  const presentation = presentationMap.get(comboBadge.id) || {
    tier: COMBO_BADGE_TIER,
    rarityScore: midpointScore(COMBO_BADGE_TIER)
  };
  return {
    id: comboBadge.id,
    name: comboBadge.name,
    rank: count,
    percent: toPercent(count, total),
    tier: COMBO_BADGE_TIER,
    rarityScore: presentation.rarityScore
  };
}

function assignRareCommonPairTiers(tierMap, pair, rareTier, commonTier) {
  const leftKey = `${pair.axisCode}:left`;
  const rightKey = `${pair.axisCode}:right`;
  const leftIsRarer = pair.left.smoothPercent <= pair.right.smoothPercent;
  tierMap.set(leftKey, leftIsRarer ? rareTier : commonTier);
  tierMap.set(rightKey, leftIsRarer ? commonTier : rareTier);
}

function getLabelCount(labelMap, axisCode, side) {
  return labelMap.get(`${axisCode}:${side}`)?.count || 0;
}

function assignRarityScores(entries, keySelector) {
  const groupedEntries = new Map();
  entries.forEach(entry => {
    const tier = entry.tier || 'silver';
    if (!groupedEntries.has(tier)) groupedEntries.set(tier, []);
    groupedEntries.get(tier).push(entry);
  });

  groupedEntries.forEach(group => {
    group.sort(compareByRarity);
    const rangeTier = group[0]?.tier === 'hidden' ? 'hidden' : group[0]?.tier;
    const range = RARITY_SCORE_RANGES[rangeTier] || RARITY_SCORE_RANGES.silver;
    const span = range.max - range.min;
    const smoothPercents = group
      .map(entry => Number(entry.smoothPercent))
      .filter(value => Number.isFinite(value));
    const minPercent = smoothPercents.length ? Math.min(...smoothPercents) : 0;
    const maxPercent = smoothPercents.length ? Math.max(...smoothPercents) : minPercent;
    const percentSpan = maxPercent - minPercent;
    group.forEach((entry, index) => {
      let ratio = 0.5;
      if (percentSpan > 0 && Number.isFinite(entry.smoothPercent)) {
        ratio = (maxPercent - Number(entry.smoothPercent)) / percentSpan;
      } else if (group.length > 1) {
        ratio = 1 - index / (group.length - 1);
      }
      const rawScore = range.min + span * ratio;
      entry.rarityScore = quantizeRarityScore(rawScore, range);
    });
  });

  return new Map(entries.map(entry => [keySelector(entry), entry.rarityScore]));
}

function compareByRarity(left, right) {
  if (left.smoothPercent !== right.smoothPercent) return left.smoothPercent - right.smoothPercent;
  if (left.count !== right.count) return left.count - right.count;
  if (left.code && right.code) return left.code.localeCompare(right.code);
  if (left.key && right.key) return left.key.localeCompare(right.key);
  return 0;
}

function midpointScore(tier) {
  const range = RARITY_SCORE_RANGES[tier] || RARITY_SCORE_RANGES.silver;
  return Math.round((range.min + range.max) / 2);
}

function quantizeRarityScore(rawScore, range) {
  const step = 5;
  const clamped = Math.max(range.min, Math.min(range.max, rawScore));
  const quantized = Math.round(clamped / step) * step;
  return Math.max(range.min, Math.min(range.max, quantized));
}

function getSmoothedPercent(count, total, smoothing) {
  const alpha = smoothing?.alpha || 0;
  const bucketCount = smoothing?.bucketCount || 1;
  const displayTotal = total + alpha * bucketCount;
  if (!displayTotal) return 0;
  return Number((((count + alpha) / displayTotal) * 100).toFixed(4));
}

function toPercent(count, total) {
  if (!total) return 0;
  return Number(((count / total) * 100).toFixed(2));
}
