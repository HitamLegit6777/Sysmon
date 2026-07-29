import http from "node:http";import fs from "node:fs";
const P=process.env.CDP_PORT||"9222";const APP=process.env.APP_URL||"http://localhost:8099";
const OUT=process.env.OUT_DIR||"/root/sysmon/docs";
fs.mkdirSync(OUT,{recursive:true});
const g=(p)=>new Promise((r,j)=>http.get(`http://localhost:${P}${p}`,x=>{let b="";x.on("data",c=>b+=c);x.on("end",()=>r(JSON.parse(b)))}).on("error",j));
let id=0;const pend=new Map();
const send=(ws,m,p={})=>{const i=++id;ws.send(JSON.stringify({id:i,method:m,params:p}));return new Promise((res,rej)=>{pend.set(i,{res,rej});setTimeout(()=>{if(pend.has(i)){pend.delete(i);rej(new Error("t "+m))}},15000)})};
const ev=async(ws,e)=>{const r=await send(ws,"Runtime.evaluate",{expression:e,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const t=(await g("/json/list")).find(x=>x.type==="page");
const ws=new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r,j)=>{ws.addEventListener("open",r,{once:true});ws.addEventListener("error",j,{once:true})});
ws.addEventListener("message",e=>{const m=JSON.parse(e.data);if(m.id&&pend.has(m.id)){const p=pend.get(m.id);pend.delete(m.id);m.error?p.rej(new Error(m.error.message)):p.res(m.result)}});
await send(ws,"Page.enable");await send(ws,"Runtime.enable");await send(ws,"Network.enable");await send(ws,"Network.setCacheDisabled",{cacheDisabled:true});
await send(ws,"Emulation.setDeviceMetricsOverride",{width:1440,height:960,deviceScaleFactor:2,mobile:false});
// reset appearance once
await send(ws,"Page.navigate",{url:`${APP}/?r=${Date.now()}#/info`});await sleep(1500);
await ev(ws,`(()=>{localStorage.setItem('sysmon.accent','default');localStorage.setItem('sysmon.theme','dark');delete document.documentElement.dataset.accent;document.documentElement.dataset.theme='dark';})()`);
async function shot(file){const s=await send(ws,"Page.captureScreenshot",{format:"png"});fs.writeFileSync(`${OUT}/${file}`,Buffer.from(s.data,"base64"));console.log("saved",file);}
async function go(route,wait=2600){await send(ws,"Page.navigate",{url:`${APP}/?r=${Date.now()}#/${route}`});await sleep(wait);}
async function hoverChart(sel=".chart-lg canvas,.chart-xl canvas,canvas",fx=0.66){const box=await ev(ws,`(()=>{const c=document.querySelector('${sel}');if(!c)return null;const r=c.getBoundingClientRect();return{x:Math.round(r.left+r.width*${fx}),y:Math.round(r.top+r.height*0.5)}})()`);if(box){await send(ws,"Input.dispatchMouseEvent",{type:"mouseMoved",x:box.x,y:box.y});await sleep(450);}}
// overview
await go("overview",3200);await shot("overview.png");
// cpu with temp/load tooltip
await go("cpu",3400);await hoverChart();await shot("cpu.png");
// memory with top-proc tooltip
await go("memory",3400);await hoverChart();await shot("memory.png");
// processes
await go("processes",2800);await shot("processes.png");
// alerts with two rules expanded
await go("alerts",2500);await ev(ws,`(()=>{[...document.querySelectorAll('.rule-head')].slice(0,2).forEach(h=>h.click());})()`);await sleep(600);await shot("alerts.png");
ws.close();
console.log("done");
