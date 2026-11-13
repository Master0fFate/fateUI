import { describe, expect, it } from 'vitest';
import { releaseMetadata } from './releaseMetadata';

describe('application release metadata', () => {
  it('exposes the 2.3 machine version and Hyper display title', () => {
    expect(releaseMetadata).toEqual({
      version: '2.3.0',
      releaseName: 'Hyper',
      displayVersion: 'V2.3.0 - Hyper',
    });
  });
});
