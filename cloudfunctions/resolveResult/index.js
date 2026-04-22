const { comboBadgeRules, sevenWonders } = require('./hiddenRules');
const resolverConfig = require('./publicResolverConfig.json');
const crypto = require('crypto');

let tcb = null;
let app = null;
let auth = null;
let db = null;
try {
  tcb = require('@cloudbase/node-sdk');
  app = tcb.init({
    env: tcb.SYMBOL_DEFAULT_ENV
  });
  auth = app.auth();
  db = app.database();
} catch (error) {
  console.warn('CloudBase SDK unavailable, rate limiting disabled:', error.message);
}

const RATE_LIMIT_COLLECTION = 'wmti_rate_limits';
const ORACLE_PROFILE_COLLECTION = 'wmti_oracle_users';
const ORACLE_LEVEL_TWO_MIN = 5;
const ORACLE_LEVEL_THREE_MIN = 6;
const RATE_LIMITS = {
  uid: {
    minute: { windowMs: 60 * 1000, maxCount: 20, maxUnique: 18 },
    hour: { windowMs: 60 * 60 * 1000, maxCount: 300, maxUnique: 250 }
  },
  ip: {
    minute: { windowMs: 60 * 1000, maxCount: 100, maxUnique: 80 },
    hour: { windowMs: 60 * 60 * 1000, maxCount: 2000, maxUnique: 1500 }
  }
};

exports.main = async event => {
  const payload = normalizePayload(event);
  if (!payload.ok) {
    return {
      ok: false,
      error: payload.error
    };
  }

  const rateLimit = await enforceRateLimit(payload.answers);
  if (!rateLimit.ok) {
    return {
      ok: false,
      error: 'rate_limited',
      retryAfterMs: rateLimit.retryAfterMs
    };
  }

  const evaluation = evaluateAnswers(payload.answers);
  if (!evaluation.ok) {
    return {
      ok: false,
      error: evaluation.error
    };
  }

  const oracle = await updateOracleProfile(payload.answers, evaluation);

  return {
    ok: true,
    comboBadges: evaluation.comboBadges,
    superPersona: evaluation.superPersona,
    resolvedMeta: {
      input: 'answers',
      configVersion: resolverConfig.version
    },
    oracle
  };
};

async function enforceRateLimit(answers) {
  if (!db || !auth) return { ok: true };

  const identities = getRateLimitIdentities();
  if (!identities.length) return { ok: true };

  const answerHash = hashStableJson(answers);
  const now = Date.now();

  try {
    for (const identity of identities) {
      const verdict = await checkIdentityRateLimit(identity, answerHash, now);
      if (!verdict.ok) return verdict;
    }
  } catch (error) {
    console.error('resolveResult rate limit check failed:', error);
    return { ok: true };
  }

  return { ok: true };
}

function getRateLimitIdentities() {
  const identities = [];
  const userInfo = safeGetUserInfo();
  const uid = normalizeIdentityValue(userInfo.uid || userInfo.customUserId || userInfo.openId);
  const clientIP = normalizeIdentityValue(safeGetClientIP());

  if (uid) {
    identities.push({
      kind: 'uid',
      value: uid
    });
  }

  if (clientIP) {
    identities.push({
      kind: 'ip',
      value: clientIP
    });
  }

  return identities;
}

function safeGetUserInfo() {
  try {
    return auth.getUserInfo() || {};
  } catch (error) {
    return {};
  }
}

function safeGetClientIP() {
  try {
    return auth.getClientIP() || '';
  } catch (error) {
    return '';
  }
}

function normalizeIdentityValue(value) {
  return String(value || '').trim();
}

async function checkIdentityRateLimit(identity, answerHash, now) {
  const config = RATE_LIMITS[identity.kind];
  if (!config) return { ok: true };

  const identityHash = hashText(`${identity.kind}:${identity.value}`);
  const docId = `resolveResult_${identity.kind}_${identityHash.slice(0, 40)}`;
  const ref = db.collection(RATE_LIMIT_COLLECTION).doc(docId);
  const existing = await getDoc(ref);
  const nextDoc = {
    key: docId,
    kind: identity.kind,
    identity_hash: identityHash,
    minute: nextWindowState(existing?.minute, config.minute, answerHash, now),
    hour: nextWindowState(existing?.hour, config.hour, answerHash, now),
    updated_at: now
  };

  const minuteVerdict = getWindowVerdict(nextDoc.minute, config.minute, now);
  const hourVerdict = getWindowVerdict(nextDoc.hour, config.hour, now);
  if (!minuteVerdict.ok || !hourVerdict.ok) {
    await ref.set({
      ...nextDoc,
      blocked_at: now
    });
    return !minuteVerdict.ok ? minuteVerdict : hourVerdict;
  }

  await ref.set(nextDoc);
  return { ok: true };
}

function nextWindowState(currentState, config, answerHash, now) {
  const bucket = Math.floor(now / config.windowMs);
  const existingHashes = currentState?.bucket === bucket && Array.isArray(currentState.unique_hashes)
    ? currentState.unique_hashes
    : [];
  const uniqueHashes = existingHashes.includes(answerHash)
    ? existingHashes
    : [...existingHashes, answerHash].slice(-(config.maxUnique + 1));

  return {
    bucket,
    started_at: bucket * config.windowMs,
    count: currentState?.bucket === bucket ? (currentState.count || 0) + 1 : 1,
    unique_count: uniqueHashes.length,
    unique_hashes: uniqueHashes
  };
}

function getWindowVerdict(state, config, now) {
  if (state.count <= config.maxCount && state.unique_count <= config.maxUnique) {
    return { ok: true };
  }

  return {
    ok: false,
    retryAfterMs: Math.max(1000, state.started_at + config.windowMs - now)
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

function hashStableJson(value) {
  return hashText(JSON.stringify(sortObjectKeys(value)));
}

function hashText(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function sortObjectKeys(value) {
  if (Array.isArray(value)) return value.map(sortObjectKeys);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value)
    .sort()
    .reduce((result, key) => {
      result[key] = sortObjectKeys(value[key]);
      return result;
    }, {});
}

function normalizePayload(event) {
  const answers = normalizeAnswers(event?.answers);
  if (!answers || Object.keys(answers).length === 0) {
    return {
      ok: false,
      error: 'missing_answers'
    };
  }

  return {
    ok: true,
    answers
  };
}

function normalizeAnswers(value) {
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([questionId, answerKey]) => questionId && answerKey)
      .map(([questionId, answerKey]) => [String(questionId), String(answerKey)])
  );
}

function evaluateAnswers(answers) {
  const resolved = resolveAnswerSides(answers);
  if (!resolved.ok) return resolved;

  const activeOuterSides = sideSet(resolved.outerSides);
  const activeInnerSides = sideSet(resolved.innerSides);
  const activeLabelSides = sideSet(resolved.labelSides);

  const comboBadges = comboBadgeRules
    .filter(rule => matchesRule(rule, activeOuterSides, activeInnerSides, activeLabelSides))
    .sort((left, right) => (right.priority || 0) - (left.priority || 0))
    .map(rule => ({
      id: rule.id,
      name: rule.name,
      description: rule.description,
      priority: rule.priority || 0
    }));

  const superPersona = comboBadges.length >= sevenWonders.threshold
    ? {
        ...sevenWonders.persona,
        matched_badge_count: comboBadges.length
      }
    : null;

  return {
    ok: true,
    resolved,
    comboBadges,
    superPersona
  };
}

function resolveAnswerSides(answers) {
  const regularQuestions = resolverConfig.questions.filter(question => isRegularAxisGroup(question.axis_group));
  const missingQuestion = regularQuestions.find(question => !answers[question.id]);

  if (missingQuestion) {
    return {
      ok: false,
      error: `missing_answer:${missingQuestion.id}`
    };
  }

  const invalidQuestion = regularQuestions.find(question => !isValidAnswer(question, answers[question.id]));
  if (invalidQuestion) {
    return {
      ok: false,
      error: `invalid_answer:${invalidQuestion.id}`
    };
  }

  return {
    ok: true,
    outerSides: buildAxisSideMap(resolverConfig.axes.outer, answers),
    innerSides: buildAxisSideMap(resolverConfig.axes.inner, answers),
    labelSides: buildLabelSideMap(answers)
  };
}

function isRegularAxisGroup(axisGroup) {
  return axisGroup === 'outer' || axisGroup === 'inner' || axisGroup === 'label';
}

function isValidAnswer(question, answerKey) {
  return (question.options || []).some(option => option.key === answerKey);
}

function buildAxisSideMap(axisOrder, answers) {
  return Object.fromEntries(axisOrder.map(axisCode => [axisCode, resolveTwoQuestionDirection(axisCode, answers)]));
}

function buildLabelSideMap(answers) {
  return Object.fromEntries(
    resolverConfig.axes.label.map(axisCode => [axisCode, resolveLabelSide(axisCode, answers)])
  );
}

function getQuestionsByAxis(axisCode) {
  return resolverConfig.questions.filter(question => question.axis === axisCode);
}

function answerKeyToScore(answerKey) {
  return resolverConfig.scoring.option_score_map[answerKey];
}

function computeAxisRawScore(axisCode, answers) {
  return getQuestionsByAxis(axisCode).reduce((sum, question) => sum + answerKeyToScore(answers[question.id]), 0);
}

function resolveTwoQuestionDirection(axisCode, answers) {
  const score = computeAxisRawScore(axisCode, answers);
  const rule = resolverConfig.scoring.two_question_direction_rule;
  const questions = getQuestionsByAxis(axisCode);
  if (rule.left_scores.includes(score)) return 'left';
  if (rule.right_scores.includes(score)) return 'right';

  const primary = answers[questions[0]?.id];
  const secondary = answers[questions[1]?.id];
  if (primary === 'A') return 'left';
  if (primary === 'C') return 'right';
  if (secondary === 'C') return 'right';
  return 'left';
}

function resolveLabelSide(axisCode, answers) {
  const score = computeAxisRawScore(axisCode, answers);
  if (score <= 3) return 'left';
  if (score >= 5) return 'right';
  return 'neutral';
}

function sideSet(sideMap) {
  return new Set(Object.entries(sideMap).map(([axisCode, side]) => `${axisCode}:${side}`));
}

function matchesRule(rule, activeOuterSides, activeInnerSides, activeLabelSides) {
  const when = rule.when || {};
  return matchesAll(when.outer_sides_all, activeOuterSides)
    && matchesAny(when.outer_sides_any, activeOuterSides)
    && matchesAll(when.inner_sides_all, activeInnerSides)
    && matchesAny(when.inner_sides_any, activeInnerSides)
    && matchesAll(when.label_sides_all, activeLabelSides)
    && matchesAny(when.label_sides_any, activeLabelSides);
}

function matchesAll(requiredItems, activeSet) {
  return !requiredItems?.length || requiredItems.every(item => activeSet.has(item));
}

function matchesAny(requiredItems, activeSet) {
  return !requiredItems?.length || requiredItems.some(item => activeSet.has(item));
}

async function updateOracleProfile(answers, evaluation) {
  const comboCount = Array.isArray(evaluation.comboBadges) ? evaluation.comboBadges.length : 0;
  const fallbackLevel = getOracleLevel(comboCount);

  if (!db || !auth) {
    return {
      maxCombo: comboCount,
      level: fallbackLevel,
      newlyUnlockedLevel: fallbackLevel >= 2 ? fallbackLevel : 0
    };
  }

  const identity = getOracleIdentity();
  if (!identity) {
    return {
      maxCombo: comboCount,
      level: fallbackLevel,
      newlyUnlockedLevel: fallbackLevel >= 2 ? fallbackLevel : 0
    };
  }

  try {
    const ref = db.collection(ORACLE_PROFILE_COLLECTION).doc(buildOracleDocId(identity));
    const existing = (await getDoc(ref)) || {};
    const previousMaxCombo = Math.max(0, Number(existing.maxCombo || 0));
    const previousLevel = getOracleLevel(previousMaxCombo);
    const now = Date.now();
    const maxCombo = Math.max(previousMaxCombo, comboCount);
    const level = getOracleLevel(maxCombo);
    const discoveredComboBadgeIds = mergeStringArrays(
      existing.discoveredComboBadgeIds,
      evaluation.comboBadges.map(item => item.id)
    );

    const nextDoc = {
      key: buildOracleDocId(identity),
      identity_kind: identity.kind,
      identity_hash: identity.hash,
      maxCombo,
      level,
      discoveredComboBadgeIds,
      updated_at: now
    };

    if (comboCount >= ORACLE_LEVEL_TWO_MIN) {
      nextDoc.lastFiveAnswers = sanitizeAnswerSnapshot(answers);
      nextDoc.lastFiveAt = now;
    } else if (existing.lastFiveAnswers) {
      nextDoc.lastFiveAnswers = existing.lastFiveAnswers;
      if (existing.lastFiveAt) nextDoc.lastFiveAt = existing.lastFiveAt;
    }

    if (comboCount >= ORACLE_LEVEL_THREE_MIN) {
      nextDoc.lastSixVector = buildOracleVectorFromResolved(evaluation.resolved);
      nextDoc.lastSixAt = now;
    } else if (existing.lastSixVector) {
      nextDoc.lastSixVector = existing.lastSixVector;
      if (existing.lastSixAt) nextDoc.lastSixAt = existing.lastSixAt;
    }

    await ref.set(nextDoc);

    return {
      maxCombo,
      level,
      newlyUnlockedLevel: level > previousLevel && level >= 2 ? level : 0
    };
  } catch (error) {
    console.error('resolveResult oracle profile update failed:', error);
    return {
      maxCombo: comboCount,
      level: fallbackLevel,
      newlyUnlockedLevel: 0
    };
  }
}

function getOracleIdentity() {
  const userInfo = safeGetUserInfo();
  const uid = normalizeIdentityValue(userInfo.uid || userInfo.customUserId || userInfo.openId);
  if (uid) {
    return {
      kind: 'uid',
      raw: uid,
      hash: hashText(`uid:${uid}`)
    };
  }

  const clientIP = normalizeIdentityValue(safeGetClientIP());
  if (clientIP) {
    return {
      kind: 'ip',
      raw: clientIP,
      hash: hashText(`ip:${clientIP}`)
    };
  }

  return null;
}

function buildOracleDocId(identity) {
  return `oracle_${identity.kind}_${identity.hash.slice(0, 40)}`;
}

function getOracleLevel(maxCombo) {
  if (maxCombo >= ORACLE_LEVEL_THREE_MIN) return 3;
  if (maxCombo >= ORACLE_LEVEL_TWO_MIN) return 2;
  return 0;
}

function sanitizeAnswerSnapshot(answers) {
  const allowedIds = new Set(
    resolverConfig.questions
      .filter(question => isRegularAxisGroup(question.axis_group))
      .map(question => question.id)
  );
  return Object.fromEntries(
    Object.entries(answers || {})
      .filter(([questionId, answerKey]) => allowedIds.has(questionId) && answerKey)
      .map(([questionId, answerKey]) => [String(questionId), String(answerKey)])
  );
}

function buildOracleVectorFromResolved(resolved) {
  return {
    ...resolved.outerSides,
    ...resolved.innerSides,
    ...resolved.labelSides
  };
}

function mergeStringArrays(baseList, appendList) {
  const seen = new Set();
  const result = [];
  [...(Array.isArray(baseList) ? baseList : []), ...(Array.isArray(appendList) ? appendList : [])]
    .map(item => String(item || '').trim())
    .filter(Boolean)
    .forEach(item => {
      if (seen.has(item)) return;
      seen.add(item);
      result.push(item);
    });
  return result;
}
