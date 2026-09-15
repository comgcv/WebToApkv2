const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const PORT = Number(process.env.PORT || 80);
const ROOT = "/tmp/webtoapk";
const GRADLE = "/opt/gradle/bin/gradle";
const SDK = process.env.ANDROID_SDK_ROOT || "/opt/android-sdk";
const jobs = new Map();

function send(res, code, body, type="text/plain; charset=utf-8", extra={}) {
  res.writeHead(code, {"Content-Type":type,"Cache-Control":"no-store",...extra});
  res.end(body);
}
function json(res, code, obj){ send(res,code,JSON.stringify(obj),"application/json; charset=utf-8"); }
function safe(s){return String(s||"app").replace(/[^a-zA-Z0-9_-]/g,"_").slice(0,40)||"app";}
function packageName(s){return /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/.test(s||"")?s:"com.webtoapk.app";}
function xml(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&apos;");}
function java(s){return String(s).replace(/\\/g,"\\\\").replace(/"/g,'\\"').replace(/\r/g,"").replace(/\n/g,"\\n");}
function mkdir(p){fs.mkdirSync(p,{recursive:true});}
function write(p,c){mkdir(path.dirname(p));fs.writeFileSync(p,c);}
function versionCode(v){
  const m=String(v||"1.0").match(/^\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if(!m) return 1;
  return Math.min(2100000000, Number(m[1])*1000000 + Number(m[2]||0)*1000 + Number(m[3]||0) || 1);
}
function versionName(v){
  const x=String(v||"1.0").trim();
  return /^\d+(?:\.\d+){0,3}(?:[-+][0-9A-Za-z.-]+)?$/.test(x) ? x : "1.0";
}
function run(cmd,args,cwd,timeout=270000){
  return new Promise((resolve,reject)=>{
    const p=spawn(cmd,args,{cwd,env:{...process.env,ANDROID_SDK_ROOT:SDK,ANDROID_HOME:SDK,GRADLE_USER_HOME:"/tmp/gradle-home"}});
    let out="",err="";
    p.stdout.on("data",d=>out+=d); p.stderr.on("data",d=>err+=d);
    const timer=setTimeout(()=>{p.kill("SIGKILL");reject(new Error("Build timeout"));},timeout);
    p.on("close",code=>{clearTimeout(timer);code===0?resolve(out):reject(new Error((err||out).slice(-7000)||"Gradle failed"));});
  });
}
function decodeDataUrl(dataUrl, expected=""){
  const m=String(dataUrl||"").match(/^data:([^;,]+)(?:;charset=[^;,]+)?;base64,([A-Za-z0-9+/=]+)$/);
  if(!m) throw new Error("Invalid file data");
  if(expected && m[1]!==expected) throw new Error("Invalid file type");
  return Buffer.from(m[2],"base64");
}
function writeIcon(cfg,dir){
  if(!cfg.icon) return;
  const buf=decodeDataUrl(cfg.icon,"image/png");
  if(!buf.length || buf.length>1048576) throw new Error("Icon is invalid or too large");
  write(path.join(dir,"app/src/main/res/drawable/app_icon.png"),buf);
}
function project(cfg,dir){
  const pkg=packageName(cfg.pkg), app=safe(cfg.name), isHtml=!!cfg.html;
  const target=isHtml ? "file:///android_asset/index.html" : cfg.url;
  const vName=versionName(cfg.version), vCode=versionCode(vName), fullscreen=!!cfg.fullscreen;
  write(path.join(dir,"settings.gradle"),`pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }
dependencyResolutionManagement { repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS); repositories { google(); mavenCentral() } }
rootProject.name="${app}"
include(":app")`);
  write(path.join(dir,"build.gradle"),`plugins { id 'com.android.application' version '8.11.1' apply false }`);
  write(path.join(dir,"gradle.properties"),"org.gradle.jvmargs=-Xmx1536m\nandroid.useAndroidX=true\n");
  write(path.join(dir,"app/build.gradle"),`plugins { id 'com.android.application' }
android { namespace '${pkg}'; compileSdk 36
 defaultConfig { applicationId '${pkg}'; minSdk 23; targetSdk 36; versionCode ${vCode}; versionName "${xml(vName)}" }
}`);
  const iconLine=cfg.icon ? 'android:icon="@drawable/app_icon"' : '';
  write(path.join(dir,"app/src/main/AndroidManifest.xml"),`<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
<uses-permission android:name="android.permission.INTERNET"/>
<application android:theme="@style/AppTheme" android:label="${xml(cfg.name)}" ${iconLine} android:usesCleartextTraffic="true">
<activity android:name=".MainActivity" android:screenOrientation="portrait" android:exported="true">
<intent-filter><action android:name="android.intent.action.MAIN"/><category android:name="android.intent.category.LAUNCHER"/></intent-filter>
</activity></application></manifest>`);
  write(path.join(dir,"app/src/main/res/values/styles.xml"),`<resources>
<style name="AppTheme" parent="android:style/Theme.Material.Light.NoActionBar">
<item name="android:fontFamily">sans</item><item name="android:colorAccent">#171922</item>
<item name="android:navigationBarColor">#000000</item><item name="android:statusBarColor">#ffffff</item><item name="android:windowLightStatusBar">true</item>
</style></resources>`);
  const fsCode = `
 private void enterFullscreen(){
  getWindow().getDecorView().setSystemUiVisibility(
   android.view.View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY |
   android.view.View.SYSTEM_UI_FLAG_FULLSCREEN |
   android.view.View.SYSTEM_UI_FLAG_HIDE_NAVIGATION |
   android.view.View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN |
   android.view.View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION |
   android.view.View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
 }
`;
  write(path.join(dir,"app/src/main/java",...pkg.split("."),"MainActivity.java"),`package ${pkg};
import android.app.Activity;import android.os.Bundle;import android.webkit.WebSettings;import android.webkit.WebView;import android.webkit.WebViewClient;import android.view.View;
public class MainActivity extends Activity{
 WebView web;
 @Override public void onCreate(Bundle b){super.onCreate(b);web=new WebView(this);WebSettings s=web.getSettings();s.setJavaScriptEnabled(true);s.setDomStorageEnabled(true);s.setDatabaseEnabled(true);s.setLoadWithOverviewMode(true);s.setUseWideViewPort(true);s.setMediaPlaybackRequiresUserGesture(false);s.setAllowFileAccess(true);s.setAllowContentAccess(true);web.setWebViewClient(new WebViewClient());web.loadUrl("${java(target)}");setContentView(web);${fullscreen?"enterFullscreen();":""}}
 @Override public void onWindowFocusChanged(boolean hasFocus){super.onWindowFocusChanged(hasFocus);${fullscreen?"if(hasFocus)enterFullscreen();":""}}
 @Override public void onBackPressed(){if(web.canGoBack())web.goBack();else super.onBackPressed();}${fsCode}
}`);
  if(isHtml){
    const html=decodeDataUrl(cfg.html,"text/html");
    if(!html.length || html.length>5*1024*1024) throw new Error("HTML file is invalid or too large");
    write(path.join(dir,"app/src/main/assets/index.html"),html);
  }
  write(path.join(dir,"gradle/wrapper/gradle-wrapper.properties"),`distributionUrl=https\\://services.gradle.org/distributions/gradle-8.13-bin.zip`);
  write(path.join(dir,"gradlew"),`#!/bin/sh\nexec ${GRADLE} "$@"`); fs.chmodSync(path.join(dir,"gradlew"),0o755);
  writeIcon(cfg,dir);
}
async function previewProxy(req,res){
  const u=new URL(req.url,"http://localhost").searchParams.get("url");
  if(!u || !/^https?:\/\//i.test(u)) return send(res,400,"Invalid preview URL");
  try{
    const target=new URL(u); const r=await fetch(target.href,{redirect:"follow",headers:{"User-Agent":"Mozilla/5.0 (WebToAPK Preview) AppleWebKit/537.36 Chrome/131 Safari/537.36","Accept":"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"}});
    const type=r.headers.get("content-type")||"";
    if(!type.includes("text/html")){const ab=await r.arrayBuffer();res.writeHead(r.status,{"Content-Type":type||"application/octet-stream","Cache-Control":"no-store"});return res.end(Buffer.from(ab));}
    let html=await r.text(); const base=target.href;
    html=html.replace(/<meta[^>]+http-equiv=["']?content-security-policy[^>]*>/gi,"").replace(/<meta[^>]+name=["']?referrer-policy[^>]*>/gi,"");
    html=html.replace(/<head([^>]*)>/i,`<head$1><base href="${xml(base)}">`);
    html=html.replace(/\b(href|src|action)=("|')([^"']+)(\2)/gi,(m,a,q,v,e)=>{if(/^(?:data:|javascript:|mailto:|tel:|#|blob:)/i.test(v))return m;try{return `${a}=${q}/_preview?url=${encodeURIComponent(new URL(v,base).href)}${e}`}catch{return m}});
    res.writeHead(r.status,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store","X-Preview-Proxy":"1"});res.end(html);
  }catch(e){send(res,502,"Preview failed: "+e.message)}
}
async function build(cfg){
  const hasUrl=cfg && /^https?:\/\//i.test(String(cfg.url||"")); const hasHtml=cfg && cfg.html;
  if(!hasUrl && !hasHtml) throw new Error("Masukkan URL atau file HTML");
  if(!cfg.name || String(cfg.name).length>50) throw new Error("Invalid app name");
  if(cfg.icon && String(cfg.icon).length>1400000) throw new Error("Icon payload too large");
  if(hasHtml && String(cfg.html).length>7000000) throw new Error("HTML file terlalu besar (maksimal 5 MB)");
  const dir=path.join(ROOT,crypto.randomUUID());mkdir(dir);project(cfg,dir);
  await run(GRADLE,["--no-daemon","--stacktrace","assembleDebug"],dir,270000);
  const apk=path.join(dir,"app/build/outputs/apk/debug/app-debug.apk"); if(!fs.existsSync(apk))throw new Error("APK was not produced");
  return {apk,name:safe(cfg.name)+".apk"};
}
function startJob(cfg){
  const id=crypto.randomUUID(); jobs.set(id,{id,status:"queued",progress:5,message:"Queued",created:Date.now()});
  build(cfg).then(result=>{const j=jobs.get(id);if(j){j.status="success";j.progress=100;j.message="Build complete";j.apk=result.apk;j.name=result.name;j.finished=Date.now();}}).catch(e=>{const j=jobs.get(id);if(j){j.status="failed";j.progress=100;j.message=e.message;j.finished=Date.now();}});
  return id;
}
setInterval(()=>{const cutoff=Date.now()-30*60*1000;for(const [id,j] of jobs)if((j.finished||j.created)<cutoff)jobs.delete(id)},10*60*1000).unref();
const server=http.createServer(async(req,res)=>{
  const u=new URL(req.url,"http://localhost");
  if(req.method==="GET" && u.pathname==="/health") return json(res,200,{ok:true,engine:"android-webview",version:"1.1.1"});
  if(req.method==="GET" && u.pathname==="/_preview") return previewProxy(req,res);
  if(req.method==="GET" && u.pathname==="/api/jobs") return json(res,200,{jobs:[...jobs.values()].map(({id,status,progress,message,name,finished})=>({id,status,progress,message,name,finished}))});
  if(req.method==="GET" && u.pathname.startsWith("/api/jobs/") && u.pathname.endsWith("/apk")){
    const id=u.pathname.split("/")[3],j=jobs.get(id);if(!j)return send(res,404,"Job not found");if(j.status!=="success"||!j.apk||!fs.existsSync(j.apk))return send(res,409,"APK is not ready");
    res.writeHead(200,{"Content-Type":"application/vnd.android.package-archive","Content-Disposition":`attachment; filename="${j.name}"`,"Cache-Control":"no-store"});return fs.createReadStream(j.apk).pipe(res);
  }
  if(req.method==="GET" && u.pathname.startsWith("/api/jobs/")){const id=u.pathname.split("/")[3],j=jobs.get(id);return j?json(res,200,{id:j.id,status:j.status,progress:j.progress,message:j.message,name:j.name||null,finished:j.finished||null}):send(res,404,"Job not found")}
  if(req.method==="GET" && (u.pathname==="/"||u.pathname==="/index.html")){const f=path.join(__dirname,"public/index.html");return send(res,200,fs.readFileSync(f),"text/html; charset=utf-8")}
  if(req.method==="POST" && u.pathname==="/api/build"){
    try{let body="";for await(const chunk of req)body+=chunk;if(body.length>8000000)throw new Error("Request too large");const cfg=JSON.parse(body);const id=startJob(cfg);return json(res,202,{ok:true,jobId:id,status:"queued"});}
    catch(e){return json(res,400,{ok:false,error:e.message})}
  }
  send(res,404,"Not found");
});
server.listen(PORT,"0.0.0.0",()=>console.log("Web to APK server v1.1.1 listening on "+PORT));
