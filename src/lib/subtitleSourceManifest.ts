import {readFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
export type DownloadSource={source:'aniall'|'anissia';id:string;title:string;episode:string;creator:string;source_url:string};
export type DownloadRecord={sha256:string;sources:DownloadSource[]};
let cached:{root:string;mtime:number;size:number;files:Record<string,DownloadRecord>}|null=null;
export async function readSubtitleSourceManifest(root:string):Promise<Record<string,DownloadRecord>> {
  try {
    const file=path.join(root,'.weekly-subtitle-sources.json'),info=await stat(file);
    if(info.size>32*1024*1024) throw new Error('Subtitle source manifest too large');
    if(cached?.root===root && cached.mtime===info.mtimeMs && cached.size===info.size) return cached.files;
    const value=JSON.parse(await readFile(file,'utf8'));
    if(value.version!==1 || !value.files || typeof value.files!=='object' || Array.isArray(value.files)) throw new Error('Invalid subtitle source manifest');
    for(const [relative,record] of Object.entries(value.files) as Array<[string,DownloadRecord]>) {
      if(!/^(aniall|anissia)_subtitles\//.test(relative) || relative.split('/').some(p=>!p || p==='.' || p==='..')
        || !record || !/^[a-f\d]{64}$/.test(record.sha256) || !Array.isArray(record.sources) || !record.sources.length
        || record.sources.some(s=>!['aniall','anissia'].includes(s.source) || !/^[1-9]\d*$/.test(s.id)
          || !relative.startsWith(`${s.source}_subtitles/`))) throw new Error('Invalid subtitle file source');
    }
    cached={root,mtime:info.mtimeMs,size:info.size,files:value.files};return value.files;
  } catch(error:any) {if(error.code==='ENOENT')return {};throw error;}
}
export const sourceDigestMatches=(record:DownloadRecord|undefined,bytes:Buffer)=>!record || createHash('sha256').update(bytes).digest('hex')===record.sha256;
// The first recorded source is stable when identical bytes gain another provenance.
export const sourceTrackIdentity=(record:DownloadRecord|undefined)=>record ? `${record.sources[0].source}:${record.sources[0].id}` : '';
