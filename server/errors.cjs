/*
 * Errors an agent can act on.
 *
 * A plain Error message is fine for a person reading a log and useless for a
 * model deciding its next call. Every failure that has a *shape* — a wrong
 * field, a missing layer, two candidates, a stale revision — is raised as a
 * PhotoError so the tool result can carry the field, the allowed values, the
 * candidates and a corrected call. The caller can then recover in one step
 * instead of guessing.
 *
 * The codes are deliberately a small closed set: an agent can branch on them,
 * and a new code is a conscious addition to the public surface.
 */
'use strict';

const CODES = [
  'INVALID_ARGUMENT',
  'NOT_FOUND',
  'AMBIGUOUS_TARGET',
  'REVISION_CONFLICT',
  'UNSUPPORTED',
  'LIMIT_EXCEEDED',
  'MISSING_FONT',
  'MISSING_RESOURCE',
  'OUT_OF_BOUNDS',
  'RESOURCE_EXHAUSTED',
  'INTERNAL',
];

class PhotoError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'PhotoError';
    this.code = CODES.indexOf(code) === -1 ? 'INTERNAL' : code;
    this.details = details && typeof details === 'object' ? details : {};
  }

  toJSON() {
    return Object.assign(
      {
        code: this.code,
        message: this.message,
        retryable: this.details.retryable === true,
      },
      this.details
    );
  }
}

function photoError(code, message, details) {
  return new PhotoError(code, message, details);
}

/**
 * Best-effort mapping for legacy `throw new Error(...)` call sites. The message
 * is still the source of truth; the code only helps a caller branch.
 */
function classify(message) {
  const text = String(message || '');
  if (/REVISION_CONFLICT|revision/i.test(text) && /changed|stale|conflict/i.test(text)) {
    return 'REVISION_CONFLICT';
  }
  if (/No layer with id|No layer named|does not exist|has no mask|no raster layer/i.test(text)) {
    return 'NOT_FOUND';
  }
  if (/ambiguous|several layers|more than one layer/i.test(text)) return 'AMBIGUOUS_TARGET';
  if (/outside the (canvas|layer|image)/i.test(text)) return 'OUT_OF_BOUNDS';
  if (/at most|beyond the|larger than|limit/i.test(text)) return 'LIMIT_EXCEEDED';
  if (/font/i.test(text) && /missing|not installed|no font/i.test(text)) return 'MISSING_FONT';
  if (/could not open|missing from extension storage|backend|native engine/i.test(text)) {
    return 'UNSUPPORTED';
  }
  if (/must be|needs |required|unknown |unsupported |one of/i.test(text)) {
    return 'INVALID_ARGUMENT';
  }
  return 'INTERNAL';
}

/** Pull `allowed: a, b, c` out of the messages that already list their values. */
function allowedFrom(message) {
  const text = String(message || '');
  const match = /(?:one of|takes|use one of):\s*([^.;]+)/i.exec(text);
  if (!match) return undefined;
  const values = match[1]
    .split(',')
    .map((entry) => entry.trim().replace(/^["']|["']$/g, ''))
    .filter((entry) => entry && entry.length < 40);
  return values.length > 1 ? values : undefined;
}

function structured(error, context) {
  const settings = context || {};
  if (error instanceof PhotoError) {
    const payload = error.toJSON();
    if (!payload.suggested_call && settings.suggestedCall) {
      payload.suggested_call = settings.suggestedCall;
    }
    return payload;
  }
  const message = error instanceof Error ? error.message : String(error);
  const code = classify(message);
  const payload = {
    code: code,
    message: message,
    retryable: false,
  };
  const allowed = allowedFrom(message);
  if (allowed) payload.allowed = allowed;
  if (settings.field) payload.field = settings.field;
  if (settings.suggestedCall && code !== 'INTERNAL') {
    payload.suggested_call = settings.suggestedCall;
  }
  return payload;
}

module.exports = {
  CODES: CODES,
  PhotoError: PhotoError,
  classify: classify,
  photoError: photoError,
  structured: structured,
};
