const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const dns = require("dns").promises;
const net = require("net");
const { spawn } = require("child_process");

const PORT = Number(process.env.PORT || 80);
const ROOT = "/tmp/webtoapk";
const GRADLE = "/opt/gradle/bin/gradle";
const SDK = process.env.ANDROID_SDK_ROOT || "/opt/android-sdk";

function send(res, code, body, type="text/plain; charset=utf-8"){
  res.writeHead(code, {"Content-Type": type, "Cache-Control":"no-store"});
  res.end(body);
}
function isPrivateAddress(ip){
  if(net.isIPv4(ip)){
    const p=ip.split(".").map(Number);
    return p[0]===10 || p[0]===127 || (p[0]===169&&p[1]===254) ||
      (p[0]===172&&p[1]>=16&&p[1]<=31) || (p[0]===192&&p[1]===168) ||
      p[0]===0;
  }
  if(net.isIPv6(ip)){
    const x=ip.toLowerCase();
    return x==='::1' || x==='::' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe80:');
  }
  return true;
}
async function safePublicUrl(raw){
  let u;
  try{u=new URL(String(raw||''));}catch{throw new Error("URL preview tidak valid.");}
  if(!['http:','https:'].includes(u.protocol)) throw new Error("Preview hanya mendukung HTTP/HTTPS.");
  const host=u.hostname.toLowerCase();
  if(host==='localhost' || host.endsWith('.localhost') || host.endsWith('.local')) throw new Error("Host lokal tidak dapat dipreview.");
  const ips=net.isIP(host)?[host]:await dns.lookup(host,{all:true}).then(a=>a.map(x=>x.address));
  if(!ips.length || ips.some(isPrivateAddress)) throw new Error("Host tujuan tidak aman untuk preview.");
  return u;
}
async function fetchSite(url, maxBytes=1500000){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),9000);
  try{
    const r=await fetch(url,{redirect:'follow',signal:controller.signal,headers:{'user-agent':'Mozilla/5.0 (compatible; WebToAPK-Preview/1.2; +https://vercel.com/)','accept':'text/html,application/xhtml+xml'}});
    const finalUrl=new URL(r.url);
    const finalHost=finalUrl.hostname;
    const finalIps=net.isIP(finalHost)?[finalHost]:await dns.lookup(finalHost,{all:true}).then(a=>a.map(x=>x.address));
    if(finalIps.some(isPrivateAddress)) throw new Error("Redirect menuju host tidak aman.");
    const type=r.headers.get('content-type')||'';
    if(!type.includes('text/html') && !type.includes('application/xhtml+xml')) return {response:r,html:null,finalUrl};
    const reader=r.body?.getReader();
    if(!reader) return {response:r,html:await r.text(),finalUrl};
    const chunks=[];let total=0;
    while(true){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>maxBytes){reader.cancel();throw new Error('Website terlalu besar untuk preview.');}chunks.push(Buffer.from(value));}
    return {response:r,html:Buffer.concat(chunks).toString('utf8'),finalUrl};
  }finally{clearTimeout(timer)}
}
function proxyHtml(html, baseUrl){
  let out=String(html||'');
  out=out.replace(/<meta[^>]+http-equiv=["']?content-security-policy["']?[^>]*>/gi,'');
  out=out.replace(/<meta[^>]+http-equiv=["']?x-frame-options["']?[^>]*>/gi,'');
  const base='<base href="'+xml(baseUrl.href)+'">';
  if(/<head\b[^>]*>/i.test(out)) out=out.replace(/<head\b[^>]*>/i,m=>m+base);
  else out='<!doctype html><html><head>'+base+'</head><body>'+out+'</body></html>';
  return out;
}
function runtimeInfo(){
  return {ok:true,engine:'android-webview',version:'1.2',vercel:Boolean(process.env.VERCEL),vercelEnv:process.env.VERCEL_ENV||'unknown',runtimeSeconds:Math.floor(process.uptime()),node:process.version,platform:process.platform,arch:process.arch};
}
function safe(s){return String(s||"app").replace(/[^a-zA-Z0-9_-]/g,"_").slice(0,40)||"app";}
function packageName(s){return /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/.test(s||"")?s:"com.webtoapk.app";}
function xml(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&apos;");}
function java(s){return String(s).replace(/\\/g,"\\\\").replace(/"/g,'\\"').replace(/\r/g,"").replace(/\n/g,"\\n");}
function versionCode(v){
  const m=String(v||"1.0").trim().match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?/);
  if(!m) return 1;
  const a=Number(m[1]||0),b=Number(m[2]||0),c=Number(m[3]||0),d=Number(m[4]||0);
  return Math.max(1,Math.min(2100000000,a*1000000+b*10000+c*100+d));
}
function decodeIcon(data){
  if(!data || typeof data !== "string") return null;
  const m=data.match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/i);
  if(!m) throw new Error("Icon harus berformat PNG.");
  const buf=Buffer.from(m[1],"base64");
  if(!buf.length || buf.length>2*1024*1024) throw new Error("Ukuran icon maksimal 2 MB.");
  return buf;
}
function mkdir(p){fs.mkdirSync(p,{recursive:true});}
function write(p,c){mkdir(path.dirname(p));fs.writeFileSync(p,c);}
function run(cmd,args,cwd,timeout=270000){
  return new Promise((resolve,reject)=>{
    const p=spawn(cmd,args,{cwd,env:{...process.env,ANDROID_SDK_ROOT:SDK,ANDROID_HOME:SDK,GRADLE_USER_HOME:"/tmp/gradle-home"}});
    let out="",err="";p.stdout.on("data",d=>out+=d);p.stderr.on("data",d=>err+=d);
    const timer=setTimeout(()=>{p.kill("SIGKILL");reject(new Error("Build timeout"));},timeout);
    p.on("close",code=>{clearTimeout(timer);code===0?resolve(out):reject(new Error((err||out).slice(-7000)||"Gradle failed"));});
  });
}
function project(cfg,dir){
  const pkg=packageName(cfg.pkg), app=safe(cfg.name), url=cfg.url;
  write(path.join(dir,"settings.gradle"),`pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }
dependencyResolutionManagement { repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS); repositories { google(); mavenCentral() } }
rootProject.name="${app}"
include(":app")`);
  write(path.join(dir,"build.gradle"),`plugins { id 'com.android.application' version '8.11.1' apply false }`);
  write(path.join(dir,"gradle.properties"),"org.gradle.jvmargs=-Xmx1536m\nandroid.useAndroidX=true\n");
  write(path.join(dir,"app/build.gradle"),`plugins { id 'com.android.application' }
android { namespace '${pkg}'; compileSdk 36
 defaultConfig { applicationId '${pkg}'; minSdk 23; targetSdk 36; versionCode ${versionCode(cfg.version)}; versionName "${xml(cfg.version || "1.0")}" }
}`);
  write(path.join(dir,"app/src/main/AndroidManifest.xml"),`<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
<uses-permission android:name="android.permission.INTERNET"/>
<application android:theme="@style/AppTheme" android:label="${xml(cfg.name)}" android:icon="@drawable/app_icon" android:usesCleartextTraffic="true">
<activity android:name=".MainActivity" android:screenOrientation="portrait" android:exported="true">
<intent-filter><action android:name="android.intent.action.MAIN"/><category android:name="android.intent.category.LAUNCHER"/></intent-filter>
</activity></application></manifest>`);
  write(path.join(dir,"app/src/main/res/values/styles.xml"),`<resources><style name="AppTheme" parent="android:style/Theme.Material.Light.NoActionBar"><item name="android:fontFamily">sans</item><item name="android:colorAccent">#171922</item><item name="android:navigationBarColor">#000000</item><item name="android:statusBarColor">#ffffff</item><item name="android:windowLightStatusBar">true</item></style></resources>`);
  const icon=decodeIcon(cfg.icon);
  if(icon){ write(path.join(dir,"app/src/main/res/drawable/app_icon.png"),icon); } else {
    // Minimal valid transparent PNG fallback.
    write(path.join(dir,"app/src/main/res/drawable/app_icon.xml"),`<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="108dp" android:height="108dp" android:viewportWidth="108" android:viewportHeight="108"><path android:fillColor="#171922" android:pathData="M0,0h108v108h-108z"/><path android:fillColor="#ffffff" android:pathData="M30,30h48v48h-48z"/></vector>`);
  }
  write(path.join(dir,"app/src/main/java",...pkg.split("."),"MainActivity.java"),`package ${pkg};
import android.app.Activity;import android.os.Bundle;import android.view.View;import android.view.Window;import android.view.WindowManager;import android.webkit.WebSettings;import android.webkit.WebView;import android.webkit.WebViewClient;
public class MainActivity extends Activity{
 WebView web;
 @Override public void onCreate(Bundle b){super.onCreate(b);requestWindowFeature(Window.FEATURE_NO_TITLE);${cfg.fullscreen?`getWindow().setFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN,WindowManager.LayoutParams.FLAG_FULLSCREEN);`:``}web=new WebView(this);WebSettings s=web.getSettings();s.setJavaScriptEnabled(true);s.setDomStorageEnabled(true);s.setDatabaseEnabled(true);s.setLoadWithOverviewMode(true);s.setUseWideViewPort(true);s.setAllowFileAccess(true);s.setMediaPlaybackRequiresUserGesture(false);web.setWebViewClient(new WebViewClient());web.setOverScrollMode(View.OVER_SCROLL_NEVER);web.loadUrl("${java(url)}");setContentView(web);}
 @Override public void onBackPressed(){if(web.canGoBack())web.goBack();else super.onBackPressed();}
}`);
  write(path.join(dir,"gradle/wrapper/gradle-wrapper.properties"),`distributionUrl=https\\://services.gradle.org/distributions/gradle-8.13-bin.zip`);
  write(path.join(dir,"gradlew"),`#!/bin/sh
exec ${GRADLE} "$@"`);
  fs.chmodSync(path.join(dir,"gradlew"),0o755);
}

async function build(cfg){
  if(!cfg || !/^https?:\/\//i.test(cfg.url)) throw new Error("URL must be http or https");
  const dir=path.join(ROOT,crypto.randomUUID());mkdir(dir);project(cfg,dir);
  await run(GRADLE,["--no-daemon","--stacktrace","assembleDebug"],dir,270000);
  const apk=path.join(dir,"app/build/outputs/apk/debug/app-debug.apk");
  if(!fs.existsSync(apk))throw new Error("APK was not produced");
  return {apk,name:safe(cfg.name)+".apk"};
}

const server=http.createServer(async(req,res)=>{
  if(req.method==="GET" && req.url==="/health") return send(res,200,JSON.stringify(runtimeInfo()),"application/json");
  if(req.method==="GET" && req.url.startsWith("/api/site-info")){
    try{
      const q=new URL(req.url,"http://localhost");
      const u=await safePublicUrl(q.searchParams.get("url"));
      const result=await fetchSite(u,600000);
      let title='';
      if(result.html){const m=result.html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);title=(m?m[1]:'').replace(/<[^>]+>/g,'').replace(/\s+/g,' ').trim().slice(0,120);}
      send(res,200,JSON.stringify({ok:true,url:u.href,host:u.hostname,protocol:u.protocol.replace(':','').toUpperCase(),status:result.response.status,title:title||u.hostname,contentType:result.response.headers.get('content-type')||'unknown'}),"application/json");
    }catch(e){send(res,400,JSON.stringify({ok:false,error:e.message}),"application/json");}
    return;
  }
  if(req.method==="GET" && req.url.startsWith("/api/preview")){
    try{
      const q=new URL(req.url,"http://localhost");
      const u=await safePublicUrl(q.searchParams.get("url"));
      const result=await fetchSite(u);
      const type=result.response.headers.get('content-type')||'';
      if(result.html===null){
        return send(res,200,`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;font-family:system-ui;background:#fff;color:#171922;display:grid;place-items:center;min-height:100vh}main{max-width:320px;text-align:center;padding:28px}h3{margin:0 0 8px}p{font-size:13px;color:#747b89;line-height:1.6}</style><main><h3>Preview tersedia di aplikasi</h3><p>Server mengembalikan ${xml(type||'konten non-HTML')}. Tampilan ini tidak dapat dirender sebagai halaman web.</p></main>`,`text/html; charset=utf-8`);
      }
      const html=proxyHtml(result.html,result.finalUrl);
      send(res,200,html,"text/html; charset=utf-8");
    }catch(e){
      send(res,200,`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;font-family:system-ui;background:#f7f8fb;color:#171922;display:grid;place-items:center;min-height:100vh}main{width:min(360px,80%);text-align:center;padding:25px}h3{margin:0 0 8px}p{font-size:12px;color:#747b89;line-height:1.6}span{display:inline-block;margin-top:10px;padding:7px 9px;border-radius:8px;background:#eceff4;font:11px ui-monospace,monospace}</style><main><h3>Preview tidak dapat dimuat</h3><p>Website menolak atau membutuhkan fitur browser yang tidak dapat diproksikan.</p><span>${xml(e.message)}</span></main>`,`text/html; charset=utf-8`);
    }
    return;
  }
  if(req.method==="GET" && (req.url==="/" || req.url==="/index.html")){
    const f=path.join(__dirname,"public/index.html");return send(res,200,fs.readFileSync(f),"text/html; charset=utf-8");
  }
  if(req.method==="POST" && req.url==="/api/build"){
    try{
      let body="";for await(const chunk of req) body+=chunk;
      if(body.length>5000000)throw new Error("Request too large (max 5 MB)");
      const cfg=JSON.parse(body);const result=await build(cfg);
      res.writeHead(200,{"Content-Type":"application/vnd.android.package-archive","Content-Disposition":`attachment; filename="${result.name}"`,"Cache-Control":"no-store"});
      fs.createReadStream(result.apk).pipe(res);
    }catch(e){send(res,500,e.message)}
    return;
  }
  send(res,404,"Not found");
});
server.listen(PORT,"0.0.0.0",()=>console.log("Web to APK server listening on "+PORT));