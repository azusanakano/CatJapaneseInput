import { extractContext } from './context.mjs';
import { eligiblePromotions, promote, rankCase, scoringGroups, validateSample } from './ranking.mjs';

function acceptedTexts(sample) {
  const { acceptedTexts: texts = [], targets = [] } = sample;
  if (!Array.isArray(texts) || texts.some(text => typeof text !== 'string' || !text.length)) {
    throw new TypeError('acceptedTexts must contain non-empty strings');
  }
  if (!Array.isArray(targets) || targets.some(target =>
    !Array.isArray(target) || target.length !== sample.segments.length ||
    target.some(value => typeof value !== 'string' || !value.length))) {
    throw new TypeError('each target must contain one non-empty string per segment');
  }
  const accepted = new Set([...texts, ...targets.map(target => target.join(''))]);
  if (!accepted.size || accepted.has('')) {
    throw new TypeError('provide at least one non-empty accepted text or aligned target');
  }
  return accepted;
}

// Walk candidate surfaces from right to left. The state for each offset stores
// the fewest Down and Right keys needed for the corresponding suffix.
function correctionCost(segments, target, selectable) {
  if (!segments.length) return Infinity;
  let suffixes = new Map([[target.length, 0]]);
  for (let index = segments.length - 1; index >= 0; index--) {
    const prefixes = new Map();
    for (const [end, suffixCost] of suffixes) {
      const segment = segments[index];
      const { candidates } = segment;
      for (let rank = 0; rank < candidates.length; rank++) {
        const candidate = candidates[rank];
        if (selectable && !selectable(candidate, rank, segment)) continue;
        const { value } = candidate;
        if (!target.endsWith(value, end)) continue;
        const start = end - value.length;
        const cost = rank + (suffixCost ? suffixCost + 1 : 0);
        if (cost < (prefixes.get(start) ?? Infinity)) prefixes.set(start, cost);
      }
    }
    if (!prefixes.size) return Infinity;
    suffixes = prefixes;
  }
  return (suffixes.get(0) ?? Infinity) + 1; // Enter
}

function assess(segments, accepted, isPrediction, operationLimit) {
  const selectable = (candidate, rank, segment) =>
    (!segment.fixed || rank === 0) && !candidate.attributes?.includes('COMMAND_CANDIDATE') &&
    (!isPrediction || candidate.consumption === 'full');
  const available = segments.length > 0 && segments.every(segment => segment.candidates.length);
  const firstCorrect = available &&
    segments.every(segment => selectable(segment.candidates[0], 0, segment)) &&
    accepted.has(segments.map(segment => segment.candidates[0].value).join(''));
  const topThreeCorrect = isPrediction && available &&
    segments[0].candidates.slice(0, 3).some((candidate, rank) =>
      selectable(candidate, rank, segments[0]) && accepted.has(candidate.value));
  let cost = firstCorrect ? 1 : Infinity;
  if (!firstCorrect && available) {
    for (const target of accepted) cost = Math.min(cost, correctionCost(segments, target, selectable));
  }
  return {
    firstCorrect,
    topThreeCorrect,
    reachable: Number.isFinite(cost),
    completed: cost <= operationLimit,
    operations: Math.min(cost, operationLimit),
  };
}

function methodTotals() {
  return {
    firstCorrect: 0, topThreeCorrect: 0, completed: 0, totalOperations: 0,
    promoted: 0, correctedFirst: 0, harmedFirst: 0,
  };
}

function addResult(totals, result, baseline, promoted) {
  totals.firstCorrect += Number(result.firstCorrect);
  totals.topThreeCorrect += Number(result.topThreeCorrect);
  totals.completed += Number(result.completed);
  totals.totalOperations += result.operations;
  if (totals.promoted !== undefined) totals.promoted += Number(promoted);
  totals.correctedFirst += Number(!baseline.firstCorrect && result.firstCorrect);
  totals.harmedFirst += Number(baseline.firstCorrect && !result.firstCorrect);
}

function recordOracle(totals, sample, baseline, assessView) {
  const best = { ...baseline };
  for (const promotion of eligiblePromotions(sample)) {
    const alternative = assessView(promote(sample, promotion));
    best.firstCorrect ||= alternative.firstCorrect;
    best.topThreeCorrect ||= alternative.topThreeCorrect;
    best.completed ||= alternative.completed;
    best.operations = Math.min(best.operations, alternative.operations);
  }
  addResult(totals, best, baseline, false);
}

function modeTotals(model) {
  const { promoted, ...oracle } = methodTotals();
  return {
    cases: 0, noCandidateList: 0, converterNoResult: 0,
    allCandidateReachable: 0, displayedTargetReachable: 0, scoringGroups: 0, scoringGroupsWithGold: 0,
    reachableScoringGroups: 0,
    baseline: methodTotals(), currentLine: methodTotals(), threeLines: methodTotals(),
    oracle,
    ...(model && { modelCurrentLine: methodTotals(), modelThreeLines: methodTotals() }),
  };
}

function recurrenceScore({ candidate }, lines) {
  const surface = candidate.value.normalize('NFC');
  return lines.reduce((hits, line) =>
    hits + Number(line.state === 'text' && line.text.includes(surface)), 0);
}

function recordCase(totals, sample, operationLimit, model) {
  const accepted = acceptedTexts(sample);
  const isPrediction = sample.mode === 'prediction';
  const assessView = segments => assess(segments, accepted, isPrediction, operationLimit);
  const baseline = assessView(sample.segments);
  totals.cases++;
  totals.noCandidateList += Number(!sample.segments.every(segment => segment.candidates.length));
  totals.converterNoResult += Number(sample.candidateStatus === 'no-result');
  totals.allCandidateReachable += Number(baseline.reachable);
  const displayedReachable = baseline.reachable ||
    [...accepted].some(target => Number.isFinite(correctionCost(sample.segments, target)));
  totals.displayedTargetReachable += Number(displayedReachable);
  const groups = scoringGroups(sample);
  totals.scoringGroups += groups.length;
  for (const { segmentIndex, candidateIndices } of groups) {
    const gold = isPrediction ? accepted : new Set(sample.targets?.map(target => target[segmentIndex]));
    if (!gold.size) continue;
    totals.scoringGroupsWithGold++;
    if (candidateIndices.some(index => gold.has(sample.segments[segmentIndex].candidates[index].value))) {
      totals.reachableScoringGroups++;
    }
  }
  addResult(totals.baseline, baseline, baseline, false);
  const context = extractContext(sample.context ?? null, { leftClipped: sample.leftClipped ?? false });
  const current = [...extractContext(null).slice(0, 2), context[2]];
  for (const [name, lines] of [['currentLine', current], ['threeLines', context]]) {
    const ranked = rankCase(sample, {
      score: input => recurrenceScore(input, lines),
    });
    addResult(totals[name], assessView(ranked.segments), baseline, Boolean(ranked.promotion));
  }
  if (model) {
    if (sample.provenance?.dictionarySha256 !== model.dictionarySha256) {
      throw new Error('capture and model dictionary hashes differ or capture hash is missing');
    }
    for (const [name, lines] of [['modelCurrentLine', current], ['modelThreeLines', context]]) {
      const ranked = rankCase(sample, {
        ...model.thresholds?.[sample.mode],
        score: input => model.score(input, lines),
      });
      addResult(totals[name], assessView(ranked.segments), baseline, Boolean(ranked.promotion));
    }
  }
  recordOracle(totals.oracle, sample, baseline, assessView);
}

export function evaluateCases(samples, { operationLimit = 40, model } = {}) {
  if (!Number.isSafeInteger(operationLimit) || operationLimit < 1) {
    throw new RangeError('operationLimit must be a positive safe integer');
  }
  if (model && (typeof model.score !== 'function' || typeof model.dictionarySha256 !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(model.dictionarySha256))) {
    throw new TypeError('model must supply a scorer and a dictionary SHA-256 digest');
  }
  const totals = { operationLimit, conversion: modeTotals(model), prediction: modeTotals(model) };
  for (const sample of samples) {
    validateSample(sample);
    recordCase(totals[sample.mode], sample, operationLimit, model);
  }
  return totals;
}
