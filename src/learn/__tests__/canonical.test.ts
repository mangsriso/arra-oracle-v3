import { describe, expect, it } from 'bun:test';
import {
  canonicalizeLearnRequest, documentIdentity, renderLearning, requestFingerprint,
} from '../canonical.ts';

describe('arra_learn canonical identity', () => {
  it('normalizes NFC/LF and canonicalizes concepts without trimming pattern whitespace', () => {
    const composed = canonicalizeLearnRequest({
      pattern: ' cafe\u0301\r\nบันทึก  ',
      concepts: [' z ', 'é', 'e\u0301', '', 'z'],
      source: ' Oracle Learn ',
      project: ' Project ',
    });
    expect(composed.pattern).toBe(' café\nบันทึก  ');
    expect(composed.concepts).toEqual(['z', 'é']);
    expect(composed.source).toBe('Oracle Learn');
    expect(composed.project).toBe('Project');
  });

  it('gives reordered equivalent Unicode inputs the same golden fingerprint', () => {
    const a = canonicalizeLearnRequest({
      pattern: 'cafe\u0301\r\nไทย', concepts: ['สอง', 'หนึ่ง', 'สอง'],
    });
    const b = canonicalizeLearnRequest({
      pattern: 'café\nไทย', concepts: ['หนึ่ง', 'สอง'], source: 'Oracle Learn',
    });
    expect(requestFingerprint(a)).toBe(requestFingerprint(b));
    expect(requestFingerprint(a)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('orders canonical concepts by Unicode code point instead of UTF-16 units', () => {
    const value = canonicalizeLearnRequest({ pattern: 'sort', concepts: ['\u{10000}', '\uE000'] });
    expect(value.concepts).toEqual(['\uE000', '\u{10000}']);
  });

  it('uses reserved created_at for a stable cross-midnight Unicode filename', () => {
    const request = canonicalizeLearnRequest({ pattern: 'เรียนรู้ระบบคิว' });
    const fingerprint = requestFingerprint(request);
    const before = Date.parse('2026-08-31T23:59:59.999Z');
    const after = Date.parse('2026-09-01T00:00:00.001Z');
    const identity = documentIdentity(request, fingerprint, before);
    expect(identity.filename).toStartWith('2026-08-31_เรียนรู้ระบบคิว_');
    expect(renderLearning(request, fingerprint, before)).toContain(`created_at: ${before}`);
    expect(documentIdentity(request, fingerprint, after).filename).not.toBe(identity.filename);
  });

  it('truncates a 49-character slug plus an astral letter by code point', () => {
    const request = canonicalizeLearnRequest({ pattern: `${'a'.repeat(49)}𐐀tail` });
    const fingerprint = requestFingerprint(request);
    const identity = documentIdentity(request, fingerprint, 0);
    expect(identity.filename).toContain(`${'a'.repeat(49)}𐐨_`);
    expect(identity.filename).not.toContain('�');
  });
});
