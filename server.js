const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");

const PORT = Number(process.env.PORT || 80);
const ROOT = "/tmp/webtoapk";
const GRADLE = "/opt/gradle/bin/gradle";
const SDK = process.env.ANDROID_SDK_ROOT || "/opt/android-sdk";

function send(res, code, body, type="text/plain; charset=utf-8"){
  res.writeHead(code, {"Content-Type": type, "Cache-Control":"no-store"});
  res.end(body);
}
function safe(s){return String(s||"app").replace(/[^a-zA-Z0-9_-]/g,"_").slice(0,40)||"app";}
function packageName(s){return /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/.test(s||"")?s:"com.webtoapk.app";}
function xml(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&apos;");}
function java(s){return String(s).replace(/\\/g,"\\\\").replace(/"/g,'\\"').replace(/\r/g,"").replace(/\n/g,"\\n");}
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
 defaultConfig { applicationId '${pkg}'; minSdk 23; targetSdk 36; versionCode 1; versionName "1.0" }
}`);
  write(path.join(dir,"app/src/main/AndroidManifest.xml"),`<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
<uses-permission android:name="android.permission.INTERNET"/>
<application android:theme="@style/AppTheme" android:label="${xml(cfg.name)}" android:usesCleartextTraffic="true">
<activity android:name=".MainActivity" android:screenOrientation="portrait" android:exported="true">
<intent-filter><action android:name="android.intent.action.MAIN"/><category android:name="android.intent.category.LAUNCHER"/></intent-filter>
</activity></application></manifest>`);
  write(path.join(dir,"app/src/main/res/values/styles.xml"),`<resources><style name="AppTheme" parent="android:style/Theme.Material.Light.NoActionBar"><item name="android:fontFamily">sans</item><item name="android:colorAccent">#171922</item><item name="android:navigationBarColor">#000000</item><item name="android:statusBarColor">#ffffff</item><item name="android:windowLightStatusBar">true</item></style></resources>`);
  write(path.join(dir,"app/src/main/java",...pkg.split("."),"MainActivity.java"),`package ${pkg};
import android.app.Activity;import android.os.Bundle;import android.webkit.WebSettings;import android.webkit.WebView;import android.webkit.WebViewClient;
public class MainActivity extends Activity{
 WebView web;
 @Override public void onCreate(Bundle b){super.onCreate(b);web=new WebView(this);WebSettings s=web.getSettings();s.setJavaScriptEnabled(true);s.setDomStorageEnabled(true);s.setDatabaseEnabled(true);s.setLoadWithOverviewMode(true);s.setUseWideViewPort(true);web.setWebViewClient(new WebViewClient());web.loadUrl("${java(url)}");setContentView(web);}
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
  if(req.method==="GET" && req.url==="/health") return send(res,200,JSON.stringify({ok:true,engine:"android-webview"}),"application/json");
  if(req.method==="GET" && (req.url==="/" || req.url==="/index.html")){
    const f=path.join(__dirname,"public/index.html");return send(res,200,fs.readFileSync(f),"text/html; charset=utf-8");
  }
  if(req.method==="POST" && req.url==="/api/build"){
    try{
      let body="";for await(const chunk of req) body+=chunk;
      if(body.length>20000)throw new Error("Request too large");
      const cfg=JSON.parse(body);const result=await build(cfg);
      res.writeHead(200,{"Content-Type":"application/vnd.android.package-archive","Content-Disposition":`attachment; filename="${result.name}"`,"Cache-Control":"no-store"});
      fs.createReadStream(result.apk).pipe(res);
    }catch(e){send(res,500,e.message)}
    return;
  }
  send(res,404,"Not found");
});
server.listen(PORT,"0.0.0.0",()=>console.log("Web to APK server listening on "+PORT));