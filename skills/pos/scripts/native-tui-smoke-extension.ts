import fs from "node:fs";
import path from "node:path";
import piBots from "../../../extensions/pi-bots.ts";
export default function(pi:any){
  let tool:any;
  piBots({...pi,registerTool(def:any){if(def.name==="pi_bots")tool=def;pi.registerTool(def);}});
  pi.on("session_start",(_event:any,ctx:any)=>{
    const report=path.join(ctx.cwd,"tui-smoke.json");
    const result:any={startedAt:Date.now()};
    const save=()=>fs.writeFileSync(report,JSON.stringify(result,null,2));
    setTimeout(async()=>{
      try{
        result.start=await tool.execute("tui-smoke",{action:"start",execution:"orca-tui",coordination:"orca",viewMode:"orca",launch:{agent:"scout",task:"Use todo to plan this one reading step. Read README.md in the current directory and report its single sentence, then complete the todo. Do not write files or inspect other directories.",context:"fresh",cwd:ctx.cwd}},undefined,undefined,ctx);save();
        const dir=result.start.details?.asyncDir;
        if(!dir||result.start.isError){result.error="Native launch failed";save();process.exit(1);}
        const monitor=setInterval(()=>{
          try{result.status=JSON.parse(fs.readFileSync(path.join(dir,"status.json"),"utf8"));save();if(["complete","failed","stopped","partial","rejected"].includes(result.status.state)){clearInterval(monitor);setTimeout(()=>process.exit(result.status.state==="complete"?0:1),3500);}}catch{}
        },1000);
      }catch(error){result.error=String(error?.stack||error);save();process.exit(1);}
    },1000);
    setTimeout(()=>{result.error="Smoke test timeout: preserve original IDs and inspect the existing run.";save();process.exit(2);},300000).unref();
  });
}
