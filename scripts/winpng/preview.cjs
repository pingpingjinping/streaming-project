// JMK previews intentionally use only the main SAMI dialogue and raw syncs.
// Layout, frame correction, side holds and automation belong to the full
// Chromium conversion performed by the weekly downloader, never this worker.
const MAX_FILE=8*1024*1024, MAX_TOTAL=20*1024*1024;
function safePath(value) {
  if(typeof value!=='string'||!value||value.length>1000||value.startsWith('/')||value.includes('\\'))return null;
  if(value.split('/').some(p=>!p||p==='.'||p==='..'||/[\x00-\x1f*?"<>|:]/.test(p)))return null;
  return value;
}
function previewFiles(inputs) {
  const files=[], pending=[];let total=0;
  const seen=new Map();
  for(const file of inputs) {
    if(!safePath(file.path)||!Buffer.isBuffer(file.data))continue;
    if(!file.data.length||file.data.length>MAX_FILE){pending.push({path:file.path,reason:'input_size_limit'});continue;}
    let out;
    if(/\.jmk$/i.test(file.path)) {
      try {
        const text=new TextDecoder('utf-8',{fatal:true}).decode(file.data)
          .replace(/\r\n?/g,'\n').replace(/<!--[\s\S]*?-->/g,'')
          // Jamaker's compact JMK format replaces sync tags with a zero-width
          // space, milliseconds and optional frame/inner-sync whitespace.
          .replace(/^\u200b(\d+)[ \t]*$/gm,(_,ms)=>`<SYNC Start=${ms}>`);
        const body=/<body\b[^>]*>([\s\S]*?)<\/body\s*>/i.exec(text)?.[1];
        if(!body||!/<sync\s+start=\d+/i.test(body))throw new Error('missing_main_dialogue');
        const dialogue=body.replace(/<(rt|rp)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,'');
        out={path:file.path.replace(/\.jmk$/i,'.smi'),
          data:Buffer.from('\uFEFF<SAMI><BODY>'+dialogue+'</BODY></SAMI>'),generated:true,temporary:true};
      } catch(error){pending.push({path:file.path,reason:String(error.message)});continue;}
    } else if(/\.(ass|ssa|smi|srt|vtt|zip)$/i.test(file.path))out={...file,generated:false,temporary:false};
    else continue;
    // Conflicting exact paths must not masquerade as one successful preview.
    const key=out.path.toLowerCase(),old=seen.get(key);
    if(old&&!old.equals(out.data))throw new Error('conflicting_embedded_paths');
    if(old)continue;
    if(out.data.length>MAX_FILE||total+out.data.length>MAX_TOTAL)throw new Error('output_size_limit');
    seen.set(key,out.data);total+=out.data.length;files.push(out);
  }
  return {files,pending};
}
module.exports={previewFiles,safePath};
