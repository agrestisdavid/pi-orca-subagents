import {createJiti} from 'jiti';
const jiti=createJiti(import.meta.url,{interopDefault:true});
await jiti.import('./src/tui-host/workflow-host.ts').catch(error=>{console.error(error);process.exit(1);});
