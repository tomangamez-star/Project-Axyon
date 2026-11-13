'use strict'
const crypto=require('crypto'),fs=require('fs/promises'),path=require('path')
const {createAxyonAdmin}=require('./axyon-admin')
const {createAxyon}=require('./axyon-rpg')
const {createCommands}=require('./axyon-commands')
const PUBLIC=path.join(__dirname,'..','public')
const MIME={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'application/javascript; charset=utf-8'}
function json(res,status,data,headers={}){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store',...headers});res.end(JSON.stringify(data))}
function safeEqual(a,b){const x=Buffer.from(String(a||'')),y=Buffer.from(String(b||''));return x.length===y.length&&crypto.timingSafeEqual(x,y)}
function cookies(req){return Object.fromEntries(String(req.headers.cookie||'').split(';').map(x=>x.trim().split(/=(.*)/s)).filter(x=>x[0]).map(([k,v])=>[k,decodeURIComponent(v||'')]))}
async function body(req,max=16384){const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>max)throw Object.assign(Error('Request too large'),{status:413});chunks.push(chunk)}if(!chunks.length)return{};try{return JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{throw Object.assign(Error('Invalid JSON'),{status:400})}}
function maskPhone(value){const x=String(value||'').split(':')[0].split('@')[0].replace(/\D/g,'');return x.length>7?`+${x.slice(0,3)} ••• ••${x.slice(-4)}`:x?'Connected account':'Not available'}
function formatPairingCode(value){const raw=String(value||'').replace(/[^a-z0-9]/gi,'');return raw.match(/.{1,4}/g)?.join('-')||raw}
function createDashboard({sessions,database,lease,logger}){
 const webSessions=new Map(),failures=new Map(),password=String(process.env.DASHBOARD_PASSWORD||process.env.OWNER_DASHBOARD_PASSWORD||''),hours=Math.max(1,Math.min(168,Number(process.env.DASHBOARD_SESSION_HOURS)||24))
 const axyonAdmin=createAxyonAdmin({logger})
 /* The command registry, so the site's help screen can never drift from what
  * the bot actually answers to. Built once, read-only. */
 const commandIndex=(()=>{try{const axyon=createAxyon({logger});createCommands({axyon,logger});return axyon.COMMANDS.filter(c=>!c.hidden).map(c=>({name:c.name,section:c.section,usage:c.usage.replace(/\{p\}/g,'!'),desc:c.desc}))}catch(e){logger.warn({err:e},'command index unavailable');return[]}})()
 function prune(){const now=Date.now();for(const[token,s]of webSessions)if(s.expiresAt<=now)webSessions.delete(token);for(const[ip,s]of failures)if(now-s.startedAt>10*60*1000)failures.delete(ip)}
 function session(req){prune();const token=cookies(req).architect_session,s=webSessions.get(token);return s&&s.expiresAt>Date.now()?s:null}
 function requireAuth(req,res,csrf=false){const s=session(req);if(!s){json(res,401,{ok:false,error:'Sign in required'});return null}if(csrf&&!safeEqual(req.headers['x-architect-csrf'],s.csrf)){json(res,403,{ok:false,error:'Security token mismatch. Refresh the dashboard.'});return null}return s}
 /*
  * THE PAGE
  * --------
  * The HTML is rendered with a content hash appended to every asset URL
  * (`/dashboard/app.js?v=ab12cd`). A deploy therefore changes the URL, so a
  * browser that cached the previous build cannot keep serving it. This is the
  * belt to the ETag's braces: the ETag handles revalidation, the hash handles
  * a cache entry that was stored under the old `max-age` policy.
  */
 async function page(req,res){
  try{
   let html=await fs.readFile(path.join(PUBLIC,'dashboard.html'),'utf8')
   /* The URL name and the file name differ for the two main assets
      (/dashboard/app.js -> dashboard.js), so map them the same way the
      routes below do. */
   const FILES={'app.js':'dashboard.js','app.css':'dashboard.css','admin.js':'admin.js','admin.css':'admin.css','controls.css':'controls.css'}
   const names=[...new Set([...html.matchAll(/\/dashboard\/([a-z]+\.(?:js|css))/g)].map(m=>m[1]))]
   for(const name of names){
    const file=FILES[name]||name
    const data=await fs.readFile(path.join(PUBLIC,file))
    const v=crypto.createHash('sha1').update(data).digest('hex').slice(0,10)
    html=html.split(`/dashboard/${name}`).join(`/dashboard/${name}?v=${v}`)
   }
   res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'})
   res.end(html)
  }catch{res.writeHead(404).end('Not found')}
 }

 /*
  * STATIC ASSETS
  * -------------
  * These used to be served with `public, max-age=3600` and no validator. After
  * a deploy the browser kept the OLD dashboard.js and admin.js for up to an
  * hour, so a fixed button still looked dead and a redesigned screen still
  * looked like the previous one. That is a large part of why the same
  * complaints kept coming back after each push.
  *
  * Now every asset carries a strong ETag derived from its bytes and is served
  * `no-cache, must-revalidate`: the browser revalidates on each load and gets a
  * cheap 304 when nothing changed, and the new file the moment it does.
  */
 async function asset(req,res,name){
  const file=path.join(PUBLIC,name)
  try{
   const data=await fs.readFile(file)
   const etag='"'+crypto.createHash('sha1').update(data).digest('base64url').slice(0,27)+'"'
   const headers={'content-type':MIME[path.extname(name)]||'application/octet-stream','cache-control':'no-cache, must-revalidate','etag':etag,'x-content-type-options':'nosniff'}
   if(String(req.headers['if-none-match']||'')===etag){res.writeHead(304,headers);res.end();return}
   res.writeHead(200,headers);res.end(data)
  }catch{res.writeHead(404).end('Not found')}
 }
 async function stats(){const d=database();if(!d)return{database:false,registeredUsers:0};try{const q=await d.query('SELECT COUNT(*)::int AS registered_users FROM axyon_players');return{database:true,registeredUsers:q.rows[0]?.registered_users||0}}catch(e){logger.warn({err:e},'Architect dashboard stats failed');return{database:false,registeredUsers:0}}}
 async function handle(req,res){const url=new URL(req.url,'http://localhost');if(!url.pathname.startsWith('/dashboard'))return false;try{
  if(req.method==='GET'&&['/dashboard','/dashboard/'].includes(url.pathname)){await page(req,res);return true}
  if(req.method==='GET'&&url.pathname==='/dashboard/app.css'){await asset(req,res,'dashboard.css');return true}
  if(req.method==='GET'&&url.pathname==='/dashboard/controls.css'){await asset(req,res,'controls.css');return true}
  if(req.method==='GET'&&url.pathname==='/dashboard/app.js'){await asset(req,res,'dashboard.js');return true}
  if(req.method==='GET'&&url.pathname==='/dashboard/admin.js'){await asset(req,res,'admin.js');return true}
  if(req.method==='GET'&&url.pathname==='/dashboard/admin.css'){await asset(req,res,'admin.css');return true}
  if(req.method==='GET'&&url.pathname==='/dashboard/api/admin'){const s=requireAuth(req,res);if(!s)return true;json(res,200,{ok:true,csrf:s.csrf,...await axyonAdmin.snapshot()});return true}
  if(req.method==='POST'&&url.pathname==='/dashboard/api/admin/action'){if(!requireAuth(req,res,true))return true;const input=await body(req,65536);const result=await axyonAdmin.act(String(input.action||''),input);json(res,result.ok?200:400,result);return true}
  if(req.method==='GET'&&url.pathname==='/dashboard/api/commands'){const s=requireAuth(req,res);if(!s)return true;json(res,200,{ok:true,commands:commandIndex});return true}
  if(req.method==='GET'&&url.pathname==='/dashboard/api/session'){const s=session(req);json(res,200,{ok:true,authenticated:!!s,configured:!!password,csrf:s?.csrf||null});return true}
  if(req.method==='POST'&&url.pathname==='/dashboard/api/login'){if(!password){json(res,503,{ok:false,error:'Set DASHBOARD_PASSWORD in Render first.'});return true}const ip=String(req.headers['x-forwarded-for']||req.socket.remoteAddress||'unknown').split(',')[0].trim(),f=failures.get(ip)||{count:0,startedAt:Date.now()};if(f.count>=5&&Date.now()-f.startedAt<10*60*1000){json(res,429,{ok:false,error:'Too many attempts. Try again later.'});return true}const input=await body(req);if(!safeEqual(input.password,password)){f.count++;failures.set(ip,f);json(res,401,{ok:false,error:'Wrong password'});return true}failures.delete(ip);const token=crypto.randomBytes(32).toString('base64url'),csrf=crypto.randomBytes(24).toString('base64url');webSessions.set(token,{csrf,expiresAt:Date.now()+hours*3600000});json(res,200,{ok:true,csrf},{'set-cookie':`architect_session=${token}; Path=/dashboard; HttpOnly; Secure; SameSite=Strict; Max-Age=${hours*3600}`});return true}
  if(req.method==='POST'&&url.pathname==='/dashboard/api/logout'){if(!requireAuth(req,res,true))return true;const token=cookies(req).architect_session;webSessions.delete(token);json(res,200,{ok:true},{'set-cookie':'architect_session=; Path=/dashboard; HttpOnly; Secure; SameSite=Strict; Max-Age=0'});return true}
  if(req.method==='GET'&&url.pathname==='/dashboard/api/overview'){const s=requireAuth(req,res);if(!s)return true;const state=sessions.status(),accounts=state.accounts.map(wa=>({...wa,phone:maskPhone(wa.phone)})),primary=accounts.find(x=>x.sessionId===state.primary?.sessionId)||accounts[0]||{state:'not-paired',phone:'Not available',storage:'unknown',uptimeSec:0,messagesHandled:0};json(res,200,{ok:true,csrf:s.csrf,instance:lease.status(),whatsapp:primary,accounts,accountSummary:{connected:state.connected,total:state.total},stats:await stats()});return true}
  if(req.method==='POST'&&url.pathname.startsWith('/dashboard/api/actions/')){if(!requireAuth(req,res,true))return true;if(!lease.status().owned){json(res,409,{ok:false,error:'This deployment is in standby. Take control first.'});return true}const action=url.pathname.split('/').pop(),input=await body(req)
   if(action==='takeover'){await lease.forceTakeover();json(res,200,{ok:true,message:'Control claimed.'});return true}
   if(action==='reconnect'){await sessions.reconnect(input.sessionId||sessions.status().primary?.sessionId);json(res,200,{ok:true,message:'Reconnect started'});return true}
   if(action==='pause'){const wa=sessions.setPaused(input.sessionId||sessions.status().primary?.sessionId,!!input.paused);json(res,200,{ok:true,paused:wa.paused});return true}
   if(action==='pair'){const result=await sessions.pair(input.phone,input.label||'Architect Instance',input.accountType||'primary');json(res,200,{ok:true,sessionId:result.id,accountType:result.accountType,code:formatPairingCode(result.code)});return true}
   if(action==='remove'){if(input.confirm!=='REMOVE'){json(res,400,{ok:false,error:'Type REMOVE to confirm.'});return true}await sessions.remove(input.sessionId);json(res,200,{ok:true});return true}
   if(action==='remove-all'){if(input.confirm!=='REMOVE ALL'){json(res,400,{ok:false,error:'Type REMOVE ALL to confirm.'});return true}const result=await sessions.resetAll();json(res,200,{ok:true,removed:result.removed,message:'All sessions removed. Pair Architect again.'});return true}
  }
  json(res,404,{ok:false,error:'Dashboard route not found'});return true
 }catch(e){logger.error({err:e,path:url.pathname},'Dashboard request failed');json(res,e.status||500,{ok:false,error:e.status?e.message:'Dashboard request failed'});return true}}
 return{handle,_test:{safeEqual,maskPhone,formatPairingCode}}
}
module.exports={createDashboard,_test:{safeEqual,maskPhone,formatPairingCode}}
