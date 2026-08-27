import { getAiClassificationJobStatusLabel } from './AiClassificationTaskCard';

describe('AI classification task status labels', () => {
  it('distinguishes a completed preview from a still-running task', () => {
    expect(getAiClassificationJobStatusLabel('awaiting_review')).toBe('已完成，等待预览确认');
    expect(getAiClassificationJobStatusLabel('applied')).toBe('已完成');
    expect(getAiClassificationJobStatusLabel('rolled_back')).toBe('已撤销');
    expect(getAiClassificationJobStatusLabel('classifying')).toBe('后台处理中');
  });
});

