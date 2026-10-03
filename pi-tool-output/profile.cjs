// Synthetic expand-all benchmark through pi's real ToolExecutionComponent, no
// transcript contents. Prints one JSON record: the first frame after every call
// expands (what Ctrl+O costs) and the mean of later, unchanged frames.
//
// npm run profile:tool-output -- <groups> <toolsPerGroup> <outputLines> <frames> <width>
// npm run profile:tool-output -- 20 4 200 30 120
//
// Run several times and compare medians against the figures in AGENTS.md.
const path=require("node:path");const fs=require("node:fs");const os=require("node:os");const {createRequire}=require("node:module");
const [G="20", T="4", L="200", F="30", W="120"] = process.argv.slice(2);
const agent=fs.mkdtempSync(path.join(os.tmpdir(),"pi-tool-output-profile-"));process.env.PI_CODING_AGENT_DIR=agent;
(async()=>{
const paths=JSON.parse(fs.readFileSync("tsconfig.paths.json","utf8")).compilerOptions.paths;
const piRoot=path.dirname(path.dirname(paths["@earendil-works/pi-coding-agent"][0]));
const fromPi=createRequire(path.join(piRoot,"package.json"));const {createJiti}=require(fromPi.resolve("jiti"));
const jiti=createJiti(__filename,{moduleCache:false,alias:{"@earendil-works/pi-coding-agent":path.join(piRoot,"dist/index.js"),"@earendil-works/pi-tui":fromPi.resolve("@earendil-works/pi-tui")}});
const ca=await jiti.import(path.join(piRoot,"dist/index.js"));const tui=await jiti.import(fromPi.resolve("@earendil-works/pi-tui"));
ca.initTheme(undefined,false);
const f=await jiti.import(path.resolve("pi-tool-output/index.ts"),{default:true});const tools=new Map();const h=new Map();
f({registerTool(t){tools.set(t.name,t)},registerCommand(){},registerShortcut(){},on(n,x){h.set(n,x)}});
await h.get("session_start")({},{mode:"tui",ui:{notify(){}}});
const chat=new tui.Container();const ui={children:[chat],requestRender(){}};
const comps=[];
const out=Array.from({length:+L},(_,i)=>`output line ${i} `+"x".repeat(60)).join("\n");
for(let g=0;g<+G;g++){
  chat.addChild(new tui.Markdown(`assistant text ${g}`,1,0,ca.getMarkdownTheme()));
  for(let t=0;t<+T;t++){
    const name=["read","bash","grep","ls"][t%4];
    const args=name==="bash"?{command:"python3 - <<'PY'\n"+"print(1)\n".repeat(30)+"PY",timeout:90}:name==="read"?{path:`f${g}.ts`}:name==="grep"?{pattern:"x",path:"src"}:{path:"."};
    const c=new ca.ToolExecutionComponent(name,`${g}-${t}`,args,{showImages:false},tools.get(name),ui,process.cwd());
    chat.addChild(c);c.setArgsComplete();c.markExecutionStarted();c.updateResult({content:[{type:"text",text:out}],details:{}});comps.push(c);
  }
}
const w=+W;
chat.render(w);
let t0=performance.now();for(const c of comps)c.setExpanded(true);const expandMs=performance.now()-t0;
t0=performance.now();let rows=chat.render(w).length;const firstMs=performance.now()-t0;
t0=performance.now();for(let i=0;i<+F;i++)rows=chat.render(w).length;const frameMs=(performance.now()-t0)/+F;
console.log(JSON.stringify({groups:+G,tools:+T,outputLines:+L,rows,expandMs:+expandMs.toFixed(1),firstFrameMs:+firstMs.toFixed(1),steadyFrameMs:+frameMs.toFixed(2)}));
})();
