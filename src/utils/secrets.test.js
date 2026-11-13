const { maskSecret } = require('./secrets');

describe('maskSecret', () => {
  it('shows only the known key prefix and the last 4 characters', () => {
    expect(maskSecret('mr_live_abcdefghijklmnopqrstuvwxyz')).toBe('mr_live_…wxyz');
    expect(maskSecret('mr_test_abcdefghijklmnopqrstuvwxyz')).toBe('mr_test_…wxyz');
  });

  it('shows no prefix of other secrets', () => {
    const masked = maskSecret('whsec_0123456789abcdefghij');
    expect(masked).toBe('…ghij');
    expect(masked).not.toContain('whsec');
  });

  it('hides short values entirely', () => {
    expect(maskSecret('mr_live_short')).toBe('mr_live_****');
    expect(maskSecret('abc')).toBe('****');
  });

  it('handles missing values', () => {
    expect(maskSecret('')).toBe('(not set)');
    expect(maskSecret(undefined)).toBe('(not set)');
  });
});
