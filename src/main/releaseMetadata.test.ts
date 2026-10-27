import { describe, expect, it } from 'vitest';
import { releaseMetadata } from './releaseMetadata';

describe('application release metadata', () => {
  it('exposes the 2.2 machine version and SpaceTime display title', () => {
    expect(releaseMetadata).toEqual({
      version: '2.2.2',
      releaseName: 'SpaceTime',
      displayVersion: 'V2.2.2 - SpaceTime',
    });
  });
});
