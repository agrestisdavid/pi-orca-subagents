import {createJiti} from 'jiti';
const jiti=createJiti(import.meta.url,{interopDefault:true});
try {await jiti.import('./src/tui-host/agent-host.ts');}
catch(error){console.error(error?.stack||String(error));process.exitCode=1;}
