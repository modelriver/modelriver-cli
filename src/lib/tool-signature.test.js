const ToolSignature = require('./tool-signature');
const fromPackageRoot = require('../../tool-signature');

// docs/hosted-tools/security.md, "A value to test against"
const VECTOR = {
  secret: 'mrtool_test_4f9a2c7d1e8b3a6f5c0d9e2b7a1f4c8d',
  timestamp: '1794590623',
  callId: 'tc_3f2a9c1d5b7e4a6f8c0d1e2b',
  rawBody: '{"version":2,"type":"tool.call","id":"tc_3f2a9c1d5b7e4a6f8c0d1e2b","tool":"get_sales_summary","arguments":{"period":"this_week"},"end_user":{"id":"user_812","claims":{"plan":"pro"}},"request":{"id":null,"channel_id":"0b5c2a4e-7d1f-4c3a-9e2b-6f8a1d3c5e7b","workflow":"sales_chat","revision_id":"rev_12","round":1,"attempt":1,"mode":"live"}}',
  signature: '5ee0bc5f7ae14a7264dc8f03ccd69713902119d079910a7bee871034cf59f528',
};
// "now" a minute after the vector's timestamp
const NOW = (Number(VECTOR.timestamp) + 60) * 1000;

describe('ToolSignature', () => {
  it('produces the documented signature for the documented body', () => {
    expect(ToolSignature.sign(VECTOR.secret, VECTOR.timestamp, VECTOR.callId, VECTOR.rawBody)).toBe(VECTOR.signature);
    expect(ToolSignature.sign(VECTOR.secret, VECTOR.timestamp, VECTOR.callId, Buffer.from(VECTOR.rawBody))).toBe(VECTOR.signature);
  });

  it('verifies the documented call', () => {
    const call = { ...VECTOR, signature: `v2=${VECTOR.signature}` };
    expect(ToolSignature.check(call, { now: NOW })).toEqual({ valid: true, signatureValid: true, timestampValid: true });
    expect(ToolSignature.verify(call, { now: NOW })).toBe(true);
  });

  it('is exported from the package root as @modelriver/cli/tool-signature', () => {
    expect(fromPackageRoot).toBe(ToolSignature);
  });

  it('accepts any value of a rotated header (newest first, comma-separated)', () => {
    const header = `v2=${'0'.repeat(64)}, v2=${VECTOR.signature}`;
    expect(ToolSignature.verify({ ...VECTOR, signature: header }, { now: NOW })).toBe(true);
  });

  it('accepts several secrets while you rotate', () => {
    const call = { ...VECTOR, secret: ['mrts_new_secret', VECTOR.secret], signature: `v2=${VECTOR.signature}` };
    expect(ToolSignature.verify(call, { now: NOW })).toBe(true);
  });

  it('rejects a bare hex signature (the webhook format) or another version', () => {
    expect(ToolSignature.verify({ ...VECTOR, signature: VECTOR.signature }, { now: NOW })).toBe(false);
    expect(ToolSignature.verify({ ...VECTOR, signature: `v1=${VECTOR.signature}` }, { now: NOW })).toBe(false);
  });

  it('rejects a changed body, call id, timestamp or secret', () => {
    const signature = `v2=${VECTOR.signature}`;
    expect(ToolSignature.verify({ ...VECTOR, signature, rawBody: `${VECTOR.rawBody}\n` }, { now: NOW })).toBe(false);
    // Re-encoded JSON has other bytes
    expect(ToolSignature.verify({ ...VECTOR, signature, rawBody: JSON.stringify(JSON.parse(VECTOR.rawBody), null, 1) }, { now: NOW })).toBe(false);
    expect(ToolSignature.verify({ ...VECTOR, signature, callId: 'tc_other' }, { now: NOW })).toBe(false);
    expect(ToolSignature.verify({ ...VECTOR, signature, timestamp: '1794590624' }, { now: NOW })).toBe(false);
    expect(ToolSignature.verify({ ...VECTOR, signature, secret: 'mrts_wrong' }, { now: NOW })).toBe(false);
  });

  it('rejects a timestamp more than 300 seconds from now, but reports the signature separately', () => {
    const call = { ...VECTOR, signature: `v2=${VECTOR.signature}` };
    const late = (Number(VECTOR.timestamp) + 301) * 1000;
    expect(ToolSignature.check(call, { now: late })).toEqual({ valid: false, signatureValid: true, timestampValid: false });
    expect(ToolSignature.verify(call, { now: (Number(VECTOR.timestamp) + 300) * 1000 })).toBe(true);
    expect(ToolSignature.verify(call, { now: (Number(VECTOR.timestamp) - 301) * 1000 })).toBe(false);
    expect(ToolSignature.verify(call, { now: late, toleranceSeconds: 600 })).toBe(true);
  });

  it('rejects missing or malformed input without throwing', () => {
    expect(ToolSignature.verify({}, { now: NOW })).toBe(false);
    expect(ToolSignature.verify({ ...VECTOR, signature: undefined }, { now: NOW })).toBe(false);
    expect(ToolSignature.verify({ ...VECTOR, signature: 'v2=zz' }, { now: NOW })).toBe(false);
    expect(ToolSignature.verify({ ...VECTOR, secret: '', signature: `v2=${VECTOR.signature}` }, { now: NOW })).toBe(false);
    expect(ToolSignature.verify({ ...VECTOR, timestamp: '17945906.23', signature: `v2=${VECTOR.signature}` }, { now: NOW })).toBe(false);
  });

  it('verifies from request headers', () => {
    const headers = {
      'x-modelriver-timestamp': VECTOR.timestamp,
      'x-modelriver-tool-call-id': VECTOR.callId,
      'x-modelriver-key-id': 'key_1',
      'x-modelriver-signature': `v2=${VECTOR.signature}`,
    };
    expect(ToolSignature.verifyRequest(headers, VECTOR.rawBody, VECTOR.secret, { now: NOW })).toBe(true);
    expect(ToolSignature.verifyRequest({}, VECTOR.rawBody, VECTOR.secret, { now: NOW })).toBe(false);
  });

  it('parses only v2 values from the header', () => {
    expect(ToolSignature.parseHeader('v2=a, v1=b,v2=c ,x')).toEqual(['a', 'c']);
    expect(ToolSignature.parseHeader(undefined)).toEqual([]);
  });
});
