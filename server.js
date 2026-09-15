const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const PORT = Number(process.env.PORT || 80);
const ROOT = "/tmp/webtoapk";
const GRADLE = "/opt/gradle/bin/gradle";
const SDK = process.env.ANDROID_SDK_ROOT || "/opt/android-sdk";
const MAX_ICON = 2 * 1024 * 1024;
const MAX_HTML = 3 * 1024 * 1024;

fs.mkdirSync(ROOT, { recursive: true });

function send(res, code, body, type="text/plain; charset=utf-8", extra={}) {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store", ...extra });
  res.end(body);
}
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
function run(cmd,args,cwd,timeout=270000,onProgress=()=>{}){
  return new Promise((resolve,reject)=>{
    const p=spawn(cmd,args,{cwd,env:{...process.env,ANDROID_SDK_ROOT:SDK,ANDROID_HOME:SDK,GRADLE_USER_HOME:"/tmp/gradle-home"}});
    let out="",err="",settled=false;
    const timer=setTimeout(()=>{if(settled)return;settled=true;p.kill("SIGKILL");reject(new Error("Build timeout"));},timeout);
    const progressFrom=(text)=>{
      const all=(out+"\n"+err+"\n"+text).slice(-12000);
      if(/BUILD SUCCESSFUL/i.test(all)) onProgress(98,"Gradle finished successfully");
      else if(/BUILD FAILED/i.test(all)) onProgress(96,"Gradle reported a failure");
      else if(/Task :app:compile/i.test(all)) onProgress(55,"Compiling Android app...");
      else if(/Task :app:process.*Resources/i.test(all)) onProgress(48,"Processing app resources...");
      else if(/Task :app:merge.*Resources/i.test(all)) onProgress(44,"Merging resources...");
      else if(/Task :app:package/i.test(all)) onProgress(88,"Packaging APK...");
      else onProgress(null, text.trim().split(/\r?\n/).filter(Boolean).slice(-1)[0]||"Building Android project...");
    };
    p.stdout.on("data",d=>{const s=d.toString();out+=s;progressFrom(s);});
    p.stderr.on("data",d=>{const s=d.toString();err+=s;progressFrom(s);});
    p.on("close",code=>{
      if(settled)return;
      settled=true;clearTimeout(timer);
      code===0?resolve(out):reject(new Error((err||out).slice(-7000)||"Gradle failed"));
    });
  });
}

function normalizeHtml(source){
  let html=String(source||"");
  if(!html.trim()) throw new Error("HTML file is empty");
  // Friendly support for the user's requested placeholder filename typo.
  html=html.replace(/font\/twin\.tff/gi,"font/twin.ttf");
  html=html.replace(/url\(\s*['"]?twin\.tff['"]?\s*\)/gi,"url('font/twin.ttf')");
  return html;
}
function htmlFileFromConfig(cfg,dir){
  const html=normalizeHtml(cfg.html);
  const htmlPath=path.join(dir,"app/src/main/assets/index.html");
  write(htmlPath, html);
}
function writeIcon(cfg,dir){
  if(!cfg.icon) return;
  const match=String(cfg.icon).match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
  if(!match) throw new Error("Icon must be a PNG image");
  const buf=Buffer.from(match[1],"base64");
  if(!buf.length || buf.length>MAX_ICON) throw new Error("Icon is invalid or too large");
  const iconPath=path.join(dir,"app/src/main/res/drawable/app_icon.png");
  write(iconPath,buf);
}
function project(cfg,dir){
  const pkg=packageName(cfg.pkg), app=safe(cfg.name);
  const isHtml=cfg.sourceType==="html";
  const url=isHtml ? "" : cfg.url;
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
<application android:theme="@style/AppTheme" android:label="${xml(cfg.name)}" ${iconLine} android:usesCleartextTraffic="true" android:hardwareAccelerated="true">
<activity android:name=".MainActivity" android:screenOrientation="portrait" android:exported="true">
<intent-filter><action android:name="android.intent.action.MAIN"/><category android:name="android.intent.category.LAUNCHER"/></intent-filter>
</activity></application></manifest>`);
  write(path.join(dir,"app/src/main/res/values/styles.xml"),`<resources>
<style name="AppTheme" parent="android:style/Theme.Material.Light.NoActionBar">
<item name="android:fontFamily">sans</item>
<item name="android:colorAccent">#171922</item>
<item name="android:windowActionModeOverlay">true</item>
<item name="android:windowNoTitle">true</item>
<item name="android:navigationBarColor">#000000</item>
<item name="android:statusBarColor">#ffffff</item>
<item name="android:windowLightStatusBar">true</item>
</style></resources>`);
  if(isHtml) {
    htmlFileFromConfig(cfg,dir);
    const fontSrc=path.join(__dirname,"public/font/twin.ttf");
    if(fs.existsSync(fontSrc)) write(path.join(dir,"app/src/main/assets/font/twin.ttf"),fs.readFileSync(fontSrc));
    // Keep the historical .tff spelling available too, while normalizing HTML references to .ttf.
    if(fs.existsSync(fontSrc)) write(path.join(dir,"app/src/main/assets/font/twin.tff"),fs.readFileSync(fontSrc));
  }
  const load= isHtml ? 'web.loadUrl("file:///android_asset/index.html");' : `web.loadUrl("${java(url)}");`;
  const fsPart=fullscreen ? `
 private void applyFullscreen(){
   final int flags =
     android.view.View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY |
     android.view.View.SYSTEM_UI_FLAG_FULLSCREEN |
     android.view.View.SYSTEM_UI_FLAG_HIDE_NAVIGATION |
     android.view.View.SYSTEM_UI_FLAG_LAYOUT_STABLE |
     android.view.View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN |
     android.view.View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION;
   getWindow().setStatusBarColor(android.graphics.Color.TRANSPARENT);
   getWindow().setNavigationBarColor(android.graphics.Color.TRANSPARENT);
   getWindow().getDecorView().setSystemUiVisibility(flags);
 }
` : `
 private void applyFullscreen(){ }
`;
  write(path.join(dir,"app/src/main/java",...pkg.split("."),"MainActivity.java"),`package ${pkg};
import android.app.Activity;
import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebChromeClient;
import android.view.View;
public class MainActivity extends Activity{
 WebView web;
 @Override public void onCreate(Bundle b){
   super.onCreate(b);
   web=new WebView(this);
   WebSettings s=web.getSettings();
   s.setJavaScriptEnabled(true);
   s.setDomStorageEnabled(true);
   s.setDatabaseEnabled(true);
   s.setLoadWithOverviewMode(true);
   s.setUseWideViewPort(true);
   s.setMediaPlaybackRequiresUserGesture(false);
   s.setAllowFileAccess(true);
   s.setAllowContentAccess(true);
   s.setAllowFileAccessFromFileURLs(true);
   s.setAllowUniversalAccessFromFileURLs(true);
   web.setWebViewClient(new WebViewClient());
   web.setWebChromeClient(new WebChromeClient());
   ${load}
   setContentView(web);
   applyFullscreen();
 }
 @Override public void onWindowFocusChanged(boolean hasFocus){
   super.onWindowFocusChanged(hasFocus);
   if(hasFocus) applyFullscreen();
 }
 @Override public void onBackPressed(){
   if(web!=null && web.canGoBack()) web.goBack();
   else super.onBackPressed();
 }${fsPart}
}
`);
  write(path.join(dir,"gradle/wrapper/gradle-wrapper.properties"),`distributionUrl=https\\://services.gradle.org/distributions/gradle-8.13-bin.zip`);
  write(path.join(dir,"gradlew"),`#!/bin/sh
exec ${GRADLE} "$@"`);
  fs.chmodSync(path.join(dir,"gradlew"),0o755);
  writeIcon(cfg,dir);
}

async function previewProxy(req,res){
  const u=new URL(req.url,"http://localhost").searchParams.get("url");
  if(!u || !/^https?:\/\//i.test(u)) return send(res,400,"Invalid preview URL");
  try{
    const target=new URL(u);
    const r=await fetch(target.href,{redirect:"follow",headers:{"User-Agent":"Mozilla/5.0 (WebToAPK Preview) AppleWebKit/537.36 Chrome/131 Safari/537.36","Accept":"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"}});
    const type=r.headers.get("content-type")||"";
    if(!type.includes("text/html")){
      const ab=await r.arrayBuffer();
      res.writeHead(r.status,{"Content-Type":type||"application/octet-stream","Cache-Control":"no-store","X-Preview-Proxy":"1"});
      return res.end(Buffer.from(ab));
    }
    let html=await r.text(), base=target.href;
    html=html.replace(/<meta[^>]+http-equiv=["']?content-security-policy[^>]*>/gi,"");
    html=html.replace(/<meta[^>]+name=["']?referrer-policy[^>]*>/gi,"");
    html=html.replace(/<head([^>]*)>/i,`<head$1><base href="${xml(base)}">`);
    html=html.replace(/\b(href|src|action)=(["'])([^"']+)(\2)/gi,(m,a,q,v,e)=>{
      if(/^(?:data:|javascript:|mailto:|tel:|#|blob:)/i.test(v)) return m;
      try { return `${a}=${q}/_preview?url=${encodeURIComponent(new URL(v,base).href)}${e}`; } catch { return m; }
    });
    res.writeHead(r.status,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store","X-Preview-Proxy":"1"});
    res.end(html);
  }catch(e){send(res,502,"Preview failed: "+e.message)}
}

async function parseBody(req){
  let body="";
  for await(const chunk of req){body+=chunk; if(body.length>MAX_HTML+MAX_ICON+500000) throw new Error("Request too large");}
  try{return JSON.parse(body)}catch{throw new Error("Invalid JSON")}
}

function validateConfig(cfg){
  if(!cfg) throw new Error("Missing build configuration");
  if(!cfg.name || String(cfg.name).length>50) throw new Error("Invalid app name");
  if(!cfg.pkg || !/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/.test(cfg.pkg)) throw new Error("Invalid package name");
  if(cfg.sourceType==="html"){
    const size=Buffer.byteLength(String(cfg.html||""),"utf8");
    if(!cfg.html || size>MAX_HTML) throw new Error("HTML file is empty or exceeds 3 MB");
  }else{
    if(!/^https?:\/\//i.test(cfg.url||"")) throw new Error("URL must be http or https");
  }
  if(cfg.icon && String(cfg.icon).length>1400000) throw new Error("Icon payload too large");
}

async function build(cfg,onProgress=()=>{}){
  validateConfig(cfg);
  const dir=path.join(ROOT,crypto.randomUUID());mkdir(dir);
  try{
    onProgress(12,"Validating configuration...");
    project(cfg,dir);
    onProgress(25,"Android project prepared...");
    await run(GRADLE,["--no-daemon","--stacktrace","assembleDebug"],dir,270000,onProgress);
    onProgress(99,"Verifying APK...");
    const apk=path.join(dir,"app/build/outputs/apk/debug/app-debug.apk");
    if(!fs.existsSync(apk))throw new Error("APK was not produced");
    const st=fs.statSync(apk); if(st.size<1000) throw new Error("APK is invalid or empty");
    return {apk,name:safe(cfg.name)+".apk",size:st.size};
  }finally{
    // Keep only during the response lifetime; Vercel-style containers may be recycled.
  }
}

function jsonLine(obj){return JSON.stringify(obj)+"\n";}
async function handleBuild(req,res){
  let cfg;
  try{cfg=await parseBody(req);validateConfig(cfg);}catch(e){return send(res,400,e.message);}
  res.writeHead(200,{"Content-Type":"application/x-ndjson; charset=utf-8","Cache-Control":"no-store","X-Accel-Buffering":"no"});
  const writeEvent=(type,payload={})=>{try{res.write(jsonLine({type,...payload}));}catch{}};
  writeEvent("started",{message:"Build started"});
  let result;
  try{
    result=await build(cfg,(progress,message)=>{
      const p=progress==null?undefined:Math.max(1,Math.min(99,progress));
      writeEvent("progress",{progress:p,message});
    });
    const data=fs.readFileSync(result.apk).toString("base64");
    writeEvent("completed",{progress:100,message:"Build complete",name:result.name,size:result.size,apk:data});
  }catch(e){
    writeEvent("failed",{progress:100,message:e.message});
  }
  res.end();
}

const server=http.createServer(async(req,res)=>{
  const u=new URL(req.url,"http://localhost");
  if(req.method==="GET" && u.pathname==="/health") return send(res,200,JSON.stringify({ok:true,engine:"android-webview",version:"1.2"}),"application/json");
  if(req.method==="GET" && u.pathname==="/_preview") return previewProxy(req,res);
  if(req.method==="GET" && (u.pathname==="/font/twin.ttf" || u.pathname==="/font/twin.tff")){
    const f=path.join(__dirname,"public/font/twin.ttf");
    if(!fs.existsSync(f)) return send(res,404,"Font not found");
    return send(res,200,fs.readFileSync(f),"font/ttf; charset=binary",{"Cache-Control":"public,max-age=3600"});
  }
  if(req.method==="GET" && (u.pathname==="/" || u.pathname==="/index.html")){
    const f=path.join(__dirname,"public/index.html");return send(res,200,fs.readFileSync(f),"text/html; charset=utf-8");
  }
  if(req.method==="GET" && u.pathname==="/sw.js"){
    const f=path.join(__dirname,"public/sw.js");
    return send(res,200,fs.readFileSync(f),"application/javascript; charset=utf-8",{"Service-Worker-Allowed":"/"});
  }
  if(req.method==="POST" && u.pathname==="/api/build") return handleBuild(req,res);
  send(res,404,"Not found");
});
server.listen(PORT,"0.0.0.0",()=>console.log("Web to APK server v1.2 listening on "+PORT));
