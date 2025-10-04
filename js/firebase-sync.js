(function(){
  // Lightweight Firebase Firestore session sync utility
  const F = { enabled:false, app:null, db:null, unsub:null };

  function safeGet(path, obj){
    return path.split('.').reduce((o,k)=> (o && o[k]!==undefined)? o[k] : undefined, obj);
  }

  F.init = function(){
    try{
      const cfg = window.FIREBASE_CONFIG;
      if(!cfg || !window.firebase || !firebase.initializeApp){ return false; }
      // Avoid re-init if already initialized
      if(firebase.apps && firebase.apps.length){
        F.app = firebase.apps[0];
      }else{
        F.app = firebase.initializeApp(cfg);
      }
      F.db = firebase.firestore();
      F.enabled = true;
      return true;
    }catch(e){ console.error('Firebase init failed', e); F.enabled=false; return false; }
  };

  F.sessionRef = function(companyId){
    if(!F.db || !companyId) return null;
    // Use a document path with even number of segments
    return F.db.doc(`companies/${companyId}/session/current`);
  };

  F.subscribeSession = function(companyId, cb){
    if(!F.enabled) return ()=>{};
    const ref = F.sessionRef(companyId); if(!ref) return ()=>{};
    if(F.unsub) try{ F.unsub(); }catch{}
    F.unsub = ref.onSnapshot((snap)=>{
      cb(snap.exists ? snap.data() : null);
    }, (err)=> console.error('Session watch error', err));
    return F.unsub;
  };

  F.setSession = function(companyId, data){
    const ref = F.sessionRef(companyId); if(!ref) return Promise.resolve();
    return ref.set(data || {}, { merge:false });
  };

  F.clearSession = function(companyId){
    const ref = F.sessionRef(companyId); if(!ref) return Promise.resolve();
    return ref.delete().catch(()=>{});
  };

  window.FirebaseSync = F;
})();
