'use strict'
const {database}=require('./auth-store')
let ready=false
// Preserve the original account-table shape for compatibility; Architect clears legacy persona fields.
function defaults(sessionId,primary=false){return{sessionId,label:primary?'Architect':'Architect Instance',mode:'architect',enabled:true}}
async function ensure(){const db=database();if(!db||ready)return;await db.query(`CREATE TABLE IF NOT EXISTS rimuru_wa_accounts(
 session_id TEXT PRIMARY KEY,label TEXT NOT NULL DEFAULT '',mode TEXT NOT NULL DEFAULT 'architect',persona_name TEXT NOT NULL DEFAULT '',
 persona_prompt TEXT NOT NULL DEFAULT '',enabled BOOLEAN NOT NULL DEFAULT TRUE,reply_cooldown_sec INT NOT NULL DEFAULT 30,
 group_mode TEXT NOT NULL DEFAULT 'mentions',muted_chats JSONB NOT NULL DEFAULT '[]'::jsonb,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);ready=true}
function clean(sessionId,input={},primary=false){const base=defaults(sessionId,primary),x={...base,...input,sessionId};return{sessionId,label:String(x.label||base.label).trim().slice(0,50)||base.label,mode:'architect',enabled:x.enabled!==false}}
async function get(sessionId,primary=false){const db=database();if(!db)return defaults(sessionId,primary);await ensure();const r=await db.query('SELECT * FROM rimuru_wa_accounts WHERE session_id=$1',[sessionId]),x=r.rows[0];if(!x)return defaults(sessionId,primary);return clean(sessionId,{label:x.label,enabled:x.enabled},primary)}
async function save(sessionId,patch={},primary=false){const db=database(),x=clean(sessionId,{...(await get(sessionId,primary)),...patch},primary);if(!db)return x;await ensure();await db.query(`INSERT INTO rimuru_wa_accounts(session_id,label,mode,persona_name,persona_prompt,enabled,reply_cooldown_sec,group_mode,muted_chats,updated_at)
 VALUES($1,$2,'architect','','', $3,30,'mentions','[]'::jsonb,NOW()) ON CONFLICT(session_id) DO UPDATE SET label=EXCLUDED.label,mode='architect',persona_name='',persona_prompt='',enabled=EXCLUDED.enabled,updated_at=NOW()`,[sessionId,x.label,x.enabled]);return x}
async function remove(sessionId){const db=database();if(db){await ensure();await db.query('DELETE FROM rimuru_wa_accounts WHERE session_id=$1',[sessionId])}}
module.exports={get,save,remove,ensure,_test:{defaults,clean}}
