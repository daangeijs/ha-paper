// Minimal setup page served when the full web console (emulator/dist-device-ui → www.bin, partition `www`) is not in
// flash. Covers first install only: Wi-Fi (SoftAP), HA sign-in (OAuth or long-lived token), status.
#pragma once

namespace x4::net {

static const char kFallbackPage[] = R"HTML(<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>HA Paper setup</title>
<style>
:root{--fg:#1d1d1f;--bg:#f6f5f2;--card:#fff;--mut:#6f6c66;--err:#b3261e;--ok:#1e6b35}
@media (prefers-color-scheme:dark){:root{--fg:#ecebe7;--bg:#18181a;--card:#232326;--mut:#a8a59e}}
*{box-sizing:border-box}body{margin:0;font:16px/1.45 system-ui,sans-serif;background:var(--bg);color:var(--fg)}
main{max-width:520px;margin:0 auto;padding:24px 16px}h1{font-size:22px;margin:0 0 4px}
.card{background:var(--card);border:1px solid #d3d0c8;border-radius:12px;padding:16px;margin:16px 0}
.mut{color:var(--mut);font-size:14px}button,input,select{font:inherit;padding:10px 12px;border-radius:8px;border:1px solid #bdb9b0;width:100%;margin-top:8px}
button{background:var(--fg);color:var(--bg);border:0;cursor:pointer}button:disabled{opacity:.5}
.net{display:flex;justify-content:space-between;padding:8px;border-bottom:1px solid #e3e0d9;cursor:pointer}.net.sel{font-weight:600}
.err{color:var(--err)}.ok{color:var(--ok)}details{margin-top:12px}
</style></head><body><main>
<h1>HA Paper</h1><div class="mut" id="sub">Loading…</div>
<div class="card" id="wifi" hidden><b>1 · Wi-Fi</b><div class="mut">Pick your 2.4 GHz network.</div>
<div id="nets"></div><button id="scan" type="button">Scan again</button>
<input id="pw" type="password" placeholder="Password" autocomplete="current-password">
<button id="join" type="button">Connect</button><div id="wmsg" class="err"></div></div>
<div class="card" id="ha" hidden><b>2 · Home Assistant</b><div class="mut" id="hatext">Sign in once: it links the display.</div>
<input id="haurl" placeholder="http://homeassistant.local:8123">
<button id="signin" type="button">Sign in with Home Assistant</button><div id="hmsg" class="err"></div>
<details><summary class="mut">Use a long-lived access token instead</summary>
<input id="llat" placeholder="Long-lived access token"><button id="llbtn" type="button">Link with token</button></details></div>
<div class="card" id="done" hidden><b>Linked</b><div class="mut" id="donetext"></div>
<div class="mut">This is the minimal built-in page: the full web console (screen editor, API keys, updates) is not on this display. To add it, flash a release with its <code>x4flash.py</code>, or run <code>make flash</code> from a checkout with Node installed (it writes the web console image too). Your Wi-Fi and Home Assistant link stay. The REST API at <code>/api/v1</code> works meanwhile.</div>
<button id="out" type="button">Sign out</button></div>
</main><script>
const $=id=>document.getElementById(id);let sel=null,st=null;const host=()=>'http://'+((st&&st.hostname)||location.host);
async function api(m,p,b){const r=await fetch('/api/v1'+p,{method:m,headers:b?{'Content-Type':'application/json'}:{},body:b?JSON.stringify(b):undefined,credentials:'same-origin'});
let j={};try{j=await r.json()}catch(e){}if(!r.ok)throw Object.assign(new Error(j.error||('HTTP '+r.status)),{status:r.status,body:j});return j}
async function load(){try{st=await api('GET','/console/state')}catch(e){$('sub').textContent='Display not reachable';return}
// wire names (spec/openapi.yaml ConsoleState) → the names used below
st.ha=st.home_assistant;st.softAp=st.softap;st.session.signedIn=st.session.signed_in;
const wifiOk=!!st.wifi.connected;$('sub').textContent='Firmware '+st.firmware+(st.ip?' · '+st.ip:'')+(wifiOk?' · on '+st.wifi.connected:'');
$('wifi').hidden=wifiOk&&!st.softAp?true:false;if(st.softAp&&wifiOk){$('wmsg').className='ok';$('wmsg').textContent='Connected to '+st.wifi.connected+'. Rejoin your home Wi-Fi and open '+host();}
$('ha').hidden=!wifiOk||st.ha.linked&&st.session.signedIn;$('done').hidden=!(st.ha.linked&&st.session.signedIn);
if(st.ha.linked&&!st.session.signedIn)$('hatext').textContent='Linked to '+(st.ha.server||'Home Assistant')+'. Sign in to manage the display.';
if(st.ha.server&&!$('haurl').value)$('haurl').value=st.ha.server;$('haurl').hidden=st.ha.linked;
$('donetext').textContent='Signed in as '+st.session.user+' · '+st.ha.server;
$('nets').innerHTML='';(st.networks||[]).forEach(n=>{const d=document.createElement('div');d.className='net'+(sel===n.ssid?' sel':'');
d.textContent=n.ssid+(n.secure?' 🔒':'');const s=document.createElement('span');s.className='mut';s.textContent=n.rssi+' dBm';d.appendChild(s);
d.onclick=()=>{sel=n.ssid;load()};$('nets').appendChild(d)});
const q=new URLSearchParams(location.search);if(q.get('auth_error'))$('hmsg').textContent='Sign-in failed ('+q.get('auth_error')+'). Try again.';}
$('scan').onclick=async()=>{await api('POST','/wifi/scan').catch(()=>{});setTimeout(load,4000)};
$('join').onclick=async()=>{if(!sel){$('wmsg').textContent='Pick a network';return}$('join').disabled=true;$('wmsg').className='mut';$('wmsg').textContent='Connecting…';
try{await api('POST','/wifi',{ssid:sel,password:$('pw').value});$('wmsg').className='ok';$('wmsg').textContent='Connected. Continue at '+host();}
catch(e){$('wmsg').className='err';$('wmsg').textContent=e.status?e.message:'Connection dropped — if the display joined your Wi-Fi, continue at '+host();}
$('join').disabled=false;load()};
$('signin').onclick=async()=>{$('hmsg').textContent='';try{const r=await api('POST','/auth/ha/start',{ha_url:$('haurl').value||undefined});location.href=r.authorize_url}catch(e){$('hmsg').textContent=e.message}};
$('llbtn').onclick=async()=>{try{await api('POST','/ha/token',{url:$('haurl').value,token:$('llat').value});load()}catch(e){$('hmsg').textContent=e.message}};
$('out').onclick=async()=>{await api('POST','/auth/signout').catch(()=>{});load()};
load();setInterval(load,5000);
</script></body></html>)HTML";

}  // namespace x4::net
