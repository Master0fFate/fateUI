import { describe, expect, it } from 'vitest';
import { releaseMetadata } from './releaseMetadata';

describe('application release metadata', () => {
  it('exposes the 2.2 beta machine version and Radian display title', () => {
    expect(releaseMetadata).toEqual({
      version: '2.2.0-beta',
      releaseName: 'Radian',
      displayVersion: 'V2.2.0-beta - Radian',
    });
  });
});
