import { describe, expect, it } from 'vitest';
import { releaseMetadata } from './releaseMetadata';

describe('application release metadata', () => {
  it('exposes the 2.2 machine version and an unnamed display title', () => {
    expect(releaseMetadata).toEqual({
      version: '2.2.0',
      displayVersion: 'V2.2.0',
    });
  });
});
