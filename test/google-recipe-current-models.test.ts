import { describe, expect, test } from 'bun:test';
import { google } from '../src/core/ai/recipes/google.ts';

describe('Google Gemini recipe current chat models', () => {
  test('includes currently listed generateContent models for Dream routing', () => {
    expect(google.touchpoints.chat?.models).toContain('gemini-2.5-flash');
    expect(google.touchpoints.chat?.models).toContain('gemini-2.5-pro');
    expect(google.touchpoints.chat?.models).toContain('gemini-2.5-flash-lite');
  });
});
