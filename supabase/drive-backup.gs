/** SCS current live site: hourly Supabase -> Google Drive JSON backup.
 *  1. Run supabase/backup-functions.sql in Supabase SQL Editor.
 *  2. Save a Google Drive folder link in the app's Admin backup panel.
 *  3. Paste this file into a new Google Apps Script project, save it and run
 *     setupHourlyBackup; grant Drive and external URL access. Check Executions
 *     and the created Drive file. Run backupNow to test; stopHourlyBackup to stop.
 *  The trigger runs on Google's servers, independent of the user's browser.
 */
var SUPABASE_URL = 'https://ddgdjuxrpqpluzegzswj.supabase.co';
var SUPABASE_KEY = 'sb_publishable_9WWNzQgYchAhew7dvtCn3g_NXA9e9gw';
var BACKUP_FOLDER_ID = ''; // Optional fixed ID; otherwise read the app setting.
var BUCKET = 'scs-files';
var TIMEZONE = 'Asia/Dhaka';

function headers_() { return {apikey:SUPABASE_KEY, Authorization:'Bearer '+SUPABASE_KEY}; }
function request_(path, method, payload) {
  var opt={method:method || 'get',headers:headers_(),muteHttpExceptions:true};
  if (payload !== undefined) {opt.contentType='application/json';opt.payload=JSON.stringify(payload);}
  var r=UrlFetchApp.fetch(SUPABASE_URL+path,opt), status=r.getResponseCode();
  if(status<200 || status>=300) throw new Error('Supabase HTTP '+status+' '+path+': '+r.getContentText().slice(0,800));
  return r;
}
function json_(path,method,payload) {return JSON.parse(request_(path,method,payload).getContentText());}
function folderId_() {
  if(BACKUP_FOLDER_ID) return BACKUP_FOLDER_ID;
  var rows=json_('/rest/v1/scs_settings?select=value&key=eq.backup_drive_folder_id');
  if(rows.length!==1 || !rows[0].value) throw new Error('Drive folder not set. Save the folder in Admin first.');
  return rows[0].value;
}
function storagePath_(p) {return p.split('/').map(encodeURIComponent).join('/');}
function readMedia_() {
  var result=[];
  function walk(prefix) {
    var offset=0;
    while(true) {
      var list=json_('/storage/v1/object/list/'+BUCKET,'post',{prefix:prefix,limit:100,offset:offset,sortBy:{column:'name',order:'asc'}});
      if(!list.length) break;
      offset+=list.length;
      list.forEach(function(item){
        var path=prefix ? prefix+'/'+item.name : item.name;
        if(!item.id) {walk(path);return;}
        var blob=request_('/storage/v1/object/public/'+BUCKET+'/'+storagePath_(path)).getBlob();
        result.push({path:path,contentType:blob.getContentType() || 'application/octet-stream',base64:Utilities.base64Encode(blob.getBytes())});
      });
    }
  }
  walk('');return result;
}
function runBackup() {
  var folder=DriveApp.getFolderById(folderId_());
  var tables=json_('/rest/v1/rpc/scs_export_snapshot','post',{});
  ['scs_manual_data','scs_manual_history','scs_orders','scs_attendance','scs_settings'].forEach(function(k){if(!Array.isArray(tables[k]))throw new Error('Missing table data: '+k);});
  var media=readMedia_();
  var now=new Date(), inner={type:'scs-live-backup',version:2,app:'SCS Monthly Report',exportedAt:now.toISOString(),scope:'lifetime',scopeValue:'all',unclassifiedOrdersExcluded:0,tables:tables,media:media};
  var backup=ScsLegacyFormat.toLegacy(inner);
  var name='SCS-Backup_'+Utilities.formatDate(now,TIMEZONE,'yyyy-MM-dd_HH-mm-ss')+'.json';
  folder.createFile(Utilities.newBlob(JSON.stringify(backup,null,2),'application/json',name));
  PropertiesService.getScriptProperties().setProperty('scs_last_backup_ms',String(now.getTime()));
  Logger.log('Created '+name+'; orders='+tables.scs_orders.length+'; media='+media.length);
  return name;
}
// Runs hourly; the saved interval controls whether this tick creates a file.
function scheduledBackup() {
  var lock=LockService.getScriptLock();
  if(!lock.tryLock(1000)) {Logger.log('Previous backup is still running; skipped.');return;}
  try {
    var rows=json_('/rest/v1/scs_settings?select=value&key=eq.backup_interval_hours');
    var hours=rows.length ? Number(rows[0].value) : 1;
    if([1,2,4,6,12,24].indexOf(hours)<0) hours=1;
    var last=Number(PropertiesService.getScriptProperties().getProperty('scs_last_backup_ms') || 0);
    if(last && Date.now()-last < hours*60*60*1000-10000) {Logger.log('Not due; interval '+hours+' hours.');return;}
    return runBackup();
  } finally {lock.releaseLock();}
}
function setupHourlyBackup() {
  ScriptApp.getProjectTriggers().forEach(function(t){if(['runBackup','scheduledBackup'].indexOf(t.getHandlerFunction())>=0)ScriptApp.deleteTrigger(t);});
  ScriptApp.newTrigger('scheduledBackup').timeBased().everyHours(1).create();
  var test=runBackup(); // If test fails, the error is visible in Executions.
  Logger.log('Hourly checking trigger created. Test backup: '+test);
  return test;
}
function backupNow() {return runBackup();}
function stopHourlyBackup(){ScriptApp.getProjectTriggers().forEach(function(t){if(['runBackup','scheduledBackup'].indexOf(t.getHandlerFunction())>=0)ScriptApp.deleteTrigger(t);});Logger.log('Hourly trigger stopped.');}


/* Compatibility with the user's original scs-backup v2 JSON format.
 * The scsSupabase extension contains a lossless snapshot for this version.
 */
(function(root){
  'use strict';
  var names={order_timestamp:'timestamp',order_no:'orderNo',delivery_date_time:'deliveryDateTime',client_or_project_name:'clientOrProjectName',mobile_number:'mobileNumber',address:'address',product_name:'productName',quantity:'quantity',unit:'unit',pack_size:'packSize',unit_price:'unitPrice',discount_unit_price:'discountUnitPrice',total_price:'totalPrice',special_price:'specialPrice',transport_fee:'transportFee',scs_transport_cost:'scsTransportCost',order_by:'orderBy',engineer_commission_per_unit:'engineerCommissionPerUnit',contractor_commission_per_unit:'contractorCommissionPerUnit',commission_holder_name:'commissionHolderName',total_commission:'totalCommission',sms_status:'smsStatus',pdf_status:'pdfStatus'};
  var nums=['quantity','unit_price','discount_unit_price','total_price','special_price','transport_fee','scs_transport_cost','engineer_commission_per_unit','contractor_commission_per_unit','total_commission'];
  var att={sl_no:'slNo',emp_id:'empId',name:'name',designation:'designation',total_present:'totalPresent',total_absent:'totalAbsent',late_days:'lateDays',attendance_rate:'attendanceRate',last_leave_date:'lastLeaveDate'};
  function isObj(x){return x && typeof x==='object' && !Array.isArray(x);}
  function number(value,key){if(value===null||value===undefined||value==='')return 0;var n=Number(value);if(!Number.isFinite(n))throw new Error('অবৈধ সংখ্যার ঘর: '+key);return n;}
  function orderMonth(r){var m=String(r.order_no||'').trim().match(/^(20\d{2})(0[1-9]|1[0-2])[-_]/);if(m)return m[1]+'-'+m[2];var t=String(r.delivery_date_time||r.order_timestamp||'').trim();m=t.match(/(20\d{2})[-/.](\d{1,2})/);if(m&&+m[2]>=1&&+m[2]<=12)return m[1]+'-'+m[2].padStart(2,'0');m=t.match(/(\d{1,2})[-/.](\d{1,2})[-/.](20\d{2})/);if(m&&+m[2]>=1&&+m[2]<=12)return m[3]+'-'+m[2].padStart(2,'0');var d=new Date(t);return t&&!Number.isNaN(d.getTime())?d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0'):'';}
  function toLegacy(inner){
    var tables=inner.tables, months={},settings={},counter={};
    function getMonth(mk){if(!months[mk])months[mk]={monthKey:mk,officeExpenses:0,cashInHand:0,attendances:[],orders:[],collections:[],dues:[],commissions:[],storeProducts:[],transportCosts:[],salaries:[],loans:{}};return months[mk];}
    tables.scs_manual_data.forEach(function(r){if(!isObj(r.data))throw new Error('অবৈধ মাসের ডাটা: '+r.month_key);months[r.month_key]=JSON.parse(JSON.stringify(r.data));months[r.month_key].monthKey=r.month_key;});
    tables.scs_orders.forEach(function(r){var key=orderMonth(r);if(!key)return;var month=getMonth(key), order={sheetRow:r.id};Object.keys(names).forEach(function(k){order[names[k]]=nums.indexOf(k)>=0?Number(r[k]||0):String(r[k]||'');});var no=String(r.order_no||'').trim(), idKey=no?no.toLowerCase():'row'+r.id;counter[idKey]=(counter[idKey]||0)+1;order.id='ord_'+(no||'row'+r.id)+'_'+counter[idKey];if(!Array.isArray(month.orders))month.orders=[];var at=month.orders.findIndex(function(o){return String(o.sheetRow||'')===String(r.id)});if(at>=0)month.orders[at]=order;else month.orders.push(order);});
    var attendanceByMonth={};tables.scs_attendance.forEach(function(r){if(!r.month_key)return;var item={};Object.keys(att).forEach(function(k){item[att[k]]=['sl_no','total_present','total_absent','late_days'].indexOf(k)>=0?Number(r[k]||0):String(r[k]||'');});(attendanceByMonth[r.month_key]||(attendanceByMonth[r.month_key]=[])).push(item);});
    Object.keys(attendanceByMonth).forEach(function(k){getMonth(k).attendances=attendanceByMonth[k];});
    tables.scs_settings.forEach(function(r){settings[r.key]=r.value;});
    return {app:'SCS Monthly Report',format:'scs-backup',version:2,scope:inner.scope==='lifetime'?'all':inner.scope,exportedAt:inner.exportedAt,months:months,settings:settings,scsSupabase:{version:1,scope:inner.scope,scopeValue:inner.scopeValue,unclassifiedOrdersExcluded:inner.unclassifiedOrdersExcluded||0,tables:tables,media:inner.media}};
  }
  function isLegacy(b){return isObj(b)&&b.format==='scs-backup'&&b.version===2&&isObj(b.months)&&isObj(b.settings);}
  function inner(b){if(!isLegacy(b)||!isObj(b.scsSupabase))return null;var x=b.scsSupabase;if(x.version!==1)throw new Error('অসমর্থিত Supabase ব্যাকআপ সংস্করণ');return {type:'scs-live-backup',version:2,app:b.app,exportedAt:b.exportedAt,scope:x.scope,scopeValue:x.scopeValue,unclassifiedOrdersExcluded:x.unclassifiedOrdersExcluded||0,tables:x.tables,media:x.media};}
  function normalize(b){
    if(!isLegacy(b))throw new Error('বৈধ scs-backup JSON ফাইল নয়');
    var rows=[],attendance=[],seen={};
    Object.keys(b.months).sort().forEach(function(mk){
      var v=b.months[mk];if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(mk)||!isObj(v))throw new Error('অবৈধ মাস: '+mk);
      if(v.orders!==undefined&&!Array.isArray(v.orders))throw new Error('অবৈধ অর্ডার তালিকা: '+mk);
      if(v.attendances!==undefined&&!Array.isArray(v.attendances))throw new Error('অবৈধ অ্যাটেনডেন্স তালিকা: '+mk);
      (v.orders||[]).forEach(function(o){if(!isObj(o))throw new Error('অবৈধ অর্ডার: '+mk);var id=Number(o.sheetRow);if(!Number.isSafeInteger(id)||id<=0)throw new Error('অর্ডারের sheetRow আইডি নেই বা অবৈধ: '+mk);if(seen[id])throw new Error('একই অর্ডার আইডি একাধিকবার আছে: '+id);seen[id]=true;var r={id:id};Object.keys(names).forEach(function(k){var val=o[names[k]];r[k]=nums.indexOf(k)>=0?number(val,names[k]):String(val===undefined||val===null?'':val);});rows.push(r);});
      (v.attendances||[]).forEach(function(a){if(!isObj(a))throw new Error('অবৈধ অ্যাটেনডেন্স: '+mk);var r={month_key:mk};Object.keys(att).forEach(function(k){var v=a[att[k]];r[k]=['sl_no','total_present','total_absent','late_days'].indexOf(k)>=0?number(v,att[k]):String(v===undefined||v===null?'':v);});attendance.push(r);});
    });
    return {format:'scs-legacy-import',version:1,months:b.months,settings:b.settings,orders:rows,attendance:attendance};
  }
  root.ScsLegacyFormat={toLegacy:toLegacy,isLegacy:isLegacy,inner:inner,normalize:normalize,orderMonth:orderMonth};
})(typeof window!=='undefined'?window:globalThis);
