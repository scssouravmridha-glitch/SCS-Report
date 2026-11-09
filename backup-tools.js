/* Backup tools for the current SCS Supabase schema, not the older scs_months schema. */
(function () {
  'use strict';
  const tableNames = ['scs_manual_data','scs_manual_history','scs_orders','scs_attendance','scs_settings'];
  const client = () => { if (!window.__scsBackupClient) throw new Error('Supabase সংযোগ প্রস্তুত নয়'); return window.__scsBackupClient; };
  const unwrap = r => { if (r.error) {if (/Order ID collision/.test(r.error.message||'')) throw new Error('অর্ডারের আইডি অন্য বিদ্যমান অর্ডারের সঙ্গে মিলে গেছে। কোনো পরিবর্তন করা হয়নি; আগে ডাটা ব্যাকআপ নিয়ে সংঘর্ষ নিরসন করুন।');if (r.error.code === 'PGRST202') throw new Error('Supabase-এ ব্যাকআপ ফাংশন নেই। নিচের backup-functions.sql সম্পূর্ণ কপি করে Supabase → SQL Editor-এ Run করুন। পুরোনো SQL আগে চালিয়ে থাকলেও নতুনটি আবার চালাতে হবে।'); throw new Error(r.error.message || String(r.error));} return r.data; };
  function orderMonth(r) {
    const no = String(r.order_no || '').trim().match(/^(20\d{2})(0[1-9]|1[0-2])[-_]/);
    if (no) return no[1] + '-' + no[2];
    const text = String(r.delivery_date_time || r.order_timestamp || '').trim();
    let m = text.match(/(20\d{2})[-/.](\d{1,2})/);
    if (m && +m[2] >= 1 && +m[2] <= 12) return m[1] + '-' + m[2].padStart(2,'0');
    m = text.match(/(\d{1,2})[-/.](\d{1,2})[-/.](20\d{2})/);
    if (m && +m[2] >= 1 && +m[2] <= 12) return m[3] + '-' + m[2].padStart(2,'0');
    const d = new Date(text);
    if (text && !Number.isNaN(d.getTime())) return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0');
    return '';
  }
  async function allMedia() {
    const bucket = client().storage.from('scs-files'), out = [];
    async function walk(prefix) {
      let offset = 0;
      while (true) {
        const entries = unwrap(await bucket.list(prefix, {limit:100,offset,sortBy:{column:'name',order:'asc'}})) || [];
        if (!entries.length) break;
        offset += entries.length;
        for (const entry of entries) {
          const path = prefix ? prefix + '/' + entry.name : entry.name;
          if (!entry.id) { await walk(path); continue; }
          const blob = unwrap(await bucket.download(path));
          const base64 = await new Promise((resolve,reject) => { const r = new FileReader(); r.onload=()=>resolve(String(r.result).split(',')[1]); r.onerror=()=>reject(r.error); r.readAsDataURL(blob); });
          out.push({path, contentType: blob.type || 'application/octet-stream', base64});
        }
      }
    }
    await walk(''); return out;
  }
  async function buildBackup(scope, month, year) {
    if (!['month','year','lifetime'].includes(scope)) throw new Error('অবৈধ ব্যাকআপ স্কোপ');
    if (scope === 'month' && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('বৈধ মাস নির্বাচন করুন');
    if (scope === 'year' && !/^\d{4}$/.test(String(year))) throw new Error('বৈধ বছর লিখুন');
    const tables = unwrap(await client().rpc('scs_export_snapshot'));
    for (const name of tableNames) if (!Array.isArray(tables && tables[name])) throw new Error('ব্যাকআপের ডাটা অসম্পূর্ণ: ' + name);
    let unclassified = 0;
    if (scope !== 'lifetime') {
      const matches = k => k && (scope === 'month' ? k === month : k.slice(0,4) === String(year));
      unclassified = tables.scs_orders.filter(r => !orderMonth(r)).length;
      tables.scs_orders = tables.scs_orders.filter(r => matches(orderMonth(r)));
      for (const name of ['scs_manual_data','scs_manual_history','scs_attendance']) tables[name] = tables[name].filter(r => matches(String(r.month_key || '')));
    }
    const inner={type:'scs-live-backup',version:2,app:'SCS Monthly Report',exportedAt:new Date().toISOString(),scope,scopeValue: scope === 'month' ? month : scope === 'year' ? String(year) : 'all',unclassifiedOrdersExcluded:unclassified,tables,media:await allMedia()};
    return window.ScsLegacyFormat.toLegacy(inner);
  }
  function validate(b) {
    if (window.ScsLegacyFormat.isLegacy(b)) {var x=window.ScsLegacyFormat.inner(b); if (!x) {window.ScsLegacyFormat.normalize(b);return;} b=x;}
    if (!b || b.type !== 'scs-live-backup' || b.version !== 2 || !['month','year','lifetime'].includes(b.scope) || !b.tables || !Array.isArray(b.media)) throw new Error('এটি এই সাইটের বৈধ v2 JSON ব্যাকআপ নয়');
    for (const name of tableNames) if (!Array.isArray(b.tables[name])) throw new Error('ব্যাকআপ অসম্পূর্ণ: ' + name);
    for (const f of b.media) if (!f || typeof f.path !== 'string' || !f.path || f.path.startsWith('/') || f.path.split('/').includes('..') || typeof f.base64 !== 'string') throw new Error('মিডিয়া ফাইলের তথ্য অবৈধ');
  }
  async function restoreBackup(b, progress) {
    validate(b);
    if (window.ScsLegacyFormat.isLegacy(b)) {
      const x=window.ScsLegacyFormat.inner(b);
      if (!x) {if(progress)progress('পুরোনো ব্যাকআপ ইমপোর্ট হচ্ছে…');return unwrap(await client().rpc('scs_import_legacy_backup',{payload:window.ScsLegacyFormat.normalize(b)}));}
      b=x;
    }
    const bucket = client().storage.from('scs-files');
    for (let i=0;i<b.media.length;i++) {
      const f=b.media[i], raw=atob(f.base64), bytes=new Uint8Array(raw.length);
      for (let j=0;j<raw.length;j++) bytes[j]=raw.charCodeAt(j);
      unwrap(await bucket.upload(f.path,new Blob([bytes],{type:f.contentType || 'application/octet-stream'}),{contentType:f.contentType || 'application/octet-stream',upsert:true}));
      if (progress) progress('ফাইল রিস্টোর ' + (i+1) + '/' + b.media.length);
    }
    if (progress) progress('ডাটাবেস রিস্টোর হচ্ছে…');
    const withoutMedia = {...b}; delete withoutMedia.media;
    return unwrap(await client().rpc('scs_restore_snapshot',{backup:withoutMedia}));
  }
  function download(data) {
    const now=new Date(), date=now.toISOString().replace(/[:.]/g,'-');
    const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));
    const a=document.createElement('a'); a.href=url; a.download='scs_backup_'+(data.scope==='all'?'lifetime':data.scsSupabase.scopeValue)+'_'+date+'.json'; document.body.appendChild(a);a.click();a.remove(); setTimeout(()=>URL.revokeObjectURL(url),3000);
  }
  function cardHTML() {
    const now=new Date(), y=now.getFullYear(), m=y+'-'+String(now.getMonth()+1).padStart(2,'0');
    return `<style>#scs-backup-card{margin:16px 0;padding:20px;background:white;border:1px solid #cbd5e1;border-radius:16px;font:14px/1.6 system-ui,sans-serif;color:#13213a;box-shadow:0 1px 4px #0001}#scs-backup-card h2{font-weight:800;font-size:17px;margin:0 0 6px}#scs-backup-card h3{font-weight:700;margin:8px 0}#scs-backup-card .bk-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px}#scs-backup-card section{border:1px solid #dbe4ef;padding:14px;border-radius:12px}#scs-backup-card input[type=month],#scs-backup-card input[type=number],#scs-backup-card input[type=text]{display:block;width:100%;border:1px solid #94a3b8;border-radius:7px;padding:7px;margin:6px 0}#scs-backup-card button{background:#db0074;color:white;border:0;border-radius:8px;padding:9px 12px;cursor:pointer;margin:7px 0;font-weight:700}#scs-backup-card button:disabled{opacity:.5}#scs-backup-card .bk-status{overflow-wrap:anywhere;color:#b42318;white-space:pre-wrap}#scs-backup-card small{font-size:12px;display:block;color:#475569}</style>
    <h2>🗄 JSON ব্যাকআপ, রিস্টোর ও Drive</h2><small style="color:#12623b;font-weight:bold">ফরম্যাট আপডেট: আপনার scs-backup v2 JSON সমর্থিত</small><div style="border:1px solid #93c5fd;background:#eff6ff;padding:12px;border-radius:10px;margin:10px 0"><strong>প্রথমবার সেটআপ প্রয়োজন</strong><small>১. নিচের বাটনে SQL কপি করুন। ২. Supabase Dashboard → SQL Editor → New query-তে পেস্ট করে Run চাপুন। ৩. তারপর নিচে সংযোগ পরীক্ষা করুন। নতুন আপডেটের পর সম্পূর্ণ SQL আবার চালাতে হবে।</small><button id="bk-copy-sql" type="button">সেটআপ SQL দেখুন ও কপি করুন</button> <button id="bk-check-sql" type="button" style="background:#155e75">Supabase সেটআপ পরীক্ষা</button><textarea id="bk-sql-text" readonly hidden aria-label="Supabase setup SQL" style="width:100%;height:150px;padding:8px;border:1px solid #94a3b8;color:#111;background:#fff;font:12px monospace"></textarea><div id="bk-setup-status" class="bk-status"></div></div><small>লাইফটাইম ব্যাকআপে সব মাস, অর্ডার, অ্যাটেনডেন্স, সেটিংস, ইতিহাস ও Storage ফাইল থাকে। আগে আলাদা নিরাপদ কপি রাখুন।</small><div class="bk-grid">
    <section><h3>⬇ JSON এক্সপোর্ট</h3><label><input type="radio" name="bk-scope" value="month"> নির্দিষ্ট মাস</label><input id="bk-month" type="month" value="${m}"><label><input type="radio" name="bk-scope" value="year"> নির্দিষ্ট বছর (সব মাস)</label><input id="bk-year" type="number" min="1900" max="9999" value="${y}"><label><input type="radio" name="bk-scope" value="lifetime" checked> লাইফটাইম (সব ডাটা)</label><br><button id="bk-export">JSON ডাউনলোড</button><small>মাস/বছরের অর্ডার নম্বর বা তারিখ থেকে মাস বোঝা না গেলে সেটি বাদ যাবে; লাইফটাইমে সব অর্ডার থাকে।</small><div class="bk-status" id="bk-export-status"></div></section>
    <section><h3>⬆ JSON রিস্টোর</h3><input id="bk-file" type="file" accept=".json,application/json"><br><button id="bk-restore">ফাইল থেকে রিস্টোর</button><small>লাইফটাইম ফাইল বর্তমান ডাটা প্রতিস্থাপন করবে। মাস/বছর ফাইলের একই আইডির রেকর্ড বদলাবে, অন্য রেকর্ড রেখে দেবে। আগে বর্তমান ব্যাকআপ নিন।</small><div class="bk-status" id="bk-restore-status"></div></section>
    <section><h3>🕐 নির্দিষ্ট সময় পর Drive ব্যাকআপ</h3><input id="bk-folder" type="text" placeholder="Google Drive ফোল্ডারের লিংক বা আইডি"><label>সময় ব্যবধান <select id="bk-interval"><option value="1">প্রতি ১ ঘণ্টা</option><option value="2">প্রতি ২ ঘণ্টা</option><option value="4">প্রতি ৪ ঘণ্টা</option><option value="6">প্রতি ৬ ঘণ্টা</option><option value="12">প্রতি ১২ ঘণ্টা</option><option value="24">প্রতি ২৪ ঘণ্টা</option></select></label><br><button id="bk-folder-save">ফোল্ডার ও সময় সেভ করুন</button><small>ফোল্ডার সেভ করার পর drive-backup.gs Google Apps Script-এ সেট আপ করতে হবে। নির্দিষ্ট সময় আনুমানিক; README দেখুন।</small><div class="bk-status" id="bk-folder-status"></div></section>
    <section><h3>⚠ সম্পূর্ণ ডাটাবেস রিসেট</h3><small>সমস্ত রিপোর্ট, অর্ডার, উপস্থিতি, ইতিহাস ও সেটিংস মুছে যাবে। Storage ফাইল আলাদাভাবে থাকবে। অন্য ডিভাইস বন্ধ করুন। রিসেটের আগে লাইফটাইম ব্যাকআপ ডাউনলোড করে একই ফাইল আবার নির্বাচন করে যাচাই করতে হবে।</small><button id="bk-reset-export">১. লাইফটাইম ব্যাকআপ ডাউনলোড</button><label>২. ডাউনলোড করা JSON ফাইল বেছে যাচাই করুন<input id="bk-reset-file" type="file" accept=".json,application/json"></label><button id="bk-reset-verify">ফাইল যাচাই করুন</button><button id="bk-reset" style="background:#b91c1c" disabled>৩. ডাটাবেস রিসেট</button><div class="bk-status" id="bk-reset-status"></div></section></div>`;
  }
  function inject() {
    const heading=Array.from(document.querySelectorAll('h2')).find(h=>/Permissions, Backup & Reset|পারমিশন নিয়ন্ত্রণ, ব্যাকআপ ও রিসেট/.test(h.textContent));
    const root=heading && heading.parentElement && heading.parentElement.parentElement;
    if (!root || document.getElementById('scs-backup-card')) return;
    const card=document.createElement('div');card.id='scs-backup-card';card.innerHTML=cardHTML();root.appendChild(card);
    const q=id=>card.querySelector('#'+id);
    async function run(button,status,fn) {button.disabled=true;status.textContent='অপেক্ষা করুন…';try {await fn();}catch(e){status.textContent='ব্যর্থ: '+(e.message||e); }finally {if(button.id!=='bk-reset')button.disabled=false;else button.disabled=!verifiedBackup;}}
    q('bk-copy-sql').onclick=()=>run(q('bk-copy-sql'),q('bk-setup-status'),async()=>{const response=await fetch('supabase/backup-functions.sql',{cache:'no-store'});if(!response.ok)throw new Error('SQL ফাইল পাওয়া যায়নি। ZIP-এর supabase/backup-functions.sql খুলুন।');const sql=await response.text();const area=q('bk-sql-text');area.hidden=false;area.value=sql;area.focus();area.select();try{await navigator.clipboard.writeText(sql);q('bk-setup-status').textContent='সম্পূর্ণ SQL কপি হয়েছে। Supabase SQL Editor-এ পেস্ট করে Run চাপুন।';}catch(e){q('bk-setup-status').textContent='SQL নিচে নির্বাচন করা আছে; Ctrl+C দিয়ে কপি করুন, তারপর SQL Editor-এ পেস্ট করে Run চাপুন।';}});
    q('bk-check-sql').onclick=()=>run(q('bk-check-sql'),q('bk-setup-status'),async()=>{const tables=unwrap(await client().rpc('scs_export_snapshot'));for(const n of tableNames)if(!Array.isArray(tables&&tables[n]))throw new Error('সেটআপ অসম্পূর্ণ: '+n);q('bk-setup-status').textContent='✔ ব্যাকআপ ফাংশন পাওয়া গেছে। পুরোনো JSON রিস্টোরের জন্যও অবশ্যই এই নতুন প্যাকেজের সম্পূর্ণ SQL চালান।';});
    q('bk-export').onclick=()=>run(q('bk-export'),q('bk-export-status'),async()=>{const scope=card.querySelector('input[name="bk-scope"]:checked').value;const b=await buildBackup(scope,q('bk-month').value,q('bk-year').value);download(b);q('bk-export-status').textContent='সম্পন্ন। অর্ডার: '+b.scsSupabase.tables.scs_orders.length+(b.scsSupabase.unclassifiedOrdersExcluded?' | মাস বোঝা যায়নি, বাদ: '+b.scsSupabase.unclassifiedOrdersExcluded:'');});
    q('bk-restore').onclick=()=>run(q('bk-restore'),q('bk-restore-status'),async()=>{const file=q('bk-file').files[0];if(!file)throw new Error('একটি JSON ফাইল নির্বাচন করুন');const b=JSON.parse(await file.text());validate(b);const old=window.ScsLegacyFormat.isLegacy(b)&&!window.ScsLegacyFormat.inner(b);if(!confirm(old?'পুরোনো JSON: ফাইলে থাকা মাস ও অ্যাটেনডেন্স প্রতিস্থাপিত এবং অর্ডারগুলো যুক্ত বা আপডেট হবে। ফাইলে নেই এমন Storage ফাইল ও ইতিহাস ফিরবে না। বর্তমান ব্যাকআপ নিয়ে অন্য ডিভাইস বন্ধ করুন। চালিয়ে যাবেন?':'রিস্টোরের ফলে ডাটা প্রতিস্থাপিত হবে। আগে বর্তমান লাইফটাইম ব্যাকআপ নিন এবং অন্য ডিভাইস বন্ধ করুন। চালিয়ে যাবেন?')){q('bk-restore-status').textContent='বাতিল';return;}await restoreBackup(b,msg=>q('bk-restore-status').textContent=msg);q('bk-restore-status').textContent='রিস্টোর সম্পন্ন। এখন সব ডিভাইসে পেজ রিফ্রেশ করুন।';});
    q('bk-folder-save').onclick=()=>run(q('bk-folder-save'),q('bk-folder-status'),async()=>{const raw=q('bk-folder').value.trim(), m=raw.match(/\/folders\/([\w-]+)/)||raw.match(/[?&]id=([\w-]+)/);const id=m?m[1]:raw;if(!/^[\w-]{10,}$/.test(id))throw new Error('বৈধ Drive ফোল্ডার লিংক বা আইডি দিন');const interval=q('bk-interval').value;unwrap(await client().from('scs_settings').upsert([{key:'backup_drive_folder_id',value:id},{key:'backup_interval_hours',value:interval}],{onConflict:'key'}));q('bk-folder-status').textContent='ফোল্ডার ও সময় সেভ হয়েছে। Apps Script সেটআপও সম্পন্ন করুন।';});
    (async()=>{try{const rows=unwrap(await client().from('scs_settings').select('key,value').in('key',['backup_drive_folder_id','backup_interval_hours']));for(const row of rows||[]){if(row.key==='backup_drive_folder_id')q('bk-folder').value=row.value;if(row.key==='backup_interval_hours' && ['1','2','4','6','12','24'].includes(row.value))q('bk-interval').value=row.value;}}catch(e){q('bk-folder-status').textContent=e.message;}})();

    let resetBackup=null, verifiedBackup=null;
    function lockReset() {verifiedBackup=null;q('bk-reset').disabled=true;}
    q('bk-reset-export').onclick=()=>run(q('bk-reset-export'),q('bk-reset-status'),async()=>{lockReset();resetBackup=null;const b=await buildBackup('lifetime');download(b);resetBackup=b;q('bk-reset-file').value='';q('bk-reset-status').textContent='ডাউনলোড শুরু হয়েছে। ফাইলটি সেভ করে নিচে নির্বাচন করে যাচাই করুন।';});
    q('bk-reset-file').onchange=lockReset;
    q('bk-reset-verify').onclick=()=>run(q('bk-reset-verify'),q('bk-reset-status'),async()=>{lockReset();if(!resetBackup)throw new Error('প্রথমে এখান থেকে লাইফটাইম ব্যাকআপ ডাউনলোড করুন');const f=q('bk-reset-file').files[0];if(!f)throw new Error('ডাউনলোড করা JSON ফাইল নির্বাচন করুন');const b=JSON.parse(await f.text());validate(b);if(b.scope!=='all'||!window.ScsLegacyFormat.inner(b)||JSON.stringify(b)!==JSON.stringify(resetBackup))throw new Error('ফাইলটি এইমাত্র তৈরি করা সম্পূর্ণ ব্যাকআপের সঙ্গে মেলে না');const current=unwrap(await client().rpc('scs_export_snapshot'));if(JSON.stringify(current)!==JSON.stringify(b.scsSupabase.tables))throw new Error('ডাটাবেস বদলেছে। আবার লাইফটাইম ব্যাকআপ ডাউনলোড করুন');const files=await allMedia();if(JSON.stringify(files)!==JSON.stringify(b.scsSupabase.media))throw new Error('Storage বদলেছে। আবার লাইফটাইম ব্যাকআপ নিন');verifiedBackup=b;q('bk-reset').disabled=false;q('bk-reset-status').textContent='✔ সেভ করা ফাইল ও বর্তমান ডাটা মিলেছে। চাইলে সতর্কতা পড়ে রিসেট করুন।';});
    async function verifyPin(pin){const row=unwrap(await client().from('scs_settings').select('value').eq('key','admin_pin_hash').maybeSingle());if(!row||!row.value)return pin==='2026';const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode('scs|'+pin));const hex=Array.from(new Uint8Array(digest),x=>x.toString(16).padStart(2,'0')).join('');return hex===row.value;}
    q('bk-reset').onclick=()=>run(q('bk-reset'),q('bk-reset-status'),async()=>{if(!verifiedBackup)throw new Error('লাইফটাইম ব্যাকআপ যাচাই করুন');if(!confirm('সতর্কতা: সব ডাটাবেস টেবিলের রিপোর্ট, অর্ডার, উপস্থিতি, ইতিহাস ও সেটিংস মুছে যাবে। Storage ফাইল থাকবে। অন্যান্য ডিভাইস বন্ধ করেছেন?')){lockReset();q('bk-reset-status').textContent='বাতিল';return;}const pin=prompt('চালিয়ে যেতে অ্যাডমিন PIN লিখুন');if(pin===null){lockReset();q('bk-reset-status').textContent='বাতিল';return;}if(!await verifyPin(pin)){lockReset();throw new Error('অ্যাডমিন PIN সঠিক নয়');}if(prompt('শেষ সতর্কতা: নিশ্চিত করতে RESET লিখুন')!=='RESET'){lockReset();q('bk-reset-status').textContent='রিসেট বাতিল';return;}const files=await allMedia();if(JSON.stringify(files)!==JSON.stringify(verifiedBackup.scsSupabase.media)){lockReset();throw new Error('Storage বদলেছে। আবার লাইফটাইম ব্যাকআপ নিন');}const payload=window.ScsLegacyFormat.inner(verifiedBackup);delete payload.media;unwrap(await client().rpc('scs_reset_after_verified_backup',{expected:payload}));lockReset();q('bk-reset-status').textContent='রিসেট সম্পন্ন। অ্যাপ রিফ্রেশ হচ্ছে।';setTimeout(()=>location.reload(),800);});
  }
  let timer; const obs=new MutationObserver(()=>{clearTimeout(timer);timer=setTimeout(inject,150);});
  function start(){obs.observe(document.body,{childList:true,subtree:true});inject();} if(document.body)start();else document.addEventListener('DOMContentLoaded',start);
  window.__scsLiveBackup={buildBackup,restoreBackup,validate,orderMonth};
})();
