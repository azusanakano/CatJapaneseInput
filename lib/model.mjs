import { isProtectedCandidate } from './candidate.mjs';
import { extractContext, normalizeReading } from './context.mjs';
import { scoringGroups } from './ranking.mjs';

const format = 'cat-japanese-input-context-model';
const version = 1;
const unicodeVersion = '17.0.0';
const bucketCount = 32_768;
const embeddingWidth = 32;
const firstWidth = 64;
const secondWidth = 32;
const inputWidth = 10 * embeddingWidth + 21;
const learningRate = 0.05;
const modes = ['conversion', 'prediction'];

const parameterLengths = {
  embedding: bucketCount * embeddingWidth,
  firstWeights: inputWidth * firstWidth,
  firstBias: firstWidth,
  secondWeights: firstWidth * secondWidth,
  secondBias: secondWidth,
  conversion: secondWidth,
  prediction: secondWidth,
};

function requireDictionaryHash(hash) {
  if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/u.test(hash)) {
    throw new TypeError('Provide the lowercase dictionary SHA-256 digest.');
  }
}

function boundedFeature(text) {
  if (!text || text.length > 256 || !text.isWellFormed() || [...text].length > 128) return '';
  const normalized = normalizeReading(text);
  return [...normalized].length <= 128 ? normalized : '';
}

function ngrams(text) {
  const points = Array.from(text, char => char.codePointAt(0));
  const counts = new Map();
  let total = 0;
  for (let start = 0; start < points.length; start++) {
    let hash = 2_166_136_261;
    for (let end = start; end < Math.min(start + 3, points.length); end++) {
      hash = Math.imul(hash ^ points[end], 16_777_619);
      const bucket = hash & (bucketCount - 1);
      counts.set(bucket, 1 + (counts.get(bucket) ?? 0));
      total++;
    }
  }
  return Array.from(counts, ([bucket, count]) => [bucket * embeddingWidth, count / total]);
}

function candidateFeatures({ sample, segment, segmentIndex, candidate, candidateIndex }, lines) {
  const surface = candidate.value.normalize('NFC');
  const previous = sample.segments[segmentIndex - 1];
  const next = sample.segments[segmentIndex + 1];
  const base = segment.candidates.find(item => !isProtectedCandidate(item));
  const hasCost = candidate.cost !== undefined && base?.cost !== undefined;
  const groups = [
    ...lines.map(line => line.text),
    boundedFeature(segment.reading), boundedFeature(candidate.reading), boundedFeature(candidate.value),
    boundedFeature(previous?.reading), boundedFeature(previous?.candidates[0]?.value),
    boundedFeature(next?.reading), boundedFeature(next?.candidates[0]?.value),
  ].map(ngrams);
  const scalars = [
    ...lines.flatMap(line => [
      Number(line.state === 'text'), Number(line.state === 'empty'),
      Number(line.readTruncated), Number(line.retentionTruncated),
      Number(line.state === 'text' && line.text.includes(surface)),
    ]),
    Number(previous?.fixed === true), Number(next?.fixed === true),
    Number(candidateIndex !== undefined), (candidateIndex ?? 0) / (8 + (candidateIndex ?? 0)),
    Number(hasCost), hasCost ? Math.tanh((candidate.cost - base.cost) / 1024) : 0,
  ];
  return { groups, scalars };
}

function dense(input, weights, bias) {
  return Float64Array.from(bias.values, (value, row) => {
    const offset = row * input.length;
    let sum = 0;
    for (let i = 0; i < input.length; i++) sum += weights.values[offset + i] * input[i];
    return Math.max(0, sum * weights.scale + value * bias.scale);
  });
}

function forward(model, mode, features) {
  const { values, scale } = model.embedding;
  const input = new Float64Array(inputWidth);
  for (const [field, ngrams] of features.groups.entries()) {
    const offset = field * embeddingWidth;
    for (const [bucketOffset, weight] of ngrams) {
      for (let i = 0; i < embeddingWidth; i++) input[offset + i] += values[bucketOffset + i] * weight;
    }
    for (let i = 0; i < embeddingWidth; i++) input[offset + i] *= scale;
  }
  input.set(features.scalars, input.length - features.scalars.length);
  const hidden1 = dense(input, model.firstWeights, model.firstBias);
  const hidden2 = dense(hidden1, model.secondWeights, model.secondBias);
  const head = model[mode];
  const score = head.scale * hidden2.reduce((sum, value, i) => sum + head.values[i] * value, 0);
  return { input, hidden1, hidden2, score };
}

function projectBackward(weights, activations, outputDerivative, hadRelu) {
  const inputDerivative = new Float64Array(activations.length);
  for (const [row, derivative] of outputDerivative.entries()) {
    const offset = row * activations.length;
    for (let i = 0; i < activations.length; i++) {
      if (!hadRelu || activations[i] > 0) inputDerivative[i] += weights[offset + i] * derivative;
    }
  }
  return inputDerivative;
}

function updateDense(weights, bias, activations, outputDerivative, step) {
  for (const [row, derivative] of outputDerivative.entries()) {
    const offset = row * activations.length;
    bias[row] -= step * derivative;
    for (let i = 0; i < activations.length; i++) weights[offset + i] -= step * derivative * activations[i];
  }
}

function updateGroup(model, { mode, features, positives }) {
  const states = features.map(input => forward(model, mode, input));
  const peak = Math.max(...states.map(state => state.score));
  const positivePeak = Math.max(...states.filter((_, i) => positives[i]).map(state => state.score));
  const all = states.map(state => Math.exp(state.score - peak));
  const positive = states.map((state, i) => positives[i] ? Math.exp(state.score - positivePeak) : 0);
  const total = all.reduce((sum, value) => sum + value, 0);
  const positiveTotal = positive.reduce((sum, value) => sum + value, 0);
  const loss = peak - positivePeak + Math.log(total) - Math.log(positiveTotal);
  if (!Number.isFinite(loss)) throw new Error('Training produced a nonfinite loss.');
  // Compute gradients against the same parameter snapshot for the entire group.
  const head = model[mode].values;
  const gradients = states.map(({ input, hidden1, hidden2 }, i) => {
    const output = all[i] / total - positive[i] / positiveTotal;
    const second = hidden2.map((value, j) => value > 0 ? head[j] * output : 0);
    const first = projectBackward(model.secondWeights.values, hidden1, second, true);
    const features = projectBackward(model.firstWeights.values, input, first, false);
    return { output, second, first, features };
  });

  for (const [i, { output, second, first, features: inputDerivative }] of gradients.entries()) {
    const { input, hidden1, hidden2 } = states[i];
    for (let j = 0; j < hidden2.length; j++) head[j] -= learningRate * output * hidden2[j];
    updateDense(model.secondWeights.values, model.secondBias.values, hidden1, second, learningRate);
    updateDense(model.firstWeights.values, model.firstBias.values, input, first, learningRate);
    for (const [field, ngrams] of features[i].groups.entries()) {
      for (const [bucketOffset, weight] of ngrams) {
        for (let j = 0; j < embeddingWidth; j++) {
          model.embedding.values[bucketOffset + j] -=
            learningRate * weight * inputDerivative[field * embeddingWidth + j];
        }
      }
    }
  }
  return loss;
}

function trainingGroups(samples) {
  const groups = [];
  for (const sample of samples) {
    const eligible = scoringGroups(sample);
    const targets = sample.targets ?? [];
    const accepted = sample.acceptedTexts ?? [];
    if (!Array.isArray(targets) || targets.some(form => !Array.isArray(form) ||
        form.length !== sample.segments.length || form.some(x => typeof x !== 'string' || !x)) ||
        !Array.isArray(accepted) || accepted.some(x => typeof x !== 'string' || !x)) {
      throw new TypeError('Invalid training labels.');
    }
    const lines = extractContext(sample.context ?? null, { leftClipped: sample.leftClipped ?? false });
    for (const { segmentIndex, candidateIndices } of eligible) {
      const segment = sample.segments[segmentIndex];
      const correct = new Set(targets.map(target => target[segmentIndex]));
      if (sample.mode === 'prediction') for (const surface of accepted) correct.add(surface);
      const positives = candidateIndices.map(index => correct.has(segment.candidates[index].value));
      if (!positives.includes(true)) continue;
      groups.push({ sample, segment, segmentIndex, candidateIndices, lines, positives });
    }
  }
  return groups;
}

function randomGenerator(seed) {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function initialize(random) {
  const amplitude = {
    embedding: 0.15,
    firstWeights: Math.sqrt(6 / inputWidth),
    secondWeights: Math.sqrt(6 / firstWidth),
    conversion: Math.sqrt(3 / secondWidth),
    prediction: Math.sqrt(3 / secondWidth),
  };
  return Object.fromEntries(Object.entries(parameterLengths).map(([name, length]) => {
    const limit = amplitude[name];
    const values = limit ? Float32Array.from({ length }, () => (2 * random() - 1) * limit) : new Float32Array(length);
    return [name, { values, scale: 1 }];
  }));
}

function quantize({ values }) {
  let peak = 0;
  for (const value of values) peak = Math.max(peak, Math.abs(value));
  if (!Number.isFinite(peak)) throw new Error('Training produced nonfinite parameters.');
  const scale = peak ? peak / 127 : 1;
  const quantized = Int8Array.from(values, value => Math.round(value / scale));
  return { scale, values: Buffer.from(quantized.buffer).toString('base64') };
}

/** Trains candidate-group softmax and exports a dictionary-bound INT8 model. */
export function trainModel(samples, { dictionarySha256, epochs = 5, seed = 42 } = {}) {
  requireDictionaryHash(dictionarySha256);
  if (!Number.isSafeInteger(epochs) || epochs < 1 || !Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw new TypeError('Training needs a positive epoch count and an unsigned 32-bit seed.');
  }
  const groups = trainingGroups(samples);
  if (!groups.length) throw new Error('No aligned, scorable training group has a positive candidate.');
  const trainedModes = modes.filter(mode =>
    groups.some(group => group.sample.mode === mode && group.positives.includes(false)));

  const random = randomGenerator(seed);
  const model = initialize(random);
  let firstEpochLoss;
  let lastEpochLoss;
  for (let epoch = 0; epoch < epochs; epoch++) {
    for (let i = groups.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [groups[i], groups[j]] = [groups[j], groups[i]];
    }
    let loss = 0;
    for (const { sample, segment, segmentIndex, candidateIndices, lines, positives } of groups) {
      const features = candidateIndices.map(candidateIndex => candidateFeatures({
        sample, segment, segmentIndex, candidate: segment.candidates[candidateIndex], candidateIndex,
      }, lines));
      loss += updateGroup(model, { mode: sample.mode, features, positives });
    }
    lastEpochLoss = loss / groups.length;
    firstEpochLoss ??= lastEpochLoss;
  }
  return {
    format, version, unicodeVersion, dictionarySha256, trainedModes,
    parameters: Object.fromEntries(Object.entries(model).map(([name, value]) => [name, quantize(value)])),
    training: { seed, epochs, learningRate, groups: groups.length, firstEpochLoss, lastEpochLoss },
  };
}

function readParameter(parameter, length, name) {
  if (!parameter || typeof parameter.values !== 'string' ||
      parameter.values.length !== 4 * Math.ceil(length / 3) ||
      !Number.isFinite(parameter.scale) || parameter.scale <= 0 ||
      !Number.isFinite(Math.fround(127 * parameter.scale))) {
    throw new Error('Invalid model parameter ' + name + '.');
  }
  const bytes = Buffer.from(parameter.values, 'base64');
  const values = new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (values.length !== length || bytes.toString('base64') !== parameter.values || values.includes(-128)) {
    throw new Error('Invalid model parameter ' + name + '.');
  }
  return { values, scale: parameter.scale };
}

/** Loads validated weights and returns the scorer used by fixed-candidate evaluation. */
export function loadModel(data, { dictionarySha256 } = {}) {
  requireDictionaryHash(dictionarySha256);
  if (!data || data.format !== format || data.version !== version || data.unicodeVersion !== unicodeVersion) {
    throw new Error('Unsupported model format or Unicode version.');
  }
  if (data.dictionarySha256 !== dictionarySha256) throw new Error('Model dictionary hash mismatch.');
  if (!Array.isArray(data.trainedModes) || data.trainedModes.some(mode => !modes.includes(mode)) ||
      new Set(data.trainedModes).size !== data.trainedModes.length) {
    throw new Error('Invalid model modes.');
  }
  if (Object.keys(data.parameters ?? {}).length !== Object.keys(parameterLengths).length) {
    throw new Error('Invalid model parameter list.');
  }
  const model = Object.fromEntries(Object.entries(parameterLengths).map(([name, length]) =>
    [name, readParameter(data.parameters[name], length, name)]));
  const trainedModes = new Set(data.trainedModes);
  return (input, lines) => trainedModes.has(input.sample.mode) ?
    forward(model, input.sample.mode, candidateFeatures(input, lines)).score : 0;
}
