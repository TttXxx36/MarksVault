import { isRuntimeMessage } from './runtime-message';
import { redactLogDetails } from './redacted-log';

describe('runtime message and redacted diagnostics boundary', () => {
  test('accepts typed payload objects and rejects malformed messages', () => {
    expect(isRuntimeMessage({ type: 'GET_SNAPSHOT_INDEX', payload: { query: 'safe' } })).toBe(true);
    expect(isRuntimeMessage({ type: 'GET_SNAPSHOT_INDEX', payload: [] })).toBe(false);
    expect(isRuntimeMessage({ type: '' })).toBe(false);
    expect(isRuntimeMessage({ type: 42 })).toBe(false);
  });

  test('does not expose credentials or user bookmark content in structured details', () => {
    expect(redactLogDetails({ token: 'fake-token', apiKey: 'fake-key', url: 'https://private.example/a', title: 'Private title', count: 2 })).toEqual({
      token: '[redacted]',
      apiKey: '[redacted]',
      url: '[redacted]',
      title: '[redacted]',
      count: 2,
    });
  });
});
