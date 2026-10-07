// Local PNG decoder and plain dialogue preview worker for blog playback.
const {previewFiles} = require('./preview.cjs');
const MAX_INPUT = 44 * 1024 * 1024;
async function main() {
  const chunks=[];let length=0;
  for await(const chunk of process.stdin) {
    length+=chunk.length;if(length>MAX_INPUT)throw new Error('input_size_limit');chunks.push(chunk);
  }
  const request=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  let inputs;
  if(request.png) inputs=await require('./decode.cjs').decode(Buffer.from(request.png,'base64'));
  else {
    if(!Array.isArray(request.files) || request.files.length>100)throw new Error('invalid_files');
    inputs=request.files.map(f=>({path:f.path,data:Buffer.from(f.base64||'','base64')}));
  }
  const result=previewFiles(inputs);
  process.stdout.write(JSON.stringify({files:result.files.map(f=>({
    path:f.path,base64:f.data.toString('base64'),generated:f.generated,temporary:f.temporary})),pending:result.pending}));
}
main().catch(error=>{process.stderr.write(String(error.message)+'\n');process.exitCode=1;});
