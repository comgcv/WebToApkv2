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
const MAX_SPLASH_VIDEO = 12 * 1024 * 1024;
const MAX_OFFLINE_TOTAL = 18 * 1024 * 1024;
const MAX_OFFLINE_FILE = 4 * 1024 * 1024;
const MAX_OFFLINE_FILES = 80;

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
function extractGradleFailure(out, err){
  const combined=(out||"")+"\n"+(err||"");
  const lines=combined.split(/\r?\n/).map(x=>x.trimEnd()).filter(Boolean);
  const markers=["* What went wrong:","Execution failed for task","> Task :app:","Caused by:","FAILURE: Build failed with an exception.","error:"];
  const picked=[];
  for(const marker of markers){
    const i=lines.findIndex(x=>x.includes(marker));
    if(i>=0){
      picked.push(...lines.slice(Math.max(0,i-1),Math.min(lines.length,i+12)));
    }
  }
  const unique=[...new Set(picked)];
  const tail=lines.slice(-80);
  const text=[...new Set([...unique,...tail])].join("\n");
  return text.slice(-12000) || "Gradle failed without a readable error message";
}
function run(cmd,args,cwd,timeout=270000,onProgress=()=>{},signal=null){
  return new Promise((resolve,reject)=>{
    const p=spawn(cmd,args,{cwd,env:{...process.env,ANDROID_SDK_ROOT:SDK,ANDROID_HOME:SDK,GRADLE_USER_HOME:"/tmp/gradle-home"}});
    let out="",err="",settled=false;
    const abortHandler=()=>{if(settled)return;try{p.kill('SIGKILL')}catch{};};
    if(signal) signal.addEventListener('abort',abortHandler,{once:true});
    const timer=setTimeout(()=>{
      if(settled)return;
      settled=true;p.kill("SIGKILL");
      reject(new Error("Build timeout setelah 270 detik. Coba build lagi dengan project yang lebih ringan."));
    },timeout);
    const progressFrom=(text)=>{
      const all=(out+"\n"+err+"\n"+text).slice(-16000);
      if(/BUILD SUCCESSFUL/i.test(all)) onProgress(98,"Gradle selesai");
      else if(/BUILD FAILED|FAILURE: Build failed/i.test(all)) onProgress(96,"Gradle melaporkan kegagalan — membaca penyebab...");
      else if(/Task :app:compile/i.test(all)) onProgress(55,"Compiling Android app...");
      else if(/Task :app:process.*Resources/i.test(all)) onProgress(48,"Processing app resources...");
      else if(/Task :app:merge.*Resources/i.test(all)) onProgress(44,"Merging resources...");
      else if(/Task :app:package/i.test(all)) onProgress(88,"Packaging APK...");
      else onProgress(null,text.trim().split(/\r?\n/).filter(Boolean).slice(-1)[0]||"Building Android project...");
    };
    p.stdout.on("data",d=>{const x=d.toString();out+=x;progressFrom(x);});
    p.stderr.on("data",d=>{const x=d.toString();err+=x;progressFrom(x);});
    p.on("error",e=>{
      if(settled)return;settled=true;clearTimeout(timer);reject(new Error("Tidak dapat menjalankan Gradle: "+e.message));
    });
    p.on("close",code=>{
      if(settled)return;
      settled=true;clearTimeout(timer);
      if(signal) signal.removeEventListener('abort',abortHandler);
      if(code===0) resolve(out);
      else reject(new Error(extractGradleFailure(out,err)));
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
function offlineSkip(u){return /^(?:data:|javascript:|mailto:|tel:|#|blob:|about:)/i.test(String(u||''));}
function offlineExt(type,url){
  const m=String(url||'').split('?')[0].match(/\.([a-z0-9]{1,8})$/i);
  if(m)return m[1].toLowerCase();
  const t=String(type||'').split(';')[0].toLowerCase();
  return ({'text/css':'css','application/javascript':'js','text/javascript':'js','application/json':'json','image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/svg+xml':'svg','image/gif':'gif','font/woff':'woff','font/woff2':'woff2','font/ttf':'ttf','font/otf':'otf','audio/mpeg':'mp3','audio/ogg':'ogg','video/mp4':'mp4'})[t]||'bin';
}
async function fetchOfflineResource(u){
  const r=await fetch(u,{redirect:'follow',headers:{'User-Agent':'WebToAPKStudio Offline Packager/1.5.4','Accept':'*/*'}});
  if(!r.ok)throw new Error('HTTP '+r.status);
  const type=r.headers.get('content-type')||'application/octet-stream';
  const ab=await r.arrayBuffer();
  const buf=Buffer.from(ab);
  if(buf.length>MAX_OFFLINE_FILE)throw new Error('file exceeds 4 MB');
  return {buf,type,url:r.url||u};
}
async function prepareOfflineBundle(cfg,dir){
  const assetsRoot=path.join(dir,'app/src/main/assets');
  mkdir(assetsRoot);
  let html='';
  let baseUrl=null;
  const warnings=[]; const files=new Map(); let total=0;
  const queue=[];
  if(cfg.sourceType==='html'){
    html=normalizeHtml(cfg.html);
  }else{
    const target=new URL(cfg.url);
    baseUrl=target.href;
    const page=await fetchOfflineResource(target.href);
    if(!/^text\/html|application\/xhtml\+xml/i.test(page.type))throw new Error('Offline mode membutuhkan halaman HTML dari URL. Content-Type: '+page.type);
    html=page.buf.toString('utf8');
    const finalUrl=page.url||target.href;
    baseUrl=finalUrl;
  }
  const pageOrigin=baseUrl?new URL(baseUrl).origin:null;
  const fileFor=(u,type)=>{
    const x=new URL(u);
    const hash=crypto.createHash('sha1').update(x.href).digest('hex').slice(0,10);
    const ext=offlineExt(type,x.pathname);
    return 'offline/'+hash+(ext?'_'+safe(path.basename(x.pathname).replace(/\.[^.]+$/,'')):'')+'.'+ext;
  };
  const addUrl=async(raw,base)=>{
    if(offlineSkip(raw))return null;
    let abs; try{abs=new URL(raw,base||baseUrl||undefined);}catch{return null;}
    if(!/^https?:$/i.test(abs.protocol))return null;
    if(pageOrigin && abs.origin!==pageOrigin){warnings.push('Resource eksternal tidak dipaketkan: '+abs.origin);return null;}
    if(files.has(abs.href))return files.get(abs.href).local;
    if(files.size>=MAX_OFFLINE_FILES){warnings.push('Batas '+MAX_OFFLINE_FILES+' resource offline tercapai.');return null;}
    try{
      const r=await fetchOfflineResource(abs.href);
      if(total+r.buf.length>MAX_OFFLINE_TOTAL)throw new Error('total offline bundle exceeds 18 MB');
      const local=fileFor(r.url||abs.href,r.type);
      files.set(abs.href,{local,type:r.type,buf:r.buf,url:r.url||abs.href}); total+=r.buf.length;
      queue.push(files.get(abs.href));
      return local;
    }catch(e){warnings.push('Resource gagal dipaketkan: '+abs.href+' ('+e.message+')');return null;}
  };
  // First pass: HTML src/href/action and common inline style url().
  const attrRe=/\b(src|href|poster|action)=(['"])(.*?)\2/gi;
  const attrs=[]; let m;
  while((m=attrRe.exec(html)))attrs.push({start:m.index,attr:m[1],quote:m[2],value:m[3]});
  for(const a of attrs){
    const local=await addUrl(a.value,baseUrl); if(local){const replacement=a.attr+'='+a.quote+local+a.quote; html=html.slice(0,a.start)+replacement+html.slice(a.start+a.attr.length+a.quote.length+a.value.length+a.quote.length); attrRe.lastIndex=a.start+replacement.length;}
  }
  // Download CSS files referenced by the HTML and recursively package url() assets.
  const cssEntries=[...files.values()].filter(x=>/text\/css/i.test(x.type)||/\.css$/i.test(x.url));
  for(let i=0;i<cssEntries.length;i++){
    const entry=cssEntries[i]; let css=entry.buf.toString('utf8'); const cssBase=entry.url;
    const urls=[]; const re=/url\(\s*(['"]?)(.*?)\1\s*\)/gi; let cm;
    while((cm=re.exec(css)))urls.push({start:cm.index,value:cm[2],full:cm[0]});
    for(const u of urls){const local=await addUrl(u.value,cssBase);if(local){const cssLocal='../'+local;const old=u.full;const next=old.replace(u.value,cssLocal);css=css.slice(0,u.start)+next+css.slice(u.start+old.length);re.lastIndex=u.start+next.length;}}
    entry.buf=Buffer.from(css); entry.type='text/css';
  }
  // Save packaged resources and rewrite HTML/CSS references.
  for(const entry of files.values())write(path.join(assetsRoot,entry.local),entry.buf);
  // Re-run HTML replacements cleanly using URL lookup map to avoid offset drift.
  html=html.replace(/\b(src|href|poster|action)=(['"])(.*?)\2/gi,(full,attr,q,value)=>{
    if(offlineSkip(value))return full;
    let abs;try{abs=new URL(value,baseUrl||undefined)}catch{return full;}
    const hit=files.get(abs.href);return hit?attr+'='+q+hit.local+q:full;
  });
  // Inline CSS url() in the HTML can reference same-origin resources too.
  const htmlCssUrls=[]; const hre=/url\(\s*(['"]?)(.*?)\1\s*\)/gi; let hm;
  while((hm=hre.exec(html)))htmlCssUrls.push({value:hm[2]});
  for(const u of htmlCssUrls){const abs=(()=>{try{return new URL(u.value,baseUrl||undefined)}catch{return null}})();const hit=abs&&files.get(abs.href);if(hit)html=html.replaceAll(u.value,hit.local);}
  write(path.join(assetsRoot,'index.html'),html);
  write(path.join(assetsRoot,'offline-manifest.json'),JSON.stringify({mode:'static-offline',files:files.size,totalBytes:total,warnings},null,2));
  return {files:files.size,totalBytes:total,warnings};
}
function htmlFileFromConfig(cfg,dir){
  const html=normalizeHtml(cfg.html);
  write(path.join(dir,"app/src/main/assets/index.html"), html);
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
function writeSplashVideo(cfg,dir){
  if(!cfg.splashVideo) return false;
  const m=String(cfg.splashVideo).match(/^data:video\/mp4;base64,([A-Za-z0-9+/=]+)$/);
  if(!m) throw new Error("Splash video must be an MP4 file");
  const buf=Buffer.from(m[1],"base64");
  if(!buf.length || buf.length>MAX_SPLASH_VIDEO) throw new Error("Splash video is invalid or too large (max 12 MB)");
  write(path.join(dir,"app/src/main/res/raw/splash.mp4"),buf);
  return true;
}
async function project(cfg,dir){
  const pkg=packageName(cfg.pkg), app=safe(cfg.name), isHtml=cfg.sourceType==='html', url=isHtml?'':cfg.url;
  const offline=!!cfg.offlineMode;
  let offlineInfo=null;
  const vName=versionName(cfg.version), vCode=versionCode(vName), fullscreen=!!cfg.fullscreen;
  const orientation=['portrait','landscape','unspecified'].includes(cfg.orientation)?cfg.orientation:'portrait';
  const permissions=cfg.permissions||{};
  const splashMode=['none','icon','fade','name','video'].includes(cfg.splashMode)?cfg.splashMode:'none';
  const hasSplash=splashMode!=='none' && (splashMode==='video'?!!cfg.splashVideo:true);
  if(cfg.platform && cfg.platform!=='android') throw new Error('Only Android builds are supported currently');
  if(cfg.offlineMode && typeof cfg.offlineMode!=='boolean') throw new Error('Invalid offline mode setting');
  write(path.join(dir,'settings.gradle'),`pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }
dependencyResolutionManagement { repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS); repositories { google(); mavenCentral() } }
rootProject.name="${app}"
include(":app")`);
  write(path.join(dir,'build.gradle'),`plugins { id 'com.android.application' version '8.11.1' apply false }`);
  write(path.join(dir,'gradle.properties'),'org.gradle.jvmargs=-Xmx1536m\nandroid.useAndroidX=true\n');
  write(path.join(dir,'app/build.gradle'),`plugins { id 'com.android.application' }
android { namespace '${pkg}'; compileSdk 36
 defaultConfig { applicationId '${pkg}'; minSdk 23; targetSdk 36; versionCode ${vCode}; versionName "${xml(vName)}" }
 compileOptions { sourceCompatibility JavaVersion.VERSION_17; targetCompatibility JavaVersion.VERSION_17 }
}`);
  const iconLine=cfg.icon?'android:icon="@drawable/app_icon"':'';
  const permLines=[];
  if(permissions.camera)permLines.push('<uses-permission android:name="android.permission.CAMERA"/>');
  if(permissions.microphone)permLines.push('<uses-permission android:name="android.permission.RECORD_AUDIO"/>');
  if(permissions.location)permLines.push('<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION"/>','<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION"/>');
  if(permissions.notifications)permLines.push('<uses-permission android:name="android.permission.POST_NOTIFICATIONS"/>');
  // File uploads use WebView's chooser; broad storage permissions are intentionally not added.
  const splashActivity=hasSplash?`<activity android:name=".SplashActivity" android:screenOrientation="portrait" android:exported="true"><intent-filter><action android:name="android.intent.action.MAIN"/><category android:name="android.intent.category.LAUNCHER"/></intent-filter></activity>`:'';
  const launcher=hasSplash?'':`<intent-filter><action android:name="android.intent.action.MAIN"/><category android:name="android.intent.category.LAUNCHER"/></intent-filter>`;
  write(path.join(dir,'app/src/main/AndroidManifest.xml'),`<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
${permLines.join('\n')}
${offline?"":"<uses-permission android:name=\"android.permission.INTERNET\"/>"}
<application android:theme="@style/AppTheme" android:label="${xml(cfg.name)}" ${iconLine} android:usesCleartextTraffic="true" android:hardwareAccelerated="true">
${splashActivity}
<activity android:name=".MainActivity" android:screenOrientation="${fullscreen?'unspecified':orientation}" android:exported="true">${launcher}</activity>
</application></manifest>`);
  write(path.join(dir,'app/src/main/res/values/styles.xml'),`<resources><style name="AppTheme" parent="android:style/Theme.Material.Light.NoActionBar"><item name="android:fontFamily">sans</item><item name="android:colorAccent">#171922</item><item name="android:windowNoTitle">true</item></style></resources>`);
  if(offline){offlineInfo=await prepareOfflineBundle(cfg,dir);}else if(isHtml){htmlFileFromConfig(cfg,dir);const fontSrc=path.join(__dirname,'public/font/twin.ttf');if(fs.existsSync(fontSrc)){write(path.join(dir,'app/src/main/assets/font/twin.ttf'),fs.readFileSync(fontSrc));write(path.join(dir,'app/src/main/assets/font/twin.tff'),fs.readFileSync(fontSrc));}}
  if(cfg.icon)writeIcon(cfg,dir);
  if(splashMode==='video')writeSplashVideo(cfg,dir);
  if(hasSplash){
    const splashJava=splashMode==='video'?`package ${pkg};
import android.app.Activity;import android.os.Bundle;import android.content.Intent;import android.graphics.Color;import android.graphics.Matrix;import android.view.Surface;import android.view.TextureView;import android.media.MediaPlayer;import android.net.Uri;import android.view.ViewGroup;
public class SplashActivity extends Activity{
 private TextureView videoView;private MediaPlayer player;private boolean opened=false;
 private void openMain(){if(opened)return;opened=true;if(player!=null){try{player.stop();}catch(Exception e){}try{player.release();}catch(Exception e){}player=null;}startActivity(new Intent(this,MainActivity.class));finish();}
 private void fitVideo(int vw,int vh){if(videoView==null||vw<=0||vh<=0)return;int sw=videoView.getWidth(),sh=videoView.getHeight();if(sw<=0||sh<=0)return;float scale=Math.max((float)sw/vw,(float)sh/vh);float dx=(sw-vw*scale)/2f,dy=(sh-vh*scale)/2f;Matrix m=new Matrix();m.setScale(scale,scale);m.postTranslate(dx,dy);videoView.setTransform(m);}
 @Override public void onCreate(Bundle b){super.onCreate(b);getWindow().setStatusBarColor(Color.BLACK);getWindow().setNavigationBarColor(Color.BLACK);videoView=new TextureView(this);videoView.setOpaque(true);videoView.setLayoutParams(new ViewGroup.LayoutParams(-1,-1));setContentView(videoView);videoView.setSurfaceTextureListener(new TextureView.SurfaceTextureListener(){public void onSurfaceTextureAvailable(android.graphics.SurfaceTexture st,int w,int h){try{player=new MediaPlayer();player.setDataSource(SplashActivity.this,Uri.parse("android.resource://"+getPackageName()+"/raw/splash"));player.setSurface(new Surface(st));player.setLooping(false);player.setOnPreparedListener(new MediaPlayer.OnPreparedListener(){public void onPrepared(MediaPlayer mp){fitVideo(mp.getVideoWidth(),mp.getVideoHeight());mp.start();}});player.setOnCompletionListener(new MediaPlayer.OnCompletionListener(){public void onCompletion(MediaPlayer mp){openMain();}});player.setOnErrorListener(new MediaPlayer.OnErrorListener(){public boolean onError(MediaPlayer mp,int what,int extra){openMain();return true;}});player.prepareAsync();}catch(Exception e){openMain();}}public void onSurfaceTextureSizeChanged(android.graphics.SurfaceTexture st,int w,int h){if(player!=null)fitVideo(player.getVideoWidth(),player.getVideoHeight());}public boolean onSurfaceTextureDestroyed(android.graphics.SurfaceTexture st){if(player!=null){try{player.setSurface(null);}catch(Exception e){}}return true;}public void onSurfaceTextureUpdated(android.graphics.SurfaceTexture st){}});}
 @Override protected void onDestroy(){if(player!=null){try{player.release();}catch(Exception e){}player=null;}super.onDestroy();}
}`:
`package ${pkg};
import android.app.Activity;import android.os.Bundle;import android.content.Intent;import android.graphics.Color;import android.view.Gravity;import android.view.View;import android.view.animation.AlphaAnimation;import android.widget.FrameLayout;import android.widget.ImageView;import android.widget.TextView;
public class SplashActivity extends Activity{private final android.os.Handler handler=new android.os.Handler();private void openMain(){startActivity(new Intent(this,MainActivity.class));finish();}@Override public void onCreate(Bundle b){super.onCreate(b);getWindow().setStatusBarColor(Color.BLACK);getWindow().setNavigationBarColor(Color.BLACK);FrameLayout root=new FrameLayout(this);root.setBackgroundColor(Color.BLACK);ImageView img=new ImageView(this);img.setImageResource(${cfg.icon?'R.drawable.app_icon':'android.R.drawable.sym_def_app_icon'});img.setScaleType(ImageView.ScaleType.CENTER_INSIDE);FrameLayout.LayoutParams ip=new FrameLayout.LayoutParams(180,180,Gravity.CENTER);root.addView(img,ip);${splashMode==='name'?`TextView name=new TextView(this);name.setText("${java(cfg.name)}");name.setTextColor(Color.WHITE);name.setTextSize(17);name.setGravity(Gravity.CENTER);FrameLayout.LayoutParams np=new FrameLayout.LayoutParams(-2,-2,Gravity.CENTER_HORIZONTAL|Gravity.CENTER_VERTICAL);np.topMargin=125;root.addView(name,np);`:''}setContentView(root);${splashMode==='icon'?`handler.postDelayed(new Runnable(){public void run(){openMain();}},900);`:`img.setAlpha(0f);if(${splashMode==='name'?'true':'false'}){}img.animate().alpha(1f).setDuration(450).withEndAction(new Runnable(){public void run(){handler.postDelayed(new Runnable(){public void run(){img.animate().alpha(0f).setDuration(450).withEndAction(new Runnable(){public void run(){openMain();}}).start();}},650);}}).start();`}}}`;
    write(path.join(dir,'app/src/main/java',...pkg.split('.'),'SplashActivity.java'),splashJava);
  }
  const load=(isHtml||offline)?'web.loadUrl("file:///android_asset/index.html");':`web.loadUrl("${java(url)}");`;
  const fsPart=fullscreen?`private void applyFullscreen(){final int flags=android.view.View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY|android.view.View.SYSTEM_UI_FLAG_FULLSCREEN|android.view.View.SYSTEM_UI_FLAG_HIDE_NAVIGATION|android.view.View.SYSTEM_UI_FLAG_LAYOUT_STABLE|android.view.View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN|android.view.View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION;getWindow().getDecorView().setSystemUiVisibility(flags);}`:`private void applyFullscreen(){}`;
  const reload=cfg.reloadMode||'none';
  const touch=reload==='tap'?`private long lastTap=0;`:'private long lastTap=0;';
  const touchBlock=reload==='tap'?`web.setOnTouchListener(new android.view.View.OnTouchListener(){public boolean onTouch(android.view.View v,android.view.MotionEvent e){if(e.getAction()==android.view.MotionEvent.ACTION_UP){long now=android.os.SystemClock.elapsedRealtime();if(lastTap>0 && now-lastTap<=450){web.reload();lastTap=0;}else{lastTap=now;}}return false;}});`:'';
  // Pull-to-refresh uses a dependency-free WebView touch gesture detector to avoid changing the existing Gradle engine.
  const pull=reload==='pull'?`private float downY;private boolean moved=false;`:'private float downY;private boolean moved=false;';
  const pullBlock=reload==='pull'?`web.setOnTouchListener(new android.view.View.OnTouchListener(){public boolean onTouch(android.view.View v,android.view.MotionEvent e){if(e.getAction()==android.view.MotionEvent.ACTION_DOWN){downY=e.getY();moved=false;}else if(e.getAction()==android.view.MotionEvent.ACTION_MOVE&&e.getY()-downY>100&&web.getScrollY()<=0){moved=true;}else if(e.getAction()==android.view.MotionEvent.ACTION_UP&&moved){web.reload();downY=0;moved=false;}return false;}});`:'';
  const runtimePerms=[]; if(permissions.camera)runtimePerms.push('android.permission.CAMERA'); if(permissions.microphone)runtimePerms.push('android.permission.RECORD_AUDIO'); if(permissions.location)runtimePerms.push('android.permission.ACCESS_FINE_LOCATION'); if(permissions.notifications)runtimePerms.push('android.permission.POST_NOTIFICATIONS');
  const permArray=runtimePerms.length?runtimePerms.map(x=>'\"'+x+'\"').join(',') : '';
  const chrome=`new WebChromeClient(){@Override public void onPermissionRequest(final PermissionRequest r){runOnUiThread(new Runnable(){public void run(){java.util.ArrayList<String> g=new java.util.ArrayList<>();for(String x:r.getResources()){if(x.equals(PermissionRequest.RESOURCE_VIDEO_CAPTURE)&&${permissions.camera}&&checkSelfPermission("android.permission.CAMERA")==PackageManager.PERMISSION_GRANTED)g.add(x);else if(x.equals(PermissionRequest.RESOURCE_AUDIO_CAPTURE)&&${permissions.microphone}&&checkSelfPermission("android.permission.RECORD_AUDIO")==PackageManager.PERMISSION_GRANTED)g.add(x);}if(g.size()>0)r.grant(g.toArray(new String[0]));else r.deny();}});}@Override public void onGeolocationPermissionsShowPrompt(String o,GeolocationPermissions.Callback c){if(${permissions.location}&&checkSelfPermission("android.permission.ACCESS_FINE_LOCATION")==PackageManager.PERMISSION_GRANTED)c.invoke(o,true,false);else c.invoke(o,false,false);}}`;
  write(path.join(dir,'app/src/main/java',...pkg.split('.'),'MainActivity.java'),`package ${pkg};
import android.app.Activity;import android.os.Bundle;import android.webkit.*;import android.view.*;import android.graphics.Color;import android.content.pm.PackageManager;
public class MainActivity extends Activity{WebView web;${touch}${pull}
 @Override public void onCreate(Bundle b){super.onCreate(b);web=new WebView(this);WebSettings s=web.getSettings();s.setJavaScriptEnabled(true);s.setDomStorageEnabled(true);s.setDatabaseEnabled(true);s.setLoadWithOverviewMode(true);s.setUseWideViewPort(true);s.setMediaPlaybackRequiresUserGesture(false);s.setAllowFileAccess(true);s.setAllowContentAccess(true);s.setAllowFileAccessFromFileURLs(true);s.setAllowUniversalAccessFromFileURLs(false);web.setWebViewClient(new WebViewClient());web.setWebChromeClient(${chrome});getWindow().setStatusBarColor(Color.BLACK);getWindow().setNavigationBarColor(Color.BLACK);${touchBlock}${pullBlock}setContentView(web);${load};requestSelectedPermissions();applyFullscreen();}
 private void requestSelectedPermissions(){String[] p={${permArray}};if(android.os.Build.VERSION.SDK_INT<23||p.length==0)return;if(android.os.Build.VERSION.SDK_INT<33&&p.length>0){java.util.ArrayList<String> a=new java.util.ArrayList<>();for(String x:p)if(!x.equals("android.permission.POST_NOTIFICATIONS"))a.add(x);p=a.toArray(new String[0]);}if(p.length>0)requestPermissions(p,700);}
 @Override public void onRequestPermissionsResult(int r,String[] p,int[] g){super.onRequestPermissionsResult(r,p,g);}
 @Override public void onWindowFocusChanged(boolean h){super.onWindowFocusChanged(h);if(h)applyFullscreen();}@Override public void onBackPressed(){if(web!=null&&web.canGoBack())web.goBack();else super.onBackPressed();}${fsPart}}
`);
  write(path.join(dir,'gradle/wrapper/gradle-wrapper.properties'),'distributionUrl=https\\://services.gradle.org/distributions/gradle-8.13-bin.zip');write(path.join(dir,'gradlew'),`#!/bin/sh\nexec ${GRADLE} "$@"`);fs.chmodSync(path.join(dir,'gradlew'),0o755);
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
  if(!cfg.version || !/^\d{1,3}\.\d{1,3}(\.\d{1,3})?$/.test(String(cfg.version))) throw new Error("Invalid version (use e.g. 1.0 or 1.0.1)");
  if(!cfg.pkg || !/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/.test(cfg.pkg)) throw new Error("Invalid package name");
  if(cfg.sourceType==="html"){
    const size=Buffer.byteLength(String(cfg.html||""),"utf8");
    if(!cfg.html || size>MAX_HTML) throw new Error("HTML file is empty or exceeds 3 MB");
  }else{
    if(!/^https?:\/\//i.test(cfg.url||"")) throw new Error("URL must be http or https");
  }
  if(cfg.icon && String(cfg.icon).length>1400000) throw new Error("Icon payload too large");
  if(cfg.splashVideo){
    const m=String(cfg.splashVideo).match(/^data:video\/mp4;base64,([A-Za-z0-9+/=]+)$/);
    if(!m) throw new Error("Splash video must be an MP4 file");
    if(Buffer.from(m[1],"base64").length>MAX_SPLASH_VIDEO) throw new Error("Splash video too large (max 12 MB)");
  }
  if(cfg.platform && cfg.platform!=='android') throw new Error('Only Android builds are supported currently');
  if(cfg.splashMode && !['none','icon','fade','name','video'].includes(cfg.splashMode)) throw new Error('Invalid splash mode');
  if(cfg.splashMode==='video' && !cfg.splashVideo) throw new Error('Splash video is required for video mode');
  if(cfg.reloadMode && !['none','pull','tap'].includes(cfg.reloadMode)) throw new Error('Invalid reload mode');
  if(cfg.orientation && !['portrait','landscape','unspecified'].includes(cfg.orientation)) throw new Error('Invalid orientation');
  if(cfg.permissions && typeof cfg.permissions!=='object') throw new Error('Invalid permissions');
}

async function inspectSource(cfg){
  const checks=[]; const warnings=[];
  validateConfig(cfg);
  checks.push('Nama aplikasi valid');
  checks.push('Version valid');
  checks.push('Package APK valid');
  checks.push('Konfigurasi fullscreen valid');
  if(cfg.offlineMode) warnings.push('Offline Mode membuat snapshot statis lokal. API, login online, WebSocket, database cloud, dan resource yang gagal diunduh tidak akan bekerja tanpa internet.');
  if(cfg.sourceType==='html'){
    const html=String(cfg.html||'');
    if(!/<html(?:\s|>)/i.test(html)) throw new Error('File HTML tidak memiliki tag <html> yang valid');
    if(!/<body(?:\s|>)/i.test(html)) warnings.push('Tag <body> tidak ditemukan; HTML masih dapat dibuild tetapi sebaiknya diperiksa.');
    if(!/<head(?:\s|>)/i.test(html)) warnings.push('Tag <head> tidak ditemukan; resource relatif mungkin perlu diperbaiki.');
    checks.push('File HTML terbaca dan ukuran berada dalam batas 3 MB');
    checks.push('Struktur HTML dasar terdeteksi');
  }else{
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),12000);
    try{
      const target=new URL(cfg.url);
      const r=await fetch(target.href,{redirect:'follow',signal:controller.signal,headers:{'User-Agent':'Mozilla/5.0 (WebToAPK Structure Check)','Accept':'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'}});
      const type=r.headers.get('content-type')||'';
      if(!r.ok) throw new Error(`Website merespons HTTP ${r.status}`);
      if(type && !/text\/html|application\/xhtml\+xml/i.test(type)) warnings.push('URL dapat diakses, tetapi Content-Type bukan HTML. WebView tetap akan mencoba memuatnya.');
      checks.push(`Website dapat diakses (HTTP ${r.status})`);
      checks.push('URL menggunakan HTTP/HTTPS yang valid');
    }catch(e){
      if(e.name==='AbortError') throw new Error('Pemeriksaan website timeout setelah 12 detik');
      throw new Error('Website tidak dapat diperiksa dari server: '+e.message);
    }finally{clearTimeout(timer)}
  }
  return {ok:true,checks,warnings};
}

async function checkOfflineCompatibility(cfg){
  validateConfig(cfg);
  const temp=path.join(ROOT,'offline-check-'+crypto.randomUUID());
  mkdir(temp);
  try{
    let source='';
    if(cfg.sourceType==='url'){
      const page=await fetchOfflineResource(cfg.url);
      source=page.buf.toString('utf8');
    }else source=normalizeHtml(cfg.html);
    const dynamic=[];
    const dynamicRules=[
      [/\bWebSocket\s*\(/i,'WebSocket'],[/\bEventSource\s*\(/i,'EventSource'],[/\bfetch\s*\(/i,'fetch() API'],[/\bXMLHttpRequest\b/i,'XMLHttpRequest'],[/\baxios\b/i,'Axios'],[/\b(?:firebase|supabase)\b/i,'cloud SDK'],[/\bnavigator\.serviceWorker\b/i,'Service Worker']
    ];
    for(const [re,label] of dynamicRules)if(re.test(source))dynamic.push(label);
    const external=[...source.matchAll(/(?:src|href|action)=["'](https?:\/\/[^"']+)["']/gi)].map(m=>m[1]);
    const result=await prepareOfflineBundle(cfg,temp);
    const warnings=[...result.warnings];
    if(dynamic.length)warnings.push('Dynamic dependency terdeteksi: '+dynamic.join(', ')+'.');
    if(external.length)warnings.push('Referensi URL absolut terdeteksi: '+external.length+' item; hanya resource yang diizinkan oleh packager yang dapat dilokalkan.');
    const status=(warnings.length===0&&result.files>0)?'READY':(result.files>0?'PARTIAL':'NOT_SUITABLE');
    return {ok:true,status,files:result.files,totalBytes:result.totalBytes,warnings,dynamicDependencies:dynamic,externalReferences:external.length,message:status==='READY'?'Source cocok untuk static offline packaging.':status==='PARTIAL'?'Source dapat dipaketkan sebagian, tetapi ada dependency yang tidak dapat dipastikan offline.':'Source tidak memiliki bundle offline yang cukup untuk dipakai.'};
  }finally{
    try{fs.rmSync(temp,{recursive:true,force:true});}catch{}
  }
}
async function handleOfflineCheck(req,res){
  try{
    const cfg=await parseBody(req);
    const out=await checkOfflineCompatibility(cfg);
    return send(res,200,JSON.stringify(out),'application/json');
  }catch(e){
    return send(res,400,JSON.stringify({ok:false,status:'NOT_SUITABLE',errors:[e.message],warnings:[]}),'application/json');
  }
}

async function handleInspect(req,res){
  try{
    const cfg=await parseBody(req);
    const out=await inspectSource(cfg);
    return send(res,200,JSON.stringify(out),'application/json');
  }catch(e){
    return send(res,400,JSON.stringify({ok:false,errors:[e.message],warnings:[]}),'application/json');
  }
}

function validateGeneratedProject(dir,cfg){
  const required=[
    'settings.gradle','build.gradle','gradle.properties',
    'app/build.gradle','app/src/main/AndroidManifest.xml',
    'app/src/main/res/values/styles.xml',
    'app/src/main/java/'+packageName(cfg.pkg).split('.').join('/')+'/MainActivity.java'
  ];
  if(['icon','fade','name','video'].includes(cfg.splashMode||'none')){
    required.push('app/src/main/java/'+packageName(cfg.pkg).split('.').join('/')+'/SplashActivity.java');
  }
  if(cfg.icon) required.push('app/src/main/res/drawable/app_icon.png');
  if(cfg.splashMode==='video') required.push('app/src/main/res/raw/splash.mp4');
  const missing=required.filter(x=>!fs.existsSync(path.join(dir,x)));
  if(missing.length) throw new Error('Generated Android project tidak lengkap: '+missing.join(', '));
  const main=fs.readFileSync(path.join(dir,'app/src/main/java',...packageName(cfg.pkg).split('.'),'MainActivity.java'),'utf8');
  if(!main.includes('class MainActivity')) throw new Error('MainActivity.java tidak valid');
  if(cfg.reloadMode==='tap' && !main.includes('OnTouchListener')) throw new Error('Konfigurasi tap 2x gagal dibuat');
}

async function build(cfg,onProgress=()=>{},signal=null){
  validateConfig(cfg);
  const dir=path.join(ROOT,crypto.randomUUID());mkdir(dir);
  try{
    onProgress(12,"Validating configuration...");
    await project(cfg,dir);
    validateGeneratedProject(dir,cfg);
    onProgress(25,"Android project prepared and validated...");
    await run(GRADLE,["--no-daemon","--stacktrace","--console=plain","assembleDebug"],dir,270000,onProgress,signal);
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
  const abortController=new AbortController();
  let disconnected=false;
  res.on("close",()=>{if(!res.writableEnded){disconnected=true;abortController.abort();}});
  try{cfg=await parseBody(req);validateConfig(cfg);}catch(e){return send(res,400,e.message);}
  res.writeHead(200,{"Content-Type":"application/x-ndjson; charset=utf-8","Cache-Control":"no-store","X-Accel-Buffering":"no"});
  const writeEvent=(type,payload={})=>{try{res.write(jsonLine({type,...payload}));}catch{}};
  const buildId="WTA-"+crypto.randomBytes(3).toString("hex").toUpperCase();
  writeEvent("started",{message:"Build started",buildId});
  let result;
  try{
    result=await build(cfg,(progress,message)=>{
      const p=progress==null?undefined:Math.max(1,Math.min(99,progress));
      writeEvent("progress",{progress:p,message});
    },abortController.signal);
    if(disconnected) return;
    const data=fs.readFileSync(result.apk).toString("base64");
    writeEvent("completed",{progress:100,message:"Build complete",name:result.name,size:result.size,apk:data,buildId});
  }catch(e){
    if(disconnected || e.name==="AbortError" || /aborted|SIGKILL/i.test(e.message||"")) return;
    writeEvent("failed",{progress:100,message:e.message,buildId});
  }
  if(!disconnected) res.end();
}

const server=http.createServer(async(req,res)=>{
  const u=new URL(req.url,"http://localhost");
  if(req.method==="GET" && u.pathname==="/health") return send(res,200,JSON.stringify({ok:true,engine:"android-webview",version:"1.5.12",node:process.version,sdk:SDK,gradle:"Gradle + Android Gradle Plugin 8.11.1"}),"application/json");
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
  if(req.method==="POST" && u.pathname==="/api/inspect") return handleInspect(req,res);
  if(req.method==="POST" && u.pathname==="/api/offline-check") return handleOfflineCheck(req,res);
  if(req.method==="POST" && u.pathname==="/api/build") return handleBuild(req,res);
  send(res,404,"Not found");
});
if(require.main===module) server.listen(PORT,"0.0.0.0",()=>console.log("Web to APK server v1.5.12 listening on "+PORT));
module.exports={project,validateConfig,normalizeHtml,writeIcon,writeSplashVideo,versionCode,versionName,prepareOfflineBundle};
