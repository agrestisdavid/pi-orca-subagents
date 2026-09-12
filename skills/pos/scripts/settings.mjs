import fs from 'node:fs';
import path from 'node:path';
import {agentDirectory} from '../../../src/pos/resources.mjs';
import {atomicJson} from '../../../src/tui-host/protocol.mjs';
export {stopOnTabClose} from '../../../src/tui-host/tab-close.mjs';
export const settingsFile = process.env.PI_BOTS_TEST_CONTROL
  ? path.join(process.env.PI_BOTS_TEST_CONTROL, 'pi-bots-settings.json')
  : path.join(agentDirectory(), 'settings.json');
export function saveStopOnTabClose(enabled) {
  if (typeof enabled !== 'boolean') throw Error('stopOnTabClose must be a boolean.');
  const settings = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile,'utf8')) : {};
  settings.piBots = {...settings.piBots,stopOnTabClose:enabled};
  atomicJson(settingsFile, settings);
}
