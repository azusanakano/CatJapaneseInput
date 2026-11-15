const protectedAttributes = new Set([
  'USER_DICTIONARY', 'NO_MODIFICATION', 'COMMAND_CANDIDATE',
  'SPELLING_CORRECTION', 'TYPING_CORRECTION',
]);

/** An omitted or normal kind cannot override a candidate's protection attributes. */
export function isProtectedCandidate(candidate) {
  return candidate.kind === 'protected' ||
    candidate.attributes?.some(attribute => protectedAttributes.has(attribute)) === true;
}
