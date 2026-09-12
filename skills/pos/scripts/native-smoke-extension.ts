// Loaded only by Test-NativeOrcaProgress.mjs in an isolated test host.
import fs from 'node:fs';
import path from 'node:path';
export default function (pi: any) {
 pi.on('session_start', async (_event: any, ctx: any) => {
  const report = path.join(ctx.cwd, 'native-smoke.json');
  const result: any = { startedAt: Date.now(), piBotsViews: 'disabled (extension not loaded)' };
  const save = () => fs.writeFileSync(report, JSON.stringify(result,null,2));
  const requestId = 'native-progress-smoke-' + Date.now();
  const end = setTimeout(() => { result.error='Timed out after 5 minutes; inspect original run, do not repeat';save();process.exit(2); },300000);
  pi.events.on(`subagents:rpc:v1:reply:${requestId}`, async (reply: any) => {
   result.reply = reply; save();
   if (!reply.success) { clearTimeout(end);process.exit(1); }
   const dir = reply.data?.details?.asyncDir;
   if (!dir) { result.error='Missing asyncDir';save();clearTimeout(end);process.exit(1); }
   const poll = setInterval(() => {
    try {
     const status = JSON.parse(fs.readFileSync(path.join(dir,'status.json'),'utf8'));
     result.status=status;save();
     if (['complete','completed','failed','stopped','partial','rejected'].includes(status.state)) {
      clearInterval(poll);clearTimeout(end);setTimeout(()=>process.exit(status.state==='complete'||status.state==='completed'?0:1),1000);
     }
    } catch {}
   },1000);
  });
  setTimeout(() => pi.events.emit('subagents:rpc:v1:request', {version:1,requestId,method:'spawn',params:{agent:'scout',task:'Read README.md in the current directory. Report its one sentence. Do not modify anything or inspect other directories.',async:true,cwd:ctx.cwd,context:'fresh'}}),1000);
 });
}
