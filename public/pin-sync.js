
(function() {
  function getServerBase() {
    try {
      if (typeof AUTO_SERVER_URL !== 'undefined' && AUTO_SERVER_URL && !AUTO_SERVER_URL.includes('claude.ai'))
        return AUTO_SERVER_URL;
    } catch(e){}
    try { return localStorage.getItem('bibliothek_server_url') || 'https://bibliothek-server-1.onrender.com'; } catch(e){}
    return 'https://bibliothek-server-1.onrender.com';
  }
  function getPinFromStorage() { try { return localStorage.getItem('bibliothek_pin'); } catch(e){return null;} }
  function savePinToStorage(pin) { try { localStorage.setItem('bibliothek_pin', pin); } catch(e){} }

  window._pinSyncKey = null;
  window._pinSyncTimer = null;

  async function pinSyncLoad(pin) {
    try {
      const r = await fetch(getServerBase() + '/library/' + encodeURIComponent(pin));
      const d = await r.json();
      if (d.ok && d.books && d.books.length > 0) {
        const localMap = new Map((window.books||[]).map(b=>[String(b.id),b]));
        const remoteMap = new Map(d.books.map(b=>[String(b.id),b]));
        const allIds = new Set([...localMap.keys(),...remoteMap.keys()]);
        const merged=[];
        for(const id of allIds){
          const lo=localMap.get(id),re=remoteMap.get(id);
          if(!lo){merged.push(re);continue;}
          if(!re){merged.push(lo);continue;}
          merged.push((lo.added||0)>=(re.added||0)?lo:re);
        }
        window.books = merged;
        if(typeof saveBooks==='function') await saveBooks();
        if(typeof render==='function') render();
        return merged.length;
      }
    } catch(e){}
    return 0;
  }

  async function pinSyncSave(pin) {
    try {
      const slim=(window.books||[]).map(b=>{const o={...b};delete o.fileData;return o;});
      await fetch(getServerBase()+'/library/'+encodeURIComponent(pin),{
        method:'PUT',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({books:slim})
      });
    } catch(e){}
  }

  window.schedulePinSync = function() {
    if(!window._pinSyncKey) return;
    clearTimeout(window._pinSyncTimer);
    window._pinSyncTimer = setTimeout(()=>pinSyncSave(window._pinSyncKey), 2000);
  };

  // Patch saveBooks
  window.addEventListener('load', ()=>{
    if(typeof saveBooks==='function'){
      const orig = saveBooks;
      window.saveBooks = async function(){
        await orig();
        window.schedulePinSync();
      };
    }
    // Auto-connect
    const saved = getPinFromStorage();
    if(saved){
      window._pinSyncKey = saved;
      pinSyncLoad(saved).then(n=>{
        if(n>0 && typeof showToast==='function') showToast('✓ '+n+' bøker synket fra server');
        updatePinBtn();
      });
    }
    addPinButton();
  });

  function updatePinBtn() {
    const btn=document.getElementById('pinSyncBtn');
    if(!btn) return;
    if(window._pinSyncKey){btn.textContent='🔄 PIN-synk aktiv';btn.style.color='#5bb578';btn.style.borderColor='#5bb578';}
    else{btn.textContent='🔒 Koble til med PIN';btn.style.color='';btn.style.borderColor='';}
  }

  function addPinButton() {
    const sbb = document.querySelector('.sidebar-bottom');
    if(!sbb || document.getElementById('pinSyncBtn')) return;
    const wrap = document.createElement('div');
    wrap.style.cssText='padding-top:8px;border-top:1px solid var(--border);';
    wrap.innerHTML='<button id="pinSyncBtn" onclick="openPinModal()" style="width:100%;padding:9px;background:transparent;border:1px solid var(--border2);color:var(--muted);font-family:Outfit,sans-serif;font-size:12px;border-radius:8px;cursor:pointer;transition:all 0.15s;">🔒 Koble til med PIN</button>';
    sbb.insertBefore(wrap, sbb.firstChild);
    updatePinBtn();
  }

  window.openPinModal = function() {
    if(document.getElementById('pinOverlay')) return;
    const existing = getPinFromStorage();
    const ov=document.createElement('div');
    ov.id='pinOverlay';
    ov.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,0.88);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(8px);';
    ov.innerHTML=`<div style="background:#1a1a20;border:1px solid #3d3b38;border-radius:16px;padding:28px;max-width:340px;width:100%;font-family:Outfit,sans-serif;">
      <h3 style="color:#c8a96e;margin-bottom:6px;font-size:20px;font-family:'Cormorant Garamond',serif;font-weight:700;">📚 Bibliothek Sync</h3>
      <p style="color:#6e6b65;font-size:13px;margin-bottom:20px;line-height:1.5;">Skriv inn en PIN-kode for å synke biblioteket mellom alle enheter automatisk.</p>
      <label style="font-size:11px;color:#6e6b65;text-transform:uppercase;letter-spacing:0.1em;display:block;margin-bottom:6px;">PIN-kode (4+ siffer)</label>
      <input id="pinInput" type="password" inputmode="numeric" placeholder="f.eks. 1234"
        style="width:100%;padding:12px;background:#0a0a0c;border:1px solid #3d3b38;border-radius:8px;color:#edeae4;font-size:20px;letter-spacing:0.4em;text-align:center;outline:none;box-sizing:border-box;margin-bottom:16px;"
        onkeydown="if(event.key==='Enter')window.submitPin()">
      ${existing?'<p style=\"font-size:11px;color:#5bb578;margin-bottom:12px;\">✓ Du har en lagret PIN</p>':''}
      <div style="display:flex;gap:10px;">
        <button onclick="document.getElementById('pinOverlay').remove()" style="flex:1;padding:11px;background:transparent;border:1px solid #3d3b38;color:#6e6b65;border-radius:8px;cursor:pointer;font-size:13px;">Avbryt</button>
        <button onclick="window.submitPin()" style="flex:2;padding:11px;background:#c8a96e;border:none;color:#0a0a0c;border-radius:8px;cursor:pointer;font-size:13px;font-weight:600;">Koble til</button>
      </div>
      ${existing?'<button onclick=\"document.getElementById(\'pinInput\').value=getPinFromStorage();window.submitPin()\" style=\"width:100%;margin-top:8px;padding:9px;background:transparent;border:1px solid #5bb578;color:#5bb578;border-radius:8px;cursor:pointer;font-size:12px;\">Bruk lagret PIN: '+existing.replace(/./g,'•')+'</button>':''}
    </div>`;
    document.body.appendChild(ov);
    setTimeout(()=>{const i=document.getElementById('pinInput');if(i){if(existing)i.value=existing;i.focus();}},100);
  };

  window.submitPin = async function() {
    const inp=document.getElementById('pinInput');
    const pin=(inp?.value||'').trim();
    if(!pin||pin.length<4){if(inp){inp.style.borderColor='#e05555';inp.focus();}return;}
    window._pinSyncKey=pin;
    savePinToStorage(pin);
    document.getElementById('pinOverlay')?.remove();
    const n=await pinSyncLoad(pin);
    if(typeof showToast==='function') showToast(n>0?'✓ '+n+' bøker hentet fra server!':'✓ PIN aktivert – synker automatisk');
    updatePinBtn();
  };

  window.getPinFromStorage = getPinFromStorage;
})();
