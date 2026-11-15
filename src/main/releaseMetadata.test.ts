import { describe, expect, it } from 'vitest';
import manifest from '../../package.json';
import { releaseMetadata } from './releaseMetadata';

describe('application release metadata', () => {
  it('exposes the manifest machine version and display title', () => {
    expect(releaseMetadata).toEqual({
      version: manifest.version,
      releaseName: manifest.releaseName,
      displayVersion: `V${manifest.version} - ${manifest.releaseName}`,
    });
  });
});
