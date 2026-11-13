/*
 * Minimal peer-to-peer WebRTC test app that runs entirely on static hosting.
 *
 * - Presence (who is online) and signaling (offer/answer/ICE exchange) go through
 *   free public MQTT-over-WebSocket brokers. We connect to several at once so that
 *   two people only need ONE broker in common to find each other.
 * - Everything after the handshake (chat, ping, camera/mic) is direct WebRTC
 *   between the browsers (or relayed via TURN if a direct path is impossible).
 */
(() => {
  'use strict';

  // ---------- config ----------
  const params = new URLSearchParams(location.search);
  const ROOM = (params.get('room') || 'lobby').replace(/[^\w-]/g, '').slice(0, 32) || 'lobby';
  const NS = `webrtc-test-8c1f/v1/${ROOM}`;

  const BROKERS = params.getAll('broker').length ? params.getAll('broker') : [   // ?broker=wss://... overrides
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker.hivemq.com:8884/mqtt',
    'wss://test.mosquitto.org:8081',
  ];

  const DEFAULT_ICE = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] },
    {
      // Free public TURN relay (best effort, may be rate limited). Replace with your own if needed.
      urls: [
        'turn:openrelay.metered.ca:80',
        'turn:openrelay.metered.ca:443',
        'turn:openrelay.metered.ca:443?transport=tcp',
        'turns:openrelay.metered.ca:443?transport=tcp',
      ],
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
  ];

  const HEARTBEAT_MS = 15000;
  const EXPIRE_MS = 45000;

  // ---------- helpers ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const rid = (n = 8) => {
    const a = new Uint8Array(n);
    crypto.getRandomValues(a);
    return Array.from(a, (b) => (b % 36).toString(36)).join('');
  };
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };

  const logEl = $('#log');
  function log(...args) {
    const t = new Date().toLocaleTimeString([], { hour12: false });
    const line = args.map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    logEl.textContent += `[${t}] ${line}\n`;
    logEl.scrollTop = logEl.scrollHeight;
    console.log(...args);
  }

  // ---------- country / flag ----------
  const regionNames = (() => { try { return new Intl.DisplayNames([navigator.language || 'en'], { type: 'region' }); } catch { return null; } })();
  const countryName = (cc) => { try { return (cc && regionNames?.of(cc)) || cc || ''; } catch { return cc || ''; } };
  function flagEl(cc) {
    const img = document.createElement('img');
    img.className = 'flag';
    img.alt = cc || '';
    if (cc && /^[A-Z]{2}$/.test(cc)) {
      img.src = `https://flagcdn.com/w40/${cc.toLowerCase()}.png`;
      img.title = countryName(cc);
    } else {
      img.hidden = true;
    }
    return img;
  }
  async function detectCountry() {
    // IP-based lookup = where the browser really connects from (VPN-aware), which is what matters for this test.
    const attempts = [
      async () => (await (await fetch('https://api.country.is/', { cache: 'no-store' })).json()).country,
      async () => /loc=(\w\w)/.exec(await (await fetch('https://www.cloudflare.com/cdn-cgi/trace', { cache: 'no-store' })).text())?.[1],
    ];
    for (const a of attempts) {
      try {
        const cc = String(await a() || '').toUpperCase();
        if (/^[A-Z]{2}$/.test(cc)) return cc;
      } catch { /* try next */ }
    }
    const m = /[-_]([A-Za-z]{2})\b/.exec(navigator.language || '');
    return m ? m[1].toUpperCase() : '';
  }

  // ---------- state ----------
  const myId = rid(8);              // fresh per page load so stale "last will" messages can't clobber us
  let myName = '';
  const myTz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; } })();

  let myCc = '';                    // ISO country code (from IP lookup, falls back to browser locale)
  const users = new Map();          // id -> { id, name, tz, cc, lastSeen }
  const peers = new Map();          // id -> peer
  const clients = [];               // [{ url, client, dot, connected }]
  const seenMsgs = new Set();
  let localStream = null;

  // ---------- join screen ----------
  const nameInput = $('#name');
  nameInput.value = store.get('name') || '';
  $('#join-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const n = nameInput.value.trim();
    if (!n) return;
    store.set('name', n);
    start(n);
  });

  $('#change-name').addEventListener('click', () => {
    const n = (prompt('New name', myName) || '').trim().slice(0, 24);
    if (!n) return;
    myName = n;
    store.set('name', n);
    $('#me-name').textContent = n;
    publishPresence();
  });

  // ---------- ICE settings ----------
  const iceText = $('#ice-json');
  const forceRelay = $('#force-relay');
  iceText.value = store.get('ice') || JSON.stringify(DEFAULT_ICE, null, 2);
  forceRelay.checked = store.get('relay') === '1';
  forceRelay.addEventListener('change', () => store.set('relay', forceRelay.checked ? '1' : '0'));
  $('#ice-save').addEventListener('click', () => {
    try { JSON.parse(iceText.value); store.set('ice', iceText.value); log('ICE servers saved'); }
    catch (e) { alert('Invalid JSON: ' + e.message); }
  });
  $('#ice-reset').addEventListener('click', () => {
    store.del('ice');
    iceText.value = JSON.stringify(DEFAULT_ICE, null, 2);
  });
  function rtcConfig() {
    let iceServers = DEFAULT_ICE;
    try { iceServers = JSON.parse(iceText.value); } catch { /* use default */ }
    return { iceServers, iceTransportPolicy: forceRelay.checked ? 'relay' : 'all' };
  }

  // ---------- start ----------
  function start(name) {
    myName = name;
    $('#join').hidden = true;
    $('#app').hidden = false;
    $('#me-name').textContent = name;
    $('#me-id').textContent = myId;
    log(`I am ${name} (${myId}), room "${ROOM}", tz ${myTz}`);

    if (typeof mqtt === 'undefined') {
      log('ERROR: MQTT library failed to load (CDN blocked?). Signaling unavailable.');
      alert('Could not load the signaling library from the CDN. Check your network / ad-blocker and reload.');
      return;
    }
    BROKERS.forEach(connectBroker);
    detectCountry().then((cc) => {
      myCc = cc;
      log(`my country: ${cc || 'unknown'}`);
      const me = $('#me-flag');
      me.replaceChildren(flagEl(cc));
      me.title = countryName(cc);
      publishPresence();
    });
    setInterval(publishPresence, HEARTBEAT_MS);
    setInterval(expireUsers, 5000);
    addEventListener('pagehide', goodbye);
  }

  // ---------- signaling over MQTT ----------
  const presenceTopic = (id) => `${NS}/presence/${id}`;
  const signalTopic = (id) => `${NS}/signal/${id}`;

  function connectBroker(url) {
    const dot = document.createElement('span');
    dot.className = 'dot wait';
    dot.title = `${url}: connecting…`;
    $('#brokers').appendChild(dot);

    const client = mqtt.connect(url, {
      clientId: `wrt-${myId}-${rid(4)}`,
      clean: true,
      keepalive: 30,
      reconnectPeriod: 4000,
      connectTimeout: 10000,
      will: { topic: presenceTopic(myId), payload: '', retain: true, qos: 0 },
    });
    const entry = { url, client, dot, connected: false };
    clients.push(entry);

    const setState = (cls, text) => { dot.className = `dot ${cls}`; dot.title = `${url}: ${text}`; };

    client.on('connect', () => {
      entry.connected = true;
      setState('ok', 'connected');
      log(`broker connected: ${url}`);
      client.subscribe([`${NS}/presence/+`, signalTopic(myId)], { qos: 0 }, (err) => err && log('subscribe error', err));
      publishPresence();
    });
    client.on('reconnect', () => { entry.connected = false; setState('wait', 'reconnecting…'); });
    client.on('offline', () => { entry.connected = false; setState('bad', 'offline'); });
    client.on('close', () => { entry.connected = false; setState('bad', 'disconnected'); });
    client.on('error', (e) => { log(`broker error ${url}: ${e.message}`); setState('bad', e.message); });
    client.on('message', (topic, payload) => onMqtt(topic, payload.toString()));
  }

  function publishAll(topic, payload, opts) {
    let sent = 0;
    for (const c of clients) {
      if (c.connected) { c.client.publish(topic, payload, opts); sent++; }
    }
    return sent;
  }

  function publishPresence() {
    if (!myName) return;
    publishAll(presenceTopic(myId), JSON.stringify({ id: myId, name: myName, tz: myTz, cc: myCc }), { retain: true, qos: 0 });
  }

  function goodbye() {
    for (const p of peers.values()) send(p.id, 'bye');
    publishAll(presenceTopic(myId), '', { retain: true, qos: 0 });
    clients.forEach((c) => { try { c.client.end(true); } catch { /* ignore */ } });
  }

  function onMqtt(topic, text) {
    if (topic.startsWith(`${NS}/presence/`)) {
      const id = topic.slice(`${NS}/presence/`.length);
      if (id === myId) return;
      if (!text) { users.delete(id); onUserGone(id); renderUsers(); return; }
      try {
        const d = JSON.parse(text);
        const existing = users.get(id);
        users.set(id, { id, name: String(d.name || 'Anonymous').slice(0, 24), tz: d.tz || '', cc: /^[A-Z]{2}$/.test(d.cc) ? d.cc : '', lastSeen: Date.now() });
        if (peers.has(id)) updateCardName(peers.get(id));
        if (!existing || existing.name !== d.name || existing.cc !== (d.cc || '')) renderUsers();
      } catch { /* ignore */ }
    } else if (topic === signalTopic(myId)) {
      try {
        const m = JSON.parse(text);
        if (!m.mid || seenMsgs.has(m.mid)) return;       // same message arrives once per broker
        seenMsgs.add(m.mid);
        if (seenMsgs.size > 500) seenMsgs.delete(seenMsgs.values().next().value);
        onSignal(m);
      } catch (e) { log('bad signal', e); }
    }
  }

  function send(to, type, data) {
    const msg = { mid: rid(12), from: myId, name: myName, type, data };
    const n = publishAll(signalTopic(to), JSON.stringify(msg), { qos: 0 });
    if (!n) log('no broker connected; could not send', type);
  }

  function expireUsers() {
    const now = Date.now();
    let changed = false;
    for (const u of users.values()) {
      if (now - u.lastSeen > EXPIRE_MS) { users.delete(u.id); onUserGone(u.id); changed = true; }
    }
    if (changed) renderUsers();
  }

  function onUserGone(id) {
    const p = peers.get(id);
    // Only tear down if the connection never made it; an established P2P link doesn't need the broker.
    if (p && p.pc.connectionState !== 'connected') closePeer(id, false);
  }

  // ---------- users list ----------
  const usersEl = $('#users');
  function renderUsers() {
    const list = [...users.values()].sort((a, b) => a.name.localeCompare(b.name));
    $('#online-count').textContent = list.length;
    $('#users-empty').hidden = list.length > 0;
    usersEl.replaceChildren(...list.map((u) => {
      const li = document.createElement('li');
      const who = document.createElement('div');
      who.className = 'who';
      const b = document.createElement('b'); b.append(flagEl(u.cc), ' ', u.name);
      const s = document.createElement('small'); s.textContent = [countryName(u.cc), u.tz].filter(Boolean).join(' · ') || 'unknown location';
      who.append(b, s);
      const btn = document.createElement('button');
      btn.dataset.id = u.id;
      const connected = peers.has(u.id);
      btn.textContent = connected ? 'Disconnect' : 'Connect';
      if (!connected) btn.classList.add('primary');
      li.append(who, btn);
      return li;
    }));
  }
  usersEl.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-id]');
    if (!btn) return;
    const id = btn.dataset.id;
    if (peers.has(id)) closePeer(id, true);
    else connectTo(id);
  });

  // ---------- peers (perfect negotiation) ----------
  function connectTo(id) {
    if (peers.has(id)) return;
    log(`connecting to ${nameOf(id)}…`);
    createPeer(id);
  }

  function nameOf(id) { return users.get(id)?.name || id; }

  function createPeer(id, hintName) {
    const pc = new RTCPeerConnection(rtcConfig());
    const p = {
      id, pc,
      hintName,
      polite: myId < id,                // deterministic tie-break when both sides offer at once
      makingOffer: false,
      ignoreOffer: false,
      queue: Promise.resolve(),
      gathered: { host: 0, srflx: 0, relay: 0, prflx: 0 },
      restarted: false,
      sharing: false,
      senders: [],
      timers: [],
    };
    peers.set(id, p);

    // Pre-negotiated data channel: both sides create it with the same id, so there is no "who creates it" race.
    p.dc = pc.createDataChannel('chat', { negotiated: true, id: 0 });
    setupDataChannel(p);

    createCard(p);
    renderUsers();

    pc.onnegotiationneeded = async () => {
      try {
        p.makingOffer = true;
        await pc.setLocalDescription();
        send(id, 'desc', pc.localDescription);
      } catch (e) { log('negotiation error', e); }
      finally { p.makingOffer = false; }
    };

    pc.onicecandidate = ({ candidate }) => {
      if (!candidate) { log(`[${nameOf(id)}] ICE gathering done:`, p.gathered); return; }
      const t = candidate.type || (/ typ (\w+)/.exec(candidate.candidate) || [])[1];
      if (t in p.gathered) p.gathered[t]++;
      setStat(p, 'gathered', gatheredText(p));
      send(id, 'cand', candidate);
    };
    pc.onicecandidateerror = (e) => log(`[${nameOf(id)}] ICE candidate error ${e.errorCode} ${e.url || ''} ${e.errorText || ''}`);

    pc.oniceconnectionstatechange = () => log(`[${nameOf(id)}] ICE: ${pc.iceConnectionState}`);
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      log(`[${nameOf(id)}] connection: ${s}`);
      setState(p, s);
      if (s === 'failed' && !p.restarted) { p.restarted = true; log('restarting ICE'); pc.restartIce(); }
    };

    pc.ontrack = (e) => onRemoteTrack(p, e);

    // stuck-connecting hint
    p.timers.push(setTimeout(() => {
      if (pc.connectionState !== 'connected') {
        addChat(p, 'sys', 'Still not connected after 20s. Try "Force relay" in Network settings, or check the debug log.');
      }
    }, 20000));
    p.timers.push(setInterval(() => pollStats(p), 2000));

    if (localStream && p.wantMedia) addLocalMedia(p);
    return p;
  }

  function closePeer(id, notify) {
    const p = peers.get(id);
    if (!p) return;
    if (notify) send(id, 'bye');
    p.timers.forEach((t) => { clearTimeout(t); clearInterval(t); });
    if (p.sharing) stopSharing(p, false);
    try { p.dc.close(); } catch { /* ignore */ }
    try { p.pc.close(); } catch { /* ignore */ }
    p.el.remove();
    peers.delete(id);
    $('#conns-empty').hidden = peers.size > 0;
    renderUsers();
    log(`closed connection with ${nameOf(id)}`);
  }

  function onSignal(m) {
    let p = peers.get(m.from);
    if (!p) {
      if (m.type !== 'desc') return;   // stray ICE / bye for a connection we don't have
      p = createPeer(m.from, m.name);
      log(`incoming connection from ${m.name || m.from}`);
    }
    p.queue = p.queue.then(() => handleSignal(p, m)).catch((e) => log(`signal error (${m.type})`, e));
  }

  async function handleSignal(p, m) {
    const { pc } = p;
    if (m.type === 'bye') { closePeer(p.id, false); return; }
    if (m.type === 'desc') {
      const desc = m.data;
      const collision = desc.type === 'offer' && (p.makingOffer || pc.signalingState !== 'stable');
      p.ignoreOffer = !p.polite && collision;
      if (p.ignoreOffer) { log(`[${nameOf(p.id)}] ignoring colliding offer (impolite)`); return; }
      await pc.setRemoteDescription(desc);
      if (desc.type === 'offer') {
        await pc.setLocalDescription();
        send(p.id, 'desc', pc.localDescription);
      }
    } else if (m.type === 'cand') {
      try { await pc.addIceCandidate(m.data); }
      catch (e) { if (!p.ignoreOffer) throw e; }
    }
  }

  // ---------- data channel: chat + ping ----------
  function setupDataChannel(p) {
    const dc = p.dc;
    dc.onopen = () => {
      log(`[${nameOf(p.id)}] data channel open`);
      addChat(p, 'sys', 'Data channel open – you are connected peer-to-peer.');
      $('.c-input', p.el).disabled = false;
      $('.chat-form button', p.el).disabled = false;
      $('.c-media', p.el).disabled = false;
      p.timers.push(setInterval(() => { if (dc.readyState === 'open') dc.send(JSON.stringify({ t: 'ping', ts: performance.now() })); }, 2000));
      dc.send(JSON.stringify({ t: 'ping', ts: performance.now() }));
    };
    dc.onclose = () => addChat(p, 'sys', 'Data channel closed.');
    dc.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.t === 'chat') addChat(p, 'them', m.text);
      else if (m.t === 'ping') dc.send(JSON.stringify({ t: 'pong', ts: m.ts }));
      else if (m.t === 'pong') setStat(p, 'ping', `${Math.round(performance.now() - m.ts)} ms`);
    };
  }

  // ---------- stats ----------
  async function pollStats(p) {
    const { pc } = p;
    if (pc.connectionState === 'closed') return;
    let report;
    try { report = await pc.getStats(); } catch { return; }
    let pair;
    const byId = new Map();
    report.forEach((r) => byId.set(r.id, r));
    report.forEach((r) => { if (r.type === 'transport' && r.selectedCandidatePairId) pair = byId.get(r.selectedCandidatePairId); });
    if (!pair) report.forEach((r) => { if (r.type === 'candidate-pair' && (r.selected || (r.nominated && r.state === 'succeeded'))) pair = r; });
    if (!pair) return;
    const l = byId.get(pair.localCandidateId);
    const r = byId.get(pair.remoteCandidateId);
    if (!l || !r) return;
    const relayed = l.candidateType === 'relay' || r.candidateType === 'relay';
    setStat(p, 'path', `${relayed ? 'Relayed (TURN)' : 'Direct (P2P)'}`, relayed ? 'var(--warn)' : 'var(--good)');
    setStat(p, 'proto', `${(l.protocol || '').toUpperCase()} · ${l.candidateType}→${r.candidateType}`);
    const addr = r.address || r.ip;
    setStat(p, 'remote', addr ? `${addr}:${r.port}` : '(hidden mDNS)');
    if (pair.currentRoundTripTime != null) setStat(p, 'ice-rtt', `${Math.round(pair.currentRoundTripTime * 1000)} ms`);
  }

  // ---------- camera / mic ----------
  async function startSharing(p) {
    try {
      if (!localStream) localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    } catch (e) {
      addChat(p, 'sys', `Camera/mic unavailable: ${e.message}`);
      return;
    }
    p.sharing = true;
    p.senders = localStream.getTracks().map((t) => p.pc.addTrack(t, localStream));
    const v = document.createElement('video');
    v.className = 'local'; v.muted = true; v.autoplay = true; v.playsInline = true; v.srcObject = localStream;
    p.localVideo = v;
    $('.media', p.el).prepend(v);
    $('.c-media', p.el).textContent = 'Stop camera & mic';
  }

  function stopSharing(p, renegotiate = true) {
    p.sharing = false;
    if (renegotiate) p.senders.forEach((s) => { try { p.pc.removeTrack(s); } catch { /* ignore */ } });
    p.senders = [];
    p.localVideo?.remove(); p.localVideo = null;
    const btn = $('.c-media', p.el);
    if (btn) btn.textContent = 'Share camera & mic';
    if (localStream && ![...peers.values()].some((q) => q.sharing)) {
      localStream.getTracks().forEach((t) => t.stop());
      localStream = null;
    }
  }

  function onRemoteTrack(p, e) {
    const stream = e.streams[0] || new MediaStream([e.track]);
    let v = p.remoteVideo;
    if (!v) {
      v = document.createElement('video');
      v.autoplay = true; v.playsInline = true;
      p.remoteVideo = v;
      $('.media', p.el).append(v);
    }
    v.srcObject = stream;
    const refresh = () => { v.hidden = !stream.getTracks().some((t) => t.readyState === 'live' && !t.muted); };
    e.track.onmute = refresh; e.track.onunmute = refresh; e.track.onended = refresh;
    refresh();
    addChat(p, 'sys', `Receiving ${e.track.kind}`);
  }

  // ---------- connection cards ----------
  const connsEl = $('#conns');
  const statDefs = [
    ['path', 'Path'], ['proto', 'Transport'], ['remote', 'Remote address'],
    ['ice-rtt', 'ICE RTT'], ['ping', 'Data ping'], ['gathered', 'Local candidates'], ['country', 'Their country'], ['tz', 'Their timezone'],
  ];

  function createCard(p) {
    const el = document.createElement('article');
    el.className = 'card conn';
    el.innerHTML = `
      <div class="conn-head">
        <h2><span class="c-flag"></span><span class="c-name"></span> <span class="state new c-state">new</span></h2>
        <button class="danger c-close">Disconnect</button>
      </div>
      <div class="stats">
        ${statDefs.map(([k, label]) => `<div class="stat"><span>${label}</span><b data-k="${k}">–</b></div>`).join('')}
      </div>
      <div class="chat c-chat"></div>
      <form class="chat-form">
        <input type="text" class="c-input" placeholder="Type a message…" autocomplete="off" disabled>
        <button class="primary" disabled>Send</button>
      </form>
      <div class="conn-actions"><button class="c-media" disabled>Share camera &amp; mic</button></div>
      <div class="media"></div>`;
    p.el = el;
    updateCardName(p);
    setStat(p, 'gathered', gatheredText(p));
    $('.c-close', el).addEventListener('click', () => closePeer(p.id, true));
    $('.chat-form', el).addEventListener('submit', (e) => {
      e.preventDefault();
      const input = $('.c-input', el);
      const text = input.value.trim();
      if (!text || p.dc.readyState !== 'open') return;
      p.dc.send(JSON.stringify({ t: 'chat', text }));
      addChat(p, 'me', text);
      input.value = '';
    });
    $('.c-media', el).addEventListener('click', () => (p.sharing ? stopSharing(p) : startSharing(p)));
    connsEl.appendChild(el);
    $('#conns-empty').hidden = true;
  }

  function updateCardName(p) {
    const u = users.get(p.id);
    $('.c-name', p.el).textContent = u?.name || p.hintName || p.id;
    setStat(p, 'tz', u?.tz || '–');
    setStat(p, 'country', countryName(u?.cc) || '–');
    $('.c-flag', p.el).replaceChildren(flagEl(u?.cc));
  }

  function setState(p, s) {
    const el = $('.c-state', p.el);
    el.textContent = s;
    el.className = `state ${s} c-state`;
  }

  function setStat(p, key, text, color) {
    const el = $(`[data-k="${key}"]`, p.el);
    if (!el) return;
    el.textContent = text;
    el.style.color = color || '';
  }

  const gatheredText = (p) => `host ${p.gathered.host} · srflx ${p.gathered.srflx} · relay ${p.gathered.relay}`;

  function addChat(p, who, text) {
    const box = $('.c-chat', p.el);
    if (!box) return;
    const d = document.createElement('div');
    d.className = `msg ${who}`;
    d.textContent = who === 'me' ? `You: ${text}` : who === 'them' ? `${nameOf(p.id)}: ${text}` : text;
    box.appendChild(d);
    box.scrollTop = box.scrollHeight;
  }

  // Auto-fill the name from storage for convenience on repeat visits.
  if (store.get('name')) nameInput.select();
})();
