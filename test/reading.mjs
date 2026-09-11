import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const result = await build({ stdin: { contents: 'export * from "./src/ui/reading"; export {TFile,TFolder} from "obsidian";', resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', write: false, plugins: [{ name: 'boundaries', setup(b) {
 b.onResolve({filter:/^obsidian$/},()=>({path:new URL('./ai-ui-stub.mjs',import.meta.url).pathname.replace(/^\/(\w:)/,'$1')}));
 b.onResolve({filter:/\/pdf\/(pdfjs|ops)$/},()=>({path:'pdf',namespace:'stub'}));
 b.onLoad({filter:/.*/,namespace:'stub'},()=>({contents:'export const extractText=async()=>[]; export const getMetadata=()=>({});'}));
}}] });
const module={exports:{}};vm.runInThisContext('(function(require,module,exports){'+result.outputFiles[0].text+'\n})')(createRequire(import.meta.url),module,module.exports);
const {TFile,TFolder,ensureReadingNote,readingNotePath,appendAiAnswer,appendQuote,appendReference}=module.exports;
globalThis.notices=[];
const files=new Map(), contents=new Map();
function file(path){const f=Object.assign(new TFile(),{path,name:path.split('/').at(-1),basename:path.split('/').at(-1).replace(/\.[^.]+$/,''),parent:{path:path.split('/').slice(0,-1).join('/')}});files.set(path,f);return f;}
let created=0;
const plugin={settings:{readingFolder:'Notes',organizeFolders:true,defaultTemplate:'builtin'},loadPdf:async()=>null,app:{
 vault:{getAbstractFileByPath:p=>files.get(p),getMarkdownFiles:()=>[...files.values()].filter(f=>f.path.endsWith('.md')),createFolder:async p=>files.set(p,Object.assign(new TFolder(),{path:p})),create:async(p,text)=>{assert.ok(!files.has(p));created++;const f=file(p);contents.set(p,text);return f;},process:async(f,fn)=>contents.set(f.path,fn(contents.get(f.path)))},
 metadataCache:{getFileCache:f=>({frontmatter:{source:contents.get(f.path)?.match(/^source: "(.*)"/m)?.[1]}}),getFirstLinkpathDest:p=>files.get(p)},
 fileManager:{renameFile:()=>{throw Error('Creating a note must never move a PDF');}}
}};
const a=file('A/paper.pdf'),b=file('B/paper.pdf');
assert.notEqual(readingNotePath(plugin,a),readingNotePath(plugin,b));
const [n1,n2]=await Promise.all([ensureReadingNote(plugin,a),ensureReadingNote(plugin,a)]);
assert.equal(n1,n2);assert.equal(created,1);
const other=await ensureReadingNote(plugin,b);assert.notEqual(other.path,n1.path);
await appendAiAnswer(plugin,a,'Question','AI answer');
await appendQuote(plugin,a,{text:'Exact excerpt',link:'[[A/paper.pdf#page=2]]',page:2});
const note=contents.get(n1.path);
assert.match(note,/<!-- pdf-toolkit:ai -->[\s\S]*AI answer/);
assert.match(note,/<!-- pdf-toolkit:highlights -->[\s\S]*Exact excerpt/);
assert.ok(note.indexOf('Exact excerpt')<note.indexOf('<!-- pdf-toolkit:ai -->'));
contents.set(n1.path,note.replace(/## .*\n<!-- pdf-toolkit:references -->/,'## Renamed references\n<!-- pdf-toolkit:references -->'));
await appendReference(plugin,a,{text:'A reference to save'},'https://example.test');
assert.match(contents.get(n1.path),/## Renamed references[\s\S]*A reference to save/);
plugin.settings.readingFolder='';assert.equal(readingNotePath(plugin,a),'A/paper.reading.md');
console.log('Reading note checks passed: same-name isolation, concurrent creation, no PDF moves, separate excerpts and AI, stable reference section.');
