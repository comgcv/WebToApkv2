const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const PORT = Number(process.env.PORT || 80);
const ROOT = process.env.WTA_ROOT || '/tmp/webtoapk';
const GRADLE = process.env.GRADLE_BIN || '/opt/gradle/bin/gradle';
const SDK = process.env.ANDROID_SDK_ROOT || '/opt/android-sdk';
const MAX_JSON = 24 * 1024 * 1024;
const MAX_HTML = 8 * 1024 * 1024;
const MAX_ZIP = 14 * 1024 * 1024;
const jobs = new Map();
const queue = [];
let active = false;
fs.mkdirSync(ROOT, { recursive: true });

function send(res, code, body, type='text/plain; charset=utf-8', extra={}) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
  res.end(body);
}
function json(res, code, data){ send(res, code, JSON.stringify(data), 'application/json; charset=utf-8'); }
function safe(s){ return String(s || 'app').replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,48) || 'app'; }
function validPkg(s){ return /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/.test(String(s||'')); }
function packageName(s){ return validPkg(s) ? s : 'com.webtoapk.app'; }
function xml(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;'); }
function java(s){ return String(s).replace(/\\/g,'\\\\').replace(/"/g,'\\"').replace(/\r/g,'').replace(/\n/g,'\\n'); }
function mkdir(p){ fs.mkdirSync(p,{recursive:true}); }
function write(p,c){ mkdir(path.dirname(p)); fs.writeFileSync(p,c); }
function versionName(v){ const x=String(v||'1.0').trim(); return /^\d+(?:\.\d+){0,3}(?:[-+][0-9A-Za-z.-]+)?$/.test(x) ? x : '1.0'; }
function versionCode(v){ const m=String(v||'1.0').match(/^\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?/); if(!m)return 1; return Math.min(2100000000, Number(m[1])*1000000 + Number(m[2]||0)*1000 + Number(m[3]||0) || 1); }
function extMime(p){ const e=path.extname(p).toLowerCase(); return ({'.html':'text/html','.htm':'text/html','.css':'text/css','.js':'text/javascript','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.ico':'image/x-icon','.txt':'text/plain','.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf','.mp3':'audio/mpeg','.mp4':'video/mp4'}[e] || 'application/octet-stream'); }

function run(cmd,args,cwd,timeout=300000,onData,signal){
  return new Promise((resolve,reject)=>{
    const p=spawn(cmd,args,{cwd,env:{...process.env,ANDROID_SDK_ROOT:SDK,ANDROID_HOME:SDK,GRADLE_USER_HOME:'/tmp/gradle-home'}}); if(signal) signal.process=p;
    let out='',err='',done=false;
    const add=(type,d)=>{const text=String(d); if(type==='out')out+=text;else err+=text; if(onData)onData(text);};
    p.stdout.on('data',d=>add('out',d)); p.stderr.on('data',d=>add('err',d));
    const finish=(fn,v)=>{if(done)return;done=true;clearTimeout(timer);fn(v)};
    const timer=setTimeout(()=>{try{p.kill('SIGKILL')}catch{} finish(reject,new Error('Build timeout after 5 minutes.'))},timeout);
    if(signal)signal.kill=()=>{try{p.kill('SIGTERM')}catch{}};
    p.on('close',code=>code===0?finish(resolve,out):finish(reject,new Error((err||out).slice(-9000)||'Gradle build failed')));
    p.on('error',e=>finish(reject,e));
  });
}

function normalizeIcon(data){
  if(!data)return null;
  const m=String(data).match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
  if(!m)throw new Error('Icon must be a PNG image.');
  const b=Buffer.from(m[1],'base64');
  if(!b.length||b.length>1200000)throw new Error('Icon is invalid or too large.');
  return b;
}
function writeIcon(cfg,dir){ const b=normalizeIcon(cfg.icon); if(b)write(path.join(dir,'app/src/main/res/drawable/app_icon.png'),b); }

function androidProject(cfg,dir,job){
  const pkg=packageName(cfg.pkg), app=safe(cfg.name), fullscreen=!!cfg.fullscreen;
  const vName=versionName(cfg.version), vCode=versionCode(vName);
  const source=cfg.sourceType || (cfg.projectZip ? 'zip' : cfg.html ? 'html' : 'url');
  const font=String(cfg.font||'sans-serif').replace(/[^a-zA-Z0-9_-]/g,'').slice(0,40) || 'sans-serif';
  const orientation=['portrait','landscape','unspecified'].includes(cfg.orientation)?cfg.orientation:'portrait';
  const status=String(cfg.statusBarColor||'#FFFFFF').match(/^#[0-9A-Fa-f]{6}$/)?cfg.statusBarColor:'#FFFFFF';
  const nav=String(cfg.navigationBarColor||'#000000').match(/^#[0-9A-Fa-f]{6}$/)?cfg.navigationBarColor:'#000000';
  const lightStatus=!!cfg.lightStatusBar;
  const perms=new Set(['INTERNET',...(Array.isArray(cfg.permissions)?cfg.permissions:[])]);
  const allowedPerms=new Set(['INTERNET','CAMERA','RECORD_AUDIO','ACCESS_FINE_LOCATION','ACCESS_COARSE_LOCATION','POST_NOTIFICATIONS','VIBRATE','BLUETOOTH_CONNECT','BLUETOOTH_SCAN']);
  const permXml=[...perms].filter(x=>allowedPerms.has(x)).map(x=>`<uses-permission android:name="android.permission.${x}"/>`).join('\n');
  write(path.join(dir,'settings.gradle'),`pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }\ndependencyResolutionManagement { repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS); repositories { google(); mavenCentral() } }\nrootProject.name="${app}"\ninclude(":app")`);
  write(path.join(dir,'build.gradle'),`plugins { id 'com.android.application' version '8.11.1' apply false }`);
  write(path.join(dir,'gradle.properties'),'org.gradle.jvmargs=-Xmx1536m\nandroid.useAndroidX=true\nandroid.nonTransitiveRClass=true\n');
  write(path.join(dir,'app/build.gradle'),`plugins { id 'com.android.application' }\nandroid { namespace '${pkg}'; compileSdk 36\n defaultConfig { applicationId '${pkg}'; minSdk 23; targetSdk 36; versionCode ${vCode}; versionName "${xml(vName)}" }\n}`);
  const iconLine=cfg.icon?'android:icon="@drawable/app_icon" android:roundIcon="@drawable/app_icon"':'';
  write(path.join(dir,'app/src/main/AndroidManifest.xml'),`<?xml version="1.0" encoding="utf-8"?>\n<manifest xmlns:android="http://schemas.android.com/apk/res/android">\n${permXml}\n<application android:theme="@style/AppTheme" android:label="${xml(cfg.name)}" ${iconLine} android:usesCleartextTraffic="true" android:allowBackup="false" android:supportsRtl="true">\n<activity android:name=".MainActivity" android:screenOrientation="${orientation}" android:exported="true">\n<intent-filter><action android:name="android.intent.action.MAIN"/><category android:name="android.intent.category.LAUNCHER"/></intent-filter>\n</activity></application></manifest>`);
  write(path.join(dir,'app/src/main/res/values/colors.xml'),`<resources><color name="status_bar">${status}</color><color name="navigation_bar">${nav}</color></resources>`);
  write(path.join(dir,'app/src/main/res/values/styles.xml'),`<resources><style name="AppTheme" parent="android:style/Theme.Material.Light.NoActionBar"><item name="android:fontFamily">${font}</item><item name="android:colorAccent">#171922</item><item name="android:statusBarColor">@color/status_bar</item><item name="android:navigationBarColor">@color/navigation_bar</item><item name="android:windowLightStatusBar">${lightStatus}</item><item name="android:windowActionModeOverlay">true</item></style></resources>`);
  if(cfg.splash){
    const sb=normalizeIcon(cfg.splash); if(sb)write(path.join(dir,'app/src/main/res/drawable/splash.png'),sb);
  }
  if(source==='url'){
    // URL mode is loaded directly by WebView.
  } else if(cfg.projectZip){
    writeProjectZip(cfg.projectZip,dir);
  } else {
    write(path.join(dir,'app/src/main/assets/index.html'),String(cfg.html||'<!doctype html><html><body><h1>WebToAPK</h1></body></html>'));
  }
  const target=source==='url'?java(cfg.url):'file:///android_asset/index.html';
  const splash=cfg.splash?`\n  private void showSplash(){ android.widget.ImageView v=new android.widget.ImageView(this); v.setImageResource(${cfg.splash?'R.drawable.splash':'0'}); v.setScaleType(android.widget.ImageView.ScaleType.CENTER_CROP); v.setBackgroundColor(android.graphics.Color.WHITE); setContentView(v); v.postDelayed(()->loadWeb(),700); }\n`:'\n  private void showSplash(){ loadWeb(); }\n';
  const full=fullscreen?`\n  private void enableFullscreen(){\n    if(android.os.Build.VERSION.SDK_INT >= 30){\n      getWindow().setDecorFitsSystemWindows(false);\n      android.view.WindowInsetsController c=getWindow().getInsetsController();\n      if(c!=null){ c.hide(android.view.WindowInsets.Type.statusBars() | android.view.WindowInsets.Type.navigationBars()); c.setSystemBarsBehavior(android.view.WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE); }\n    } else { getWindow().getDecorView().setSystemUiVisibility(5894); }\n  }\n`:'\n';
  const splashCall=cfg.splash?'showSplash();':'loadWeb();';
  const jsBridge=`web.getSettings().setJavaScriptEnabled(true); web.getSettings().setDomStorageEnabled(true); web.getSettings().setDatabaseEnabled(true); web.getSettings().setMediaPlaybackRequiresUserGesture(false); web.getSettings().setDefaultFontFamily("${font}"); web.setWebViewClient(new WebViewClient());`;
  write(path.join(dir,'app/src/main/java',...pkg.split('.'),'MainActivity.java'),`package ${pkg};\nimport android.app.Activity;import android.os.Bundle;import android.webkit.WebSettings;import android.webkit.WebView;import android.webkit.WebViewClient;\npublic class MainActivity extends Activity{\n WebView web;\n @Override public void onCreate(Bundle b){super.onCreate(b);${fullscreen?'enableFullscreen();':''}${splashCall}}\n private void loadWeb(){ web=new WebView(this); WebSettings s=web.getSettings(); ${jsBridge} web.loadUrl("${target}"); setContentView(web); }\n @Override public void onBackPressed(){if(web!=null&&web.canGoBack())web.goBack();else super.onBackPressed();}${splash}${full}\n}`);
  write(path.join(dir,'gradle/wrapper/gradle-wrapper.properties'),'distributionUrl=https\\://services.gradle.org/distributions/gradle-8.13-bin.zip');
  write(path.join(dir,'gradlew'),`#!/bin/sh\nexec ${GRADLE} "$@"`); fs.chmodSync(path.join(dir,'gradlew'),0o755); writeIcon(cfg,dir);
  job.log('Android project generated');
}

function writeProjectZip(base64,dir){
  const b=Buffer.from(String(base64).replace(/^data:application\/zip;base64,/i,''),'base64');
  if(!b.length||b.length>MAX_ZIP)throw new Error('Project ZIP is invalid or larger than 14 MB.');
  const zip=path.join(dir,'project.zip');fs.writeFileSync(zip,b);
  const out=path.join(dir,'app/src/main/assets');mkdir(out);
  return execFileAsync('unzip',['-q','-o',zip,'-d',out],{timeout:30000}).then(()=>{}).catch(e=>{throw new Error('Project ZIP could not be extracted: '+(e.stderr||e.message))});
}

function validate(cfg){
  if(!cfg||typeof cfg!=='object')throw new Error('Invalid build configuration.');
  if(!cfg.name||String(cfg.name).length>50)throw new Error('Invalid app name.');
  if(!validPkg(cfg.pkg||'com.webtoapk.app'))throw new Error('Package name is invalid.');
  if(cfg.url && !/^https?:\/\//i.test(cfg.url))throw new Error('URL must be http or https.');
  const source=cfg.sourceType || (cfg.projectZip?'zip':cfg.html?'html':'url');
  if(source==='url'&&!cfg.url)throw new Error('Provide a website URL.');
  if(source==='html'&&!cfg.html)throw new Error('Provide one HTML file.');
  if(source==='zip'&&!cfg.projectZip)throw new Error('Provide a project ZIP.');
  if(cfg.html && Buffer.byteLength(String(cfg.html),'utf8')>MAX_HTML)throw new Error('HTML file is too large. Maximum 8 MB.');
  if(cfg.projectZip && Buffer.from(String(cfg.projectZip).replace(/^data:.*?;base64,/i,''),'base64').length>MAX_ZIP)throw new Error('Project ZIP is too large. Maximum 14 MB.');
  normalizeIcon(cfg.icon); if(cfg.splash)normalizeIcon(cfg.splash);
}

function createQueueJob(cfg){
  const id=crypto.randomUUID();
  const job={id,status:'queued',progress:0,message:'Waiting in build queue',createdAt:Date.now(),startedAt:null,finishedAt:null,cfg:sanitizeCfg(cfg),rawCfg:{...cfg},apk:null,aab:null,name:null,logs:[],process:null,cancelled:false};
  jobs.set(id,job);queue.push(job);pump();return job;
}
function sanitizeCfg(cfg){ const x={...cfg}; if(x.icon)x.icon=true; if(x.splash)x.splash=true; if(x.html)x.html=true; if(x.projectZip)x.projectZip=true; return x; }
function publicJob(j){return {id:j.id,status:j.status,progress:j.progress,message:j.message,createdAt:j.createdAt,startedAt:j.startedAt,finishedAt:j.finishedAt,name:j.name,logs:j.logs.slice(-160),cfg:j.cfg,hasApk:!!j.apk,hasAab:!!j.aab};}
function processNext(){ if(active||!queue.length)return; const job=queue.shift(); if(job.cancelled){job.status='cancelled';job.finishedAt=Date.now();return processNext();} active=true;runBuild(job).finally(()=>{active=false;processNext();}); }
function pump(){processNext();}

async function runBuild(job){
  const dir=path.join(ROOT,job.id);mkdir(dir);job.startedAt=Date.now();job.status='building';job.progress=4;job.message='Preparing Android build';
  job.log=(line)=>{ const clean=String(line).replace(/\u001b\[[0-?]*[ -/]*[@-~]/g,'').trimEnd(); if(clean){job.logs.push(clean.slice(0,600));if(job.logs.length>500)job.logs.shift();} };
  try{
    validate(job.cfg);job.log('Valid configuration');
    await maybePrepareProject(job.cfg,dir,job);if(job.cancelled)throw new Error('Build cancelled.');
    job.progress=25;job.message='Running Gradle build';job.log('Gradle assembleDebug + bundleRelease started');
    await run(GRADLE,['--no-daemon','--stacktrace','assembleDebug'],dir,300000,job.log,job);if(job.cancelled)throw new Error('Build cancelled.');
    job.progress=70;job.message='Building AAB';job.log('Gradle bundleRelease started');
    await run(GRADLE,['--no-daemon','--stacktrace','bundleRelease'],dir,300000,job.log,job);if(job.cancelled)throw new Error('Build cancelled.');
    const apk=path.join(dir,'app/build/outputs/apk/debug/app-debug.apk');
    const aab=path.join(dir,'app/build/outputs/bundle/release/app-release.aab');
    if(!fs.existsSync(apk))throw new Error('APK was not produced.');
    if(!fs.existsSync(aab))throw new Error('AAB was not produced.');
    job.apk=apk;job.aab=aab;job.name=safe(job.cfg.name);job.progress=100;job.status='success';job.message='Build completed successfully';job.finishedAt=Date.now();job.log('SUCCESS: APK and AAB ready');
  }catch(e){
    job.finishedAt=Date.now();
    if(job.cancelled||/cancelled/i.test(e.message||'')){job.status='cancelled';job.message='Build cancelled';job.progress=100;job.log('CANCELLED');}
    else{job.status='failed';job.message=e.message||'Build failed';job.progress=100;job.log('FAILED: '+job.message);}
  }finally{job.process=null;}
}
async function maybePrepareProject(cfg,dir,job){
  if((cfg.sourceType||'url')==='zip'){
    // Generate normal Android files first, then extract site assets.
    const original=cfg.projectZip; cfg={...cfg,projectZip:null,sourceType:'html',html:'<!doctype html><html><body></body></html>'};
    androidProject(cfg,dir,job);
    const assets=path.join(dir,'app/src/main/assets');
    const b=Buffer.from(String(original).replace(/^data:.*?;base64,/i,''),'base64');if(!b.length||b.length>MAX_ZIP)throw new Error('Project ZIP is invalid or too large.');
    const zip=path.join(dir,'project.zip');fs.writeFileSync(zip,b);
    const listing=await execFileAsync('unzip',['-Z1',zip],{timeout:30000});
    const entries=String(listing.stdout||'').split(/\r?\n/).filter(Boolean);
    for(const entry of entries){ const normalized=entry.replace(/\\/g,'/'); if(normalized.startsWith('/')||normalized.split('/').includes('..')) throw new Error('Unsafe ZIP path detected.'); }
    await execFileAsync('unzip',['-q','-o',zip,'-d',assets],{timeout:30000});
    const index=path.join(assets,'index.html');
    const alt=path.join(assets,'index.htm');
    if(!fs.existsSync(index)&&fs.existsSync(alt))fs.renameSync(alt,index);
    if(!fs.existsSync(index)){
      const dirs=fs.readdirSync(assets,{withFileTypes:true}).filter(x=>x.isDirectory());
      if(dirs.length===1){ const nested=path.join(assets,dirs[0].name); const ni=path.join(nested,'index.html'); const nh=path.join(nested,'index.htm'); if(!fs.existsSync(ni)&&fs.existsSync(nh))fs.renameSync(nh,ni); if(fs.existsSync(ni)){ for(const entry of fs.readdirSync(nested)) fs.renameSync(path.join(nested,entry),path.join(assets,entry)); fs.rmSync(nested,{recursive:true,force:true}); } }
    }
    if(!fs.existsSync(index))throw new Error('ZIP must contain index.html at root or inside one project folder.');
    job.log('ZIP project extracted successfully');
  }else androidProject(cfg,dir,job);
}

async function readBody(req,max=MAX_JSON){let body='';for await(const c of req){body+=c;if(body.length>max)throw new Error('Request too large.');}return JSON.parse(body||'{}');}
async function previewProxy(req,res){
  const u=new URL(req.url,'http://localhost').searchParams.get('url');if(!u||!/^https?:\/\//i.test(u))return send(res,400,'Invalid preview URL');
  try{const target=new URL(u);const r=await fetch(target.href,{redirect:'follow',headers:{'User-Agent':'Mozilla/5.0 (WebToAPK Studio)','Accept':'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'}});const type=r.headers.get('content-type')||'';if(!type.includes('text/html')){const ab=await r.arrayBuffer();res.writeHead(r.status,{'Content-Type':type||'application/octet-stream','Cache-Control':'no-store'});return res.end(Buffer.from(ab));}let html=await r.text();html=html.replace(/<meta[^>]+http-equiv=["']?content-security-policy[^>]*>/gi,'').replace(/<meta[^>]+name=["']?referrer-policy[^>]*>/gi,'');html=html.replace(/<head([^>]*)>/i,`<head$1><base href="${xml(target.href)}">`);res.writeHead(r.status,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Frame-Options':'SAMEORIGIN'});res.end(html);
  }catch(e){send(res,502,'Preview failed: '+e.message)}
}
function download(res,j,file,type){if(!j||j.status!=='success'||!file||!fs.existsSync(file))return json(res,409,{error:'Build is not successful yet.'});const filename=`${j.name}.${type}`;res.writeHead(200,{'Content-Type':type==='apk'?'application/vnd.android.package-archive':'application/octet-stream','Content-Disposition':`attachment; filename="${filename}"`,'Cache-Control':'no-store'});fs.createReadStream(file).pipe(res);}
function staticFile(req,res){let p=decodeURIComponent(new URL(req.url,'http://localhost').pathname);if(p==='/' )p='/index.html';const file=path.join(__dirname,'public',p);if(!file.startsWith(path.join(__dirname,'public')))return send(res,403,'Forbidden');if(!fs.existsSync(file)||fs.statSync(file).isDirectory())return send(res,404,'Not found');send(res,200,fs.readFileSync(file),extMime(file));}

const server=http.createServer(async(req,res)=>{
  try{
    const u=new URL(req.url,'http://localhost');
    if(req.method==='GET'&&u.pathname==='/_preview')return previewProxy(req,res);
    if(req.method==='POST'&&u.pathname==='/api/build'){const cfg=await readBody(req);validate(cfg);const job=createQueueJob(cfg);return json(res,202,{jobId:job.id,status:job.status});}
    if(req.method==='GET'&&u.pathname==='/api/health')return json(res,200,{ok:true,engine:'WebToAPK Studio',active,queued:queue.length});
    if(req.method==='GET'&&u.pathname.startsWith('/api/jobs/')){const id=u.pathname.split('/').pop();const j=jobs.get(id);if(!j)return json(res,404,{error:'Job not found'});return json(res,200,publicJob(j));}
    if(req.method==='POST'&&u.pathname.startsWith('/api/jobs/')&&u.pathname.endsWith('/cancel')){const id=u.pathname.split('/')[3];const j=jobs.get(id);if(!j)return json(res,404,{error:'Job not found'});if(j.status==='success'||j.status==='failed'||j.status==='cancelled')return json(res,409,{error:'Job already finished.'});j.cancelled=true;if(j.status==='queued'){j.status='cancelled';j.message='Build cancelled before start';j.finishedAt=Date.now();const i=queue.indexOf(j);if(i>=0)queue.splice(i,1);}else if(j.process&&j.process.kill)j.process.kill();return json(res,200,{ok:true,status:j.status});}
    if(req.method==='POST'&&u.pathname.startsWith('/api/jobs/')&&u.pathname.endsWith('/retry')){const id=u.pathname.split('/')[3];const j=jobs.get(id);if(!j||j.status!=='failed')return json(res,409,{error:'Only failed jobs can be retried.'});const cfg={...j.rawCfg};return json(res,202,{jobId:createQueueJob(cfg).id});}
    if(req.method==='GET'&&u.pathname.startsWith('/api/download/')){const parts=u.pathname.split('/');const j=jobs.get(parts[3]);return download(res,j,j&&j.apk,'apk');}
    if(req.method==='GET'&&u.pathname.startsWith('/api/aab/')){const parts=u.pathname.split('/');const j=jobs.get(parts[3]);return download(res,j,j&&j.aab,'aab');}
    if(req.method==='GET')return staticFile(req,res);
    return send(res,404,'Not found');
  }catch(e){return json(res,400,{error:e.message||'Request failed'});}
});
server.listen(PORT,()=>console.log(`WebToAPK Studio listening on ${PORT}`));
