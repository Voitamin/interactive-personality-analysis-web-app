const { comboBadgeRules } = require('./hiddenRules');
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
  console.warn('CloudBase SDK unavailable, oracleLab degraded:', error.message);
}

const ORACLE_PROFILE_COLLECTION = 'wmti_oracle_users';
const RATE_LIMIT_COLLECTION = 'wmti_rate_limits';
const ORACLE_LEVEL_TWO_MIN = 5;
const ORACLE_LEVEL_THREE_MIN = 6;
const TOKEN_TTL_MS = 15 * 60 * 1000;
const ORACLE_TOKEN_SECRET = process.env.WMTI_ORACLE_SECRET || '';
const RATE_LIMITS = {
  uid: {
    minute: { windowMs: 60 * 1000, maxCount: 36, maxUnique: 30 },
    hour: { windowMs: 60 * 60 * 1000, maxCount: 720, maxUnique: 540 }
  },
  ip: {
    minute: { windowMs: 60 * 1000, maxCount: 180, maxUnique: 120 },
    hour: { windowMs: 60 * 60 * 1000, maxCount: 3600, maxUnique: 2400 }
  }
};

exports.main = async event => {
  const action = normalizeAction(event?.action);
  if (action === 'evaluateVector') {
    return evaluateVectorAction(event);
  }
  if (action === 'getState') {
    return getStateAction();
  }
  return {
    ok: false,
    error: 'unsupported_action'
  };
};

async function getStateAction() {
  const identity = getOracleIdentity();
  const profile = identity ? await readOracleProfile(identity) : null;
  const maxCombo = Math.max(0, Number(profile?.maxCombo || 0));
  const level = getOracleLevel(maxCombo);
  return {
    ok: true,
    level,
    maxCombo,
    token: identity ? issueOracleToken(identity, level, maxCombo) : null,
    lastFiveAnswers: sanitizeStoredAnswers(profile?.lastFiveAnswers),
    lastSixVector: sanitizeVector(profile?.lastSixVector),
    discoveredComboBadges: mapComboBadgeIdsToItems(profile?.discoveredComboBadgeIds)
  };
}

async function evaluateVectorAction(event) {
  if (!db || !auth) {
    return {
      ok: false,
      error: 'oracle_unavailable'
    };
  }

  const identity = getOracleIdentity();
  if (!identity) {
    return {
      ok: false,
      error: 'missing_identity'
    };
  }

  const profile = await readOracleProfile(identity);
  const profileMaxCombo = Math.max(0, Number(profile?.maxCombo || 0));
  const profileLevel = getOracleLevel(profileMaxCombo);
  if (profileLevel < 3) {
    return {
      ok: false,
      error: 'insufficient_level'
    };
  }

  const vector = sanitizeVector(event?.vector);
  if (!vector) {
    return {
      ok: false,
      error: 'invalid_vector'
    };
  }

  const rateLimit = await enforceRateLimit(identity, vector);
  if (!rateLimit.ok) {
    return {
      ok: false,
      error: 'rate_limited',
      retryAfterMs: rateLimit.retryAfterMs
    };
  }

  const evaluation = evaluateVector(vector);
  if (!evaluation.ok) {
    return {
      ok: false,
      error: evaluation.error
    };
  }

  const ref = db.collection(ORACLE_PROFILE_COLLECTION).doc(buildOracleDocId(identity));
  const existing = profile || {};
  const previousIds = Array.isArray(existing.discoveredComboBadgeIds) ? existing.discoveredComboBadgeIds : [];
  const currentIds = evaluation.comboBadges.map(item => item.id);
  const newlyDiscoveredIds = currentIds.filter(id => !previousIds.includes(id));
  const nextDiscoveredIds = mergeStringArrays(previousIds, currentIds);
  const now = Date.now();

  const nextDoc = {
    key: buildOracleDocId(identity),
    identity_kind: identity.kind,
    identity_hash: identity.hash,
    maxCombo: Math.max(Math.max(0, Number(existing.maxCombo || 0)), currentIds.length),
    level: getOracleLevel(Math.max(Math.max(0, Number(existing.maxCombo || 0)), currentIds.length)),
    discoveredComboBadgeIds: nextDiscoveredIds,
    updated_at: now,
    lastSixVector: vector,
    lastSixAt: now
  };

  if (existing.lastFiveAnswers) {
    nextDoc.lastFiveAnswers = sanitizeStoredAnswers(existing.lastFiveAnswers);
    if (existing.lastFiveAt) nextDoc.lastFiveAt = existing.lastFiveAt;
  }

  await ref.set(nextDoc);

  return {
    ok: true,
    count: currentIds.length,
    visibleBadges: evaluation.comboBadges.map(item => ({ id: item.id, name: item.name })),
    newlyDiscoveredBadges: mapComboBadgeIdsToItems(newlyDiscoveredIds)
  };
}

function normalizeAction(value) {
  const action = String(value || 'getState').trim();
  return action || 'getState';
}

async function readOracleProfile(identity) {
  if (!db) return null;
  return getDoc(db.collection(ORACLE_PROFILE_COLLECTION).doc(buildOracleDocId(identity)));
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

function buildOracleDocId(identity) {
  return `oracle_${identity.kind}_${identity.hash.slice(0, 40)}`;
}

function getOracleLevel(maxCombo) {
  if (maxCombo >= ORACLE_LEVEL_THREE_MIN) return 3;
  if (maxCombo >= ORACLE_LEVEL_TWO_MIN) return 2;
  return 0;
}

function issueOracleToken(identity, level, maxCombo) {
  const exp = Date.now() + TOKEN_TTL_MS;
  const nonce = crypto.randomBytes(8).toString('hex');
  const token = {
    sub: identity.hash,
    level,
    maxCombo,
    exp,
    nonce
  };
  token.sig = signOracleToken(token);
  return token;
}

function verifyOracleToken(token, identity, minLevel) {
  if (!token || typeof token !== 'object') return { ok: false, error: 'missing_token' };
  const parsed = {
    sub: String(token.sub || '').trim(),
    level: Math.max(0, Number(token.level || 0)),
    maxCombo: Math.max(0, Number(token.maxCombo || 0)),
    exp: Math.max(0, Number(token.exp || 0)),
    nonce: String(token.nonce || '').trim(),
    sig: String(token.sig || '').trim()
  };

  if (!parsed.sub || !parsed.sig || !parsed.nonce || !parsed.exp) {
    return { ok: false, error: 'invalid_token' };
  }

  if (parsed.sub !== identity.hash) {
    return { ok: false, error: 'token_subject_mismatch' };
  }

  if (parsed.exp < Date.now()) {
    return { ok: false, error: 'token_expired' };
  }

  if (parsed.level < minLevel) {
    return { ok: false, error: 'insufficient_level' };
  }

  if (signOracleToken(parsed) !== parsed.sig) {
    return { ok: false, error: 'token_signature_invalid' };
  }

  return { ok: true };
}

function signOracleToken(token) {
  if (!ORACLE_TOKEN_SECRET) {
    throw new Error('WMTI_ORACLE_SECRET is required');
  }
  const payload = [token.sub, token.level, token.maxCombo, token.exp, token.nonce].join('.');
  return crypto.createHmac('sha256', ORACLE_TOKEN_SECRET).update(payload).digest('hex');
}

async function enforceRateLimit(identity, vector) {
  const vectorHash = hashStableJson(vector);
  const identities = [identity];
  const clientIP = normalizeIdentityValue(safeGetClientIP());
  if (clientIP && identity.kind !== 'ip') {
    identities.push({
      kind: 'ip',
      raw: clientIP,
      hash: hashText(`ip:${clientIP}`)
    });
  }

  const now = Date.now();
  for (const current of identities) {
    const config = RATE_LIMITS[current.kind];
    if (!config) continue;
    const docId = `oracleLab_${current.kind}_${current.hash.slice(0, 40)}`;
    const ref = db.collection(RATE_LIMIT_COLLECTION).doc(docId);
    const existing = await getDoc(ref);
    const nextDoc = {
      key: docId,
      kind: current.kind,
      identity_hash: current.hash,
      minute: nextWindowState(existing?.minute, config.minute, vectorHash, now),
      hour: nextWindowState(existing?.hour, config.hour, vectorHash, now),
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
  }

  return { ok: true };
}

function nextWindowState(currentState, config, hashValue, now) {
  const bucket = Math.floor(now / config.windowMs);
  const existingHashes = currentState?.bucket === bucket && Array.isArray(currentState.unique_hashes)
    ? currentState.unique_hashes
    : [];
  const uniqueHashes = existingHashes.includes(hashValue)
    ? existingHashes
    : [...existingHashes, hashValue].slice(-(config.maxUnique + 1));

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

function getDoc(ref) {
  return ref.get()
    .then(result => {
      const data = result?.data;
      if (Array.isArray(data)) return data[0] || null;
      return data || null;
    })
    .catch(() => null);
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

function sanitizeStoredAnswers(value) {
  if (!value || typeof value !== 'object') return null;
  const allowedIds = new Set(
    resolverConfig.questions
      .filter(question => question.axis_group === 'outer' || question.axis_group === 'inner' || question.axis_group === 'label')
      .map(question => question.id)
  );
  const answers = Object.fromEntries(
    Object.entries(value)
      .filter(([questionId, answerKey]) => allowedIds.has(questionId) && answerKey)
      .map(([questionId, answerKey]) => [String(questionId), String(answerKey)])
  );
  return Object.keys(answers).length ? answers : null;
}

function sanitizeVector(value) {
  if (!value || typeof value !== 'object') return null;
  const vector = {};
  for (const axisCode of resolverConfig.axes.outer) {
    const side = String(value[axisCode] || '').trim();
    if (side !== 'left' && side !== 'right') return null;
    vector[axisCode] = side;
  }
  for (const axisCode of resolverConfig.axes.inner) {
    const side = String(value[axisCode] || '').trim();
    if (side !== 'left' && side !== 'right') return null;
    vector[axisCode] = side;
  }
  for (const axisCode of resolverConfig.axes.label) {
    const side = String(value[axisCode] || '').trim();
    if (!['left', 'neutral', 'right'].includes(side)) return null;
    vector[axisCode] = side;
  }
  return vector;
}

function mapComboBadgeIdsToItems(ids) {
  const idSet = new Set(
    (Array.isArray(ids) ? ids : [])
      .map(item => String(item || '').trim())
      .filter(Boolean)
  );
  return comboBadgeRules
    .filter(rule => idSet.has(rule.id))
    .sort((left, right) => (right.priority || 0) - (left.priority || 0))
    .map(rule => ({ id: rule.id, name: rule.name }));
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

function evaluateVector(vector) {
  const answers = buildAnswersFromVector(vector);
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
      name: rule.name
    }));

  return {
    ok: true,
    comboBadges
  };
}

function buildAnswersFromVector(vector) {
  const answers = {};

  const assignPair = (axisCode, pair) => {
    const questions = resolverConfig.questions.filter(question => question.axis === axisCode);
    if (questions[0]) answers[questions[0].id] = pair[0];
    if (questions[1]) answers[questions[1].id] = pair[1];
  };

  resolverConfig.axes.outer.forEach(axisCode => {
    assignPair(axisCode, vector[axisCode] === 'right' ? ['C', 'C'] : ['A', 'A']);
  });

  resolverConfig.axes.inner.forEach(axisCode => {
    assignPair(axisCode, vector[axisCode] === 'right' ? ['C', 'C'] : ['A', 'A']);
  });

  resolverConfig.axes.label.forEach(axisCode => {
    const side = vector[axisCode];
    if (side === 'left') assignPair(axisCode, ['A', 'A']);
    else if (side === 'right') assignPair(axisCode, ['C', 'C']);
    else assignPair(axisCode, ['B', 'B']);
  });

  return answers;
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
