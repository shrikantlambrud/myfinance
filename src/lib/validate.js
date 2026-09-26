'use strict';
const { badRequest } = require('./errors');
const { isISODate } = require('../engine/dates');

/**
 * Validate and clean a request body / query against a schema.
 *   { field: { t: 'str'|'num'|'int'|'date'|'enum'|'bool', req, min, max, values, label, def } }
 * Throws HTTP 400 with { fields: { field: 'message' } } so forms can highlight each problem.
 */
function check(input, schema) {
  const src = input && typeof input === 'object' ? input : {};
  const out = {};
  const errors = {};
  for (const [key, spec] of Object.entries(schema)) {
    const label = spec.label || key;
    let v = src[key];
    const empty = v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
    if (empty) {
      if (spec.req) errors[key] = `${label} is required`;
      else out[key] = spec.def !== undefined ? spec.def : null;
      continue;
    }
    switch (spec.t) {
      case 'str': {
        if (typeof v !== 'string' && typeof v !== 'number') { errors[key] = `${label} must be text`; break; }
        v = String(v).trim();
        if (spec.min && v.length < spec.min) errors[key] = `${label} must be at least ${spec.min} characters`;
        else if (v.length > (spec.max || 255)) errors[key] = `${label} must be at most ${spec.max || 255} characters`;
        else if (spec.pattern && !spec.pattern.test(v)) errors[key] = spec.patternMsg || `${label} is not valid`;
        else out[key] = v;
        break;
      }
      case 'num':
      case 'int': {
        const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, ''));
        if (!Number.isFinite(n)) { errors[key] = `${label} must be a number`; break; }
        if (spec.t === 'int' && !Number.isInteger(n)) { errors[key] = `${label} must be a whole number`; break; }
        if (spec.min !== undefined && n < spec.min) { errors[key] = `${label} must be at least ${spec.min}`; break; }
        if (spec.max !== undefined && n > spec.max) { errors[key] = `${label} must be at most ${spec.max}`; break; }
        out[key] = n;
        break;
      }
      case 'date':
        if (!isISODate(v)) errors[key] = `${label} must be a valid date (YYYY-MM-DD)`;
        else out[key] = v;
        break;
      case 'enum':
        if (!spec.values.includes(v)) errors[key] = `${label} must be one of: ${spec.values.join(', ')}`;
        else out[key] = v;
        break;
      case 'bool':
        out[key] = v === true || v === 1 || v === '1' || v === 'true';
        break;
      default:
        out[key] = v;
    }
  }
  if (Object.keys(errors).length) throw badRequest('Please correct the highlighted fields', { fields: errors });
  return out;
}

module.exports = { check };
