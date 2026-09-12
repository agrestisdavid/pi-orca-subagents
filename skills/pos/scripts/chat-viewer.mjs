import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

export const safeText = text => String(text ?? '').replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1b[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return JSON.stringify(content ?? '', null, 2);
  return content.map(p => {
    if (p.type === 'text') return p.text;
    if (p.type === 'thinking') return `[Thinking]\n${p.thinking || p.text || '(not present in source)'}`;
    if (p.type === 'toolCall') return `[Tool call ${p.name} · ${p.id}]\n${JSON.stringify(p.arguments, null, 2)}`;
    if (p.type === 'image' || p.type === 'audio') return `[${p.type} attachment: ${p.mimeType || ''}; binary content available in source file]`;
    return JSON.stringify(p, null, 2);
  }).join('\n');
}
export function recordText(record, kind) {
  if (kind === 'output') return record;
  const message = typeof record.message === 'object' && record.message !== null ? record.message : undefined;
  if (message) return `${record.timestamp || message.timestamp || record.ts || ''}  ${message.role || 'message'}${message.toolName ? ` · ${message.toolName} · ${message.toolCallId || ''}` : ''}${message.isError ? ' [ERROR]' : ''}\n${contentText(message.content)}${message.errorMessage ? '\n[ERROR] ' + message.errorMessage : ''}`;
  if (record.type === 'session') return '';
  if (record.recordType === 'truncated' || record.type === 'compaction' || /prun|overflow/.test(record.customType || '')) return `[SOURCE NOTICE: ${record.type || record.recordType} / ${record.customType || ''}]\n${JSON.stringify(record, null, 2)}`;
  if (record.type === 'custom_message') return `[${record.customType || 'custom message'}]\n${contentText(record.content)}`;
  if (record.type === 'branch_summary') return `[Branch summary: earlier source was summarized]\n${record.summary || ''}`;
  if (kind === 'transcript' || record.type === 'message') return JSON.stringify(record, null, 2);
  return '';
}

// Keep offsets, not chat bodies, in memory. Retry incomplete JSONL records.
export class LineIndex {
  constructor(file, kind = 'session') { this.file=file;this.kind=kind;this.offset=0;this.entries=[];this.invalid=0;this.header=null;this.size=0; }
  refresh() {
    if(this.entries.at(-1)?.partial)this.entries.pop();
    const stat=fs.statSync(this.file);
    if (stat.size < this.offset || (this.mtime && stat.mtimeMs !== this.mtime && stat.size === this.size)) { this.offset=0;this.entries=[];this.invalid=0;this.header=null; }
    this.size=stat.size;this.mtime=stat.mtimeMs;
    const fd=fs.openSync(this.file,'r');
    let pending=Buffer.alloc(0),start=this.offset,pos=this.offset;
    try {
      while(pos<stat.size) {
        const b=Buffer.alloc(Math.min(65536,stat.size-pos));const n=fs.readSync(fd,b,0,b.length,pos);if(!n)break;pos+=n;
        pending=Buffer.concat([pending,b.subarray(0,n)]);
        let end;
        while((end=pending.indexOf(10))!==-1) {
          const bytes=pending.subarray(0,end);let value;
          try { value=this.kind==='output'?bytes.toString('utf8'):JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,'')); }catch {this.invalid++;}
          if(value!==undefined) {
            if(value.type==='session')this.header=value;
            if(recordText(value,this.kind))this.entries.push({offset:start,length:end,id:value.id,parentId:value.parentId,timestamp:value.timestamp});
          }
          start+=end+1;pending=pending.subarray(end+1);this.offset=start;
        }
      }
    } finally {fs.closeSync(fd);}
    this.partial=stat.size-this.offset;
    if(this.kind==='output'&&this.partial)this.entries.push({offset:this.offset,length:this.partial,partial:true});
    return this.entries.length;
  }
  read(entry) {
    const fd=fs.openSync(this.file,'r'),b=Buffer.alloc(entry.length);
    try {fs.readSync(fd,b,0,b.length,entry.offset);}finally {fs.closeSync(fd);}
    const raw=b.toString('utf8');return safeText(recordText(this.kind==='output'?raw:JSON.parse(raw),this.kind));
  }
}

export class ChatModel {
  constructor(runId,asyncDir,index) {this.runId=runId;this.asyncDir=asyncDir;this.childIndex=index;this.cache=new Map();this.inheritedIds=new Set();}
  refresh() {
    const status=readJson(path.join(this.asyncDir,'status.json'));
    if(status.runId!==this.runId)throw Error('RunId does not match status.json');
    const step=status.steps?.[this.childIndex];if(!step)throw Error('Child not present in native status');
    this.status=status;this.step=step;
    const session=step.sessionFile||(status.steps.length===1?status.sessionFile:null);
    const choices=[[session,'session'],[step.transcriptPath,'transcript'],[path.join(this.asyncDir,`output-${this.childIndex}.log`),'output']];
    const source=choices.find(([f])=>typeof f==='string'&&path.isAbsolute(f)&&fs.existsSync(f));
    if(!source){this.notice='Waiting: exact native session and transcript are unavailable.';return;}
    const [file,kind]=source;
    if(this.source?.file!==file||this.source?.kind!==kind){this.source=new LineIndex(file,kind);this.cache.clear();this.parentSource=null;this.inheritedIds.clear();}
    const count=this.source.refresh();
    const parent=this.source.header?.parentSession;
    if(parent&&!this.parentSource&&fs.existsSync(parent)) {
      this.parentSource=new LineIndex(parent);this.parentSource.refresh();
      this.inheritedIds=new Set(this.parentSource.entries.map(x=>x.id).filter(Boolean));
    }
    this.notice=kind==='session'?'Original Pi session · all available records (chronological journal, including branches)':kind==='transcript'?'FALLBACK: native transcript; prompts may be redacted and tool results truncated':'FALLBACK: output log only; original conversation and tool records unavailable';
    if(parent&&!this.parentSource)this.notice+=' · Fork parent unavailable: inherited boundary cannot be verified';
    if(this.source.invalid)this.notice+=` · ${this.source.invalid} malformed source records omitted`;
    if(this.source.partial)this.notice+=' · Waiting for an unfinished source record';
    this.notice+=` · ${count} records indexed`;
  }
  rows(showInherited=false) {
    return (this.source?.entries||[]).filter(e=>showInherited||!this.inheritedIds.has(e.id)).map(entry=>({entry,inherited:this.inheritedIds.has(entry.id)}));
  }
  lines(row,width) {
    const key=`${row.entry.offset}:${row.entry.length}:${width}:${row.inherited}`;let lines=this.cache.get(key);
    if(!lines) {
      lines=[`${row.inherited?'[Inherited fork context] ':''}── ${row.entry.id||'record'} ──`];
      for(const line of this.source.read(row.entry).replace(/\t/g,'    ').split(/\r?\n/)) {
        const chars=Array.from(line);if(!chars.length)lines.push('');
        for(let i=0;i<chars.length;i+=width)lines.push(chars.slice(i,i+width).join(''));
      }
      if(this.cache.size>=8)this.cache.delete(this.cache.keys().next().value);this.cache.set(key,lines);
    }
    return lines;
  }
}

async function main() {
  const [runId,asyncDir,childIndex,title='Pi Bot',maxRefreshes='0']=process.argv.slice(2);
  const model=new ChatModel(runId,path.resolve(asyncDir),Number(childIndex));
  let follow=true,showInherited=false,rowIndex=0,lineIndex=0,refreshes=0,closed=false,frame='';
  const tty=process.stdin.isTTY&&process.stdout.isTTY;
  const move=(amount,rows=model.rows(showInherited),width=Math.max(20,(process.stdout.columns||110)-1))=>{
    if(!rows.length)return;
    while(amount<0){if(lineIndex>0){lineIndex--;amount++;}else if(rowIndex>0){rowIndex--;lineIndex=model.lines(rows[rowIndex],width).length;}else break;}
    while(amount>0){const size=model.lines(rows[rowIndex],width).length;if(lineIndex<size-1){lineIndex++;amount--;}else if(rowIndex<rows.length-1){rowIndex++;lineIndex=0;amount--;}else break;}
  };
  const paint=()=>{
    try{model.refresh();}catch(e){model.notice=`Source unavailable: ${e.message}`;}
    const width=Math.max(20,(process.stdout.columns||110)-1),height=Math.max(5,(process.stdout.rows||30)-7),rows=model.rows(showInherited);
    if(follow){rowIndex=Math.max(0,rows.length-1);lineIndex=rows.length?model.lines(rows[rowIndex],width).length:0;move(-height,rows,width);}
    rowIndex=Math.min(rowIndex,Math.max(0,rows.length-1));
    const page=[];let ri=rowIndex,li=lineIndex;
    while(page.length<height&&ri<rows.length){page.push(...model.lines(rows[ri],width).slice(li,li+height-page.length));ri++;li=0;}
    const next=safeText(`${title} · read-only chat\nRun ${runId} / child ${childIndex} / ${model.step?.agent||''} / ${model.step?.status||model.status?.state||'unknown'}\n${model.notice}\nSource: ${model.source?.file||'(not available)'}\n↑↓ PgUp/PgDn: scroll | Home: first | End/f: follow | c: fork context ${showInherited?'shown':'collapsed'} (${model.inheritedIds.size}) | q: close view\n${follow?'FOLLOW':'BROWSING'} · record ${rowIndex+1}/${rows.length}\n`)+page.join('\n');
    if(next!==frame){process.stdout.write(tty?'\x1b[2J\x1b[H'+next:next+'\n');frame=next;}
  };
  if(tty){
    readline.emitKeypressEvents(process.stdin);process.stdin.setRawMode(true);
    process.stdin.on('keypress',(_text,key)=>{
      if(key?.name==='q'||key?.ctrl&&key.name==='c'){closed=true;return;}
      if(key?.name==='end'||key?.name==='f')follow=true;
      else if(key?.name==='c'){showInherited=!showInherited;rowIndex=0;lineIndex=0;follow=false;}
      else if(key?.name==='home'){follow=false;rowIndex=0;lineIndex=0;}
      else if(['up','down','pageup','pagedown'].includes(key?.name)){follow=false;move(({up:-1,down:1,pageup:-20,pagedown:20})[key.name]);}
      paint();
    });
    process.stdout.write('\x1b[?1049h');
  }
  try{while(!closed){paint();refreshes++;if(Number(maxRefreshes)>0&&refreshes>=Number(maxRefreshes))break;await new Promise(r=>setTimeout(r,750));}}
  finally{if(tty){process.stdin.setRawMode(false);process.stdin.pause();process.stdout.write('\x1b[?1049l');}}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
