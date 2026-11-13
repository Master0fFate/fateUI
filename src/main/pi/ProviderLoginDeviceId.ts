import { getAgentDir, SettingsManager } from '@earendil-works/pi-coding-agent';

export async function providerLoginDeviceId(agentDir = getAgentDir()): Promise<string> {
  const settings = SettingsManager.create(agentDir, agentDir, { projectTrusted: false });
  const deviceId = settings.getOrCreateDeviceId();
  await settings.flush();
  if (settings.drainErrors().some((error) => error.scope === 'global')) throw new Error('The installation device ID could not be saved in SDK settings.');
  if (typeof deviceId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(deviceId)) throw new Error('The installation device ID in SDK settings is invalid.');
  return deviceId;
}
