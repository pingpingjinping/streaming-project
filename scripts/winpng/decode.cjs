// Pixel-exact port of anime-db-download/scripts/winpng_decode.py.
// Decode original pixels, never a scaled thumbnail or a rendered screenshot.
const sharp = require('sharp');
const {safePath} = require('./preview.cjs');
const SIGNATURE = Buffer.from('89504e470d0a1a0a','hex');
const MAX_BYTES = 20*1024*1024, MAX_PIXELS = 8*1024*1024;
const d = (b,c) => ((0x800000+(b&0xff0000)-(c&0xff0000)) |
  (0x8000+(b&0xff00)-(c&0xff00)) | (0x80+(b&255)-(c&255))) & 0xffffff;
function restore(n,ap,version,isC) {
  let value=0x808080+n;
  for(const shift of [16,8,0]) {
    const mask=255<<shift, odd=1<<shift, channel=ap&mask;
    if(version===2) value-=((ap&odd)=== (isC?odd:0)) ? 0x80<<shift : (0x100<<shift)-channel;
    else if(isC) value-=(ap&odd)===0 ? (0x180<<shift)-(channel<<1) : channel+odd;
    else value-=(ap&odd)===0 ? channel : (0x17f<<shift)-(channel<<1);
  }
  return value&0xffffff;
}
function transform(w,h,p,kind) {
  const bx=kind==='149'||kind==='429'?3:2;
  const by=kind==='238'?4:bx;
  if(w%bx||h%by)return null;
  const nx=w/bx,ny=h/by;
  const ow=kind==='149'?nx*2:nx;
  const oh=ny*(kind==='238'?3:kind==='149'||kind==='429'||kind==='124'?2:1);
  const out=new Uint32Array(ow*oh);
  for(let y=0;y<ny;y++)for(let x=0;x<nx;x++) {
    const at=(dx,dy)=>p[(y*by+dy)*w+x*bx+dx], base=y*(oh/ny)*ow+x*(ow/nx);
    if(kind.startsWith('114')) {
      if(kind==='114v1')out[base]=d(at(1,0),at(0,1));
      else {
        const ap=0x808080+at(1,1)-at(0,0),v=kind==='114v2'?2:3;
        out[base]=d(restore(at(1,0),ap,v,false),restore(at(0,1),ap,v,true));
      }
    } else if(kind==='149') {
      out[base]=d(at(0,0),at(1,0));out[base+1]=d(at(2,0),at(2,1));
      out[base+ow+1]=d(at(2,2),at(1,2));out[base+ow]=d(at(0,2),at(0,1));
    } else if(kind==='238') {
      out[base]=d(at(0,0),at(0,1));out[base+ow]=d(at(1,1),at(1,2));
      out[base+2*ow]=d(at(0,3),at(1,3));
    } else if(kind==='429') {
      out[base]=d(at(1,0),at(0,1));out[base+ow]=d(at(1,2),at(2,1));
    } else {
      const a=at(1,1);
      out[base]=((a<<4)&0xc0c0c0)|(at(1,0)&0x3f3f3f);
      out[base+ow]=((a<<6)&0xc0c0c0)|(at(0,1)&0x3f3f3f);
    }
  }
  return [ow,oh,out];
}
function bytes(p,offset,length) {
  const b=Buffer.alloc(length);
  for(let i=0;i<length;i++)b[i]=(p[offset+Math.floor(i/3)] >> (8*(2-i%3)))&255;
  return b;
}
async function raw(w,h,p,depth,budget) {
  if(w<2||h<1)return [];
  const files=[];
  for(let y=0;y<h;) {
    const start=y*w,a=p[start];
    const len=(a&0xffff00)===0?a&255:((a&0x070000)>>11)|((a&0x300)>>5)|(a&7);
    const size=p[start+1]&0xffffff, count=2+Math.ceil(len/3)+Math.ceil(size/3);
    const rows=Math.ceil(count/w);
    if(len>255||size>MAX_BYTES||y+rows>h)return [];
    const data=bytes(p,start+2+Math.ceil(len/3),size);
    if(len===0) {
      if(depth<4 && data.subarray(0,8).equals(SIGNATURE))
        files.push(...await decode(data,depth+1,budget));
    } else {
      let name;
      try{name=new TextDecoder('utf-8',{fatal:true}).decode(bytes(p,start+2,len));}catch{return [];}
      const relative=safePath(name.replaceAll('\\','/').replace(/^\/+|\/+$/g,''));
      if(!relative)return [];
      files.push({path:relative,data});
    }
    y+=rows;
    if(files.length>100 || files.reduce((sum,f)=>sum+f.data.length,0)>MAX_BYTES)return [];
  }
  return files;
}
async function decode(data,depth=0,budget={pixels:0}) {
  if(depth>4||data.length>32*1024*1024||!data.subarray(0,8).equals(SIGNATURE))return [];
  const image=sharp(data,{limitInputPixels:MAX_PIXELS});
  const meta=await image.metadata();
  budget.pixels+=(meta.width||0)*(meta.height||0);
  if(budget.pixels>MAX_PIXELS)throw new Error('pixel_limit');
  const {data:rgb,info}=await image.removeAlpha().toColourspace('srgb').raw().toBuffer({resolveWithObject:true});
  const {width:w,height:h,channels}=info, p=new Uint32Array(w*h);
  for(let i=0;i<p.length;i++)p[i]=(rgb[i*channels]<<16)|(rgb[i*channels+1]<<8)|rgb[i*channels+2];
  for(const kind of ['114v3','114v2','114v1','149','238','429','124']) {
    const value=transform(w,h,p,kind);
    if(value) {const files=await raw(...value,depth,budget);if(files.length)return files;}
  }
  return raw(w,h,p,depth,budget);
}
module.exports={decode,transform};
