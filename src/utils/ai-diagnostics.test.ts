import { buildAiDiagnosticsText } from './ai-diagnostics';

describe('AI diagnostics redaction', () => {
  it('contains only bounded response metadata', () => {
    const text = buildAiDiagnosticsText({
      errorCode: 'TRUNCATED_OUTPUT',
      errorDiagnostics: {
        protocol: 'responses',
        status: 200,
        contentType: 'application/json',
        responseChars: 4096,
        responseShape: 'output_text',
        incompleteReason: 'max_output_tokens',
      },
    });
    const parsed = JSON.parse(text);
    expect(parsed).toEqual(expect.objectContaining({
      errorCode: 'TRUNCATED_OUTPUT',
      status: 200,
      responseChars: 4096,
    }));
    expect(text).not.toContain('apiKey');
    expect(text).not.toContain('bookmark');
    expect(text).not.toContain('https://');
  });
});
