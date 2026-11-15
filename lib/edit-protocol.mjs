import { isDeepStrictEqual as same } from 'node:util';

const DEFAULT_TIMEOUT_MS = 120;
const identityKeys = ['clientId', 'serverId', 'sessionId'];
const monotonicNow = () => performance.now();
const status = (value) => ({ status: value });

function sessionIdentity(binding) {
  if (!binding || identityKeys.some((key) => typeof binding[key] !== 'string' || !binding[key])) {
    throw new TypeError('An edit session requires client, server and session IDs');
  }
  return Object.fromEntries(identityKeys.map((key) => [key, binding[key]]));
}

function ownsSession(binding, identity) {
  return binding && identityKeys.every((key) => binding[key] === identity[key]);
}

function validateTimeout(timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('Edit timeout must be finite and positive');
  }
}

// These adapters run on a single owner thread. The binding includes every
// generation to match. The host accounts for this operation's own planned
// writes before publishing a changed binding to the operation in flight.
export function createEditServer({ getBinding, prepare, commit, now = monotonicNow, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  validateTimeout(timeoutMs);
  const identity = sessionIdentity(getBinding());
  let pending;
  let terminal;
  let recovery = false;
  let receiving = false;

  function finalize(sequence, result) {
    pending = undefined;
    terminal = { sequence, result };
    if (result === 'recovery') recovery = true;
    return status(result);
  }

  function expire() {
    if (pending && (!same(getBinding(), pending.binding) || now() >= pending.prepareBy + timeoutMs)) {
      finalize(pending.sequence, 'recovery');
    }
  }

  function prepared() {
    if (now() >= pending.prepareBy) return status('expired');
    return { status: 'prepared', plan: structuredClone(pending.plan) };
  }

  function handle(verb, message) {
    expire();
    const { sequence, binding } = message;
    if (!Number.isSafeInteger(sequence) || sequence < 1 || !ownsSession(binding, identity) ||
        binding.privacy === 'PASSWORD' || !same(binding, getBinding())) {
      return status('rejected');
    }

    if (sequence === terminal?.sequence && ['query', 'ack', 'cancel'].includes(verb)) {
      return status(terminal.result);
    }
    if (recovery) return status('rejected');

    if (sequence === pending?.sequence) {
      if (verb === 'cancel') return finalize(sequence, 'cancelled');
      if (verb === 'abandon') return finalize(sequence, 'recovery');
      if (verb === 'query') return prepared();
      if (verb === 'prepare' && message.prepareBy === pending.prepareBy && same(message.input, pending.input)) {
        return prepared();
      }
      if (verb === 'ack' && Number.isFinite(message.ackBy) && now() < message.ackBy &&
          message.ackBy <= pending.prepareBy + timeoutMs) {
        try {
          commit(structuredClone(pending.plan), structuredClone(binding));
        } catch {
          return finalize(sequence, 'recovery');
        }
        return finalize(sequence, 'committed');
      }
      return status('rejected');
    }

    const lastSequence = terminal?.sequence ?? 0;
    if (verb === 'query' && sequence <= lastSequence) return status('unknown');
    if (pending || sequence !== lastSequence + 1) return status('rejected');
    if (verb === 'query') return status('not-received');
    if (verb === 'cancel') return finalize(sequence, 'cancelled');
    if (verb === 'abandon') return finalize(sequence, 'recovery');
    if (verb !== 'prepare' || !Number.isFinite(message.prepareBy)) return status('rejected');
    if (now() >= message.prepareBy) return status('expired');
    if (message.prepareBy > now() + timeoutMs) return status('rejected');

    const request = structuredClone(message);
    try {
      const plan = prepare(structuredClone(request.input), structuredClone(request.binding));
      pending = { ...request, plan: structuredClone(plan) };
    } catch {
      return finalize(sequence, 'recovery');
    }
    expire();
    return pending ? prepared() : status('recovery');
  }

  return {
    receive(verb, message) {
      if (receiving) throw new Error('Server receive is serialized on its owner thread');
      receiving = true;
      try {
        return handle(verb, message);
      } finally {
        receiving = false;
      }
    },
    expire,
  };
}

// send models a correlated request/reply. Undefined or a transport exception
// means no usable reply and does not say whether the server received it.
// apply reports 'applied', 'unchanged', or 'indeterminate'. An exception is
// indeterminate because the host may already have changed the document.
export function createEditClient({ getBinding, send, apply, now = monotonicNow, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  validateTimeout(timeoutMs);
  const identity = sessionIdentity(getBinding());
  let sequence = 0;
  let operation;
  let recovery = false;
  let stepping = false;

  function request(verb, extra) {
    const message = structuredClone({ sequence: operation.sequence, binding: operation.binding, ...extra });
    try {
      return send(verb, message);
    } catch {
      return undefined;
    }
  }

  function finalize(result) {
    operation = undefined;
    return result;
  }

  function recover() {
    recovery = true;
    request('abandon');
    return finalize('recovery');
  }

  function advance() {
    if (recovery) return 'recovery';
    if (!operation) return 'idle';
    const { binding, phase, prepareBy, ackBy } = operation;
    if (!same(getBinding(), binding) || now() >= (ackBy ?? prepareBy)) return recover();

    if (phase === 'apply') {
      let result;
      try {
        result = apply(structuredClone(operation.plan), structuredClone(binding));
      } catch {
        return recover();
      }
      const completedAt = now();
      operation.plan = undefined;
      if (result === 'applied' && completedAt < prepareBy && same(getBinding(), binding)) {
        operation.ackBy = completedAt + timeoutMs;
        operation.phase = 'ack';
      } else if (result === 'unchanged') {
        operation.phase = 'cancel';
      } else {
        return recover();
      }
      return 'pending';
    }

    const extra = phase === 'prepare' ? { prepareBy, input: operation.input } :
      phase === 'ack' ? { ackBy } : undefined;
    const reply = request(phase, extra);
    if (!same(getBinding(), binding) || now() >= (ackBy ?? prepareBy)) return recover();
    if (!reply) {
      if (phase === 'prepare') operation.phase = 'query';
      return 'pending';
    }
    if ((phase === 'prepare' || phase === 'query') && reply.status === 'prepared') {
      operation.input = undefined;
      operation.plan = structuredClone(reply.plan);
      operation.phase = 'apply';
    } else if (phase === 'query' && reply.status === 'not-received') {
      operation.phase = operation.retried ? 'cancel' : 'prepare';
      operation.retried = true;
    } else if (phase === 'ack' && reply.status === 'committed') {
      return finalize('committed');
    } else if (phase === 'cancel' && reply.status === 'cancelled') {
      return finalize('cancelled');
    } else {
      return recover();
    }
    return 'pending';
  }

  return {
    begin(input) {
      const binding = getBinding();
      if (operation || recovery || !ownsSession(binding, identity) || binding.privacy === 'PASSWORD') {
        throw new Error('Edit session cannot accept an operation in its current state');
      }
      const request = structuredClone({ binding, input });
      operation = { ...request, sequence: ++sequence, prepareBy: now() + timeoutMs, phase: 'prepare' };
      return sequence;
    },
    step() {
      if (stepping) throw new Error('Client step is serialized on its owner thread');
      stepping = true;
      try {
        return advance();
      } finally {
        stepping = false;
      }
    },
  };
}
