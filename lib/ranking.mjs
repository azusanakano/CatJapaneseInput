import { isProtectedCandidate } from './candidate.mjs';
import { normalizeReading } from './context.mjs';

const MAX_SEGMENTS = 4;
const MAX_NORMAL_SLOTS = 8;
const MAX_CODE_POINTS = 128;

export function validateSample(sample) {
  if (!sample || !['conversion', 'prediction'].includes(sample.mode)) {
    throw new TypeError('Sample must specify conversion or prediction mode');
  }
  if (!Array.isArray(sample.segments) || sample.segments.length === 0 ||
      (sample.mode === 'prediction' && sample.segments.length !== 1)) {
    throw new TypeError('Sample must contain conversion segments or exactly one prediction segment');
  }
  for (const [segmentIndex, segment] of sample.segments.entries()) {
    if (!segment || typeof segment.reading !== 'string' || !Array.isArray(segment.candidates) ||
        (segment.fixed !== undefined && typeof segment.fixed !== 'boolean')) {
      throw new TypeError(`Invalid segment at index ${segmentIndex}`);
    }

    const candidateIds = new Set();
    for (const [candidateIndex, candidate] of segment.candidates.entries()) {
      if (!candidate || !Number.isSafeInteger(candidate.id) || typeof candidate.value !== 'string' ||
          typeof candidate.reading !== 'string' ||
          (candidate.kind !== undefined && !['normal', 'protected'].includes(candidate.kind)) ||
          (candidate.consumption !== undefined &&
           !['full', 'partial', 'unknown'].includes(candidate.consumption)) ||
          (candidate.attributes !== undefined && (!Array.isArray(candidate.attributes) ||
           candidate.attributes.some(attribute => typeof attribute !== 'string'))) ||
          (candidate.cost !== undefined && !Number.isFinite(candidate.cost))) {
        throw new TypeError(`Invalid candidate at segment ${segmentIndex}, index ${candidateIndex}`);
      }
      if (candidateIds.has(candidate.id)) {
        throw new TypeError(`Duplicate candidate ID in segment ${segmentIndex}`);
      }
      candidateIds.add(candidate.id);
    }
  }
}

function boundedNormalized(text) {
  if (text.length === 0 || text.length > 2 * MAX_CODE_POINTS ||
      !text.isWellFormed() || [...text].length > MAX_CODE_POINTS) {
    return null;
  }
  const normalized = normalizeReading(text);
  return [...normalized].length <= MAX_CODE_POINTS ? normalized : null;
}

function normalSlots(candidates) {
  const slots = [];
  for (const [index, candidate] of candidates.entries()) {
    if (!isProtectedCandidate(candidate)) {
      slots.push(index);
      if (slots.length === MAX_NORMAL_SLOTS) break;
    }
  }
  return slots;
}

function canScore(candidate, reading, mode) {
  const candidateReading = boundedNormalized(candidate.reading);
  return candidateReading !== null && boundedNormalized(candidate.value) !== null &&
    (mode === 'conversion' ||
      (candidate.consumption === 'full' && candidateReading.startsWith(reading)));
}

export function scoringGroups(sample) {
  validateSample(sample);
  const groups = [];
  let consideredSegments = 0;
  for (const [segmentIndex, segment] of sample.segments.entries()) {
    if (segment.fixed) continue;
    const slots = normalSlots(segment.candidates);
    if (slots.length < 2) continue;
    if (consideredSegments === MAX_SEGMENTS) break;
    consideredSegments++;

    const reading = boundedNormalized(segment.reading);
    if (reading === null) continue;
    const candidateIndices = slots.filter((index) => canScore(segment.candidates[index], reading, sample.mode));
    if (candidateIndices.length >= 2 && candidateIndices[0] === slots[0]) {
      groups.push({ segmentIndex, candidateIndices });
    }
  }
  return groups;
}

export function eligiblePromotions(sample) {
  return scoringGroups(sample).flatMap(({ segmentIndex, candidateIndices }) =>
    candidateIndices.slice(1).map((candidateIndex) => ({ segmentIndex, candidateIndex })),
  );
}

function promoteInGroup(segments, { segmentIndex, candidateIndices }, candidateIndex) {
  const segment = segments[segmentIndex];
  const candidates = segment.candidates.slice();
  const movable = candidateIndices.map((index) => candidates[index]);
  const [selected] = movable.splice(candidateIndices.indexOf(candidateIndex), 1);
  movable.unshift(selected);
  candidateIndices.forEach((index, rank) => { candidates[index] = movable[rank]; });
  return segments.with(segmentIndex, { ...segment, candidates });
}

export function promote(sample, promotion) {
  if (promotion == null) {
    validateSample(sample);
    return sample.segments;
  }
  const { segmentIndex, candidateIndex } = promotion;
  const group = scoringGroups(sample).find((entry) => entry.segmentIndex === segmentIndex);
  if (!group || !group.candidateIndices.slice(1).includes(candidateIndex)) {
    throw new RangeError('Requested promotion is outside the movable positions');
  }
  return promoteInGroup(sample.segments, group, candidateIndex);
}

export function rankCase(sample, { score, minLead = 0, minGain = 0 }) {
  if (typeof score !== 'function' || !Number.isFinite(minLead) || minLead < 0 ||
      !Number.isFinite(minGain) || minGain < 0) {
    throw new TypeError('Ranking requires a score function and finite, nonnegative thresholds');
  }

  for (const group of scoringGroups(sample)) {
    const { segmentIndex, candidateIndices } = group;
    const segment = sample.segments[segmentIndex];
    const scores = candidateIndices.map((candidateIndex) => ({
      candidateIndex,
      value: score({ sample, segment, segmentIndex, candidate: segment.candidates[candidateIndex], candidateIndex }),
    }));
    if (scores.some(({ value }) => !Number.isFinite(value))) continue;

    const baseline = scores[0];
    scores.sort((left, right) => right.value - left.value);
    const [best, second] = scores;
    if (best === baseline || best.value - second.value <= minLead ||
        best.value - baseline.value <= minGain) {
      continue;
    }

    const { candidateIndex } = best;
    return {
      segments: promoteInGroup(sample.segments, group, candidateIndex),
      promotion: { segmentIndex, candidateIndex },
    };
  }
  return { segments: sample.segments, promotion: null };
}
