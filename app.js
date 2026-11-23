const { ipcRenderer } = require('electron');

// --- CONEXION A TU SUPABASE ---
const SUPABASE_PROJECT_ID = 'bblaejiorwjwhknvywii';
const SUPABASE_URL = 'https://' + SUPABASE_PROJECT_ID + '.supabase.co';
const SUPABASE_KEY = 'sb_publishable_dAQvOJUlugbH2Nrd1MCnFg_Lh2vWnIY';
const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// --- ESTADO GLOBAL ---
let currentUser = null;
let contacts = [];
let groups = [];
let chatHistory = {};

let activeChatId = null;
let activeChatType = 'contact';
let sidebarTab = 'chats';
let regCustomAvatarDataUrl = null;

// PeerJS (Videollamadas HD y archivos hasta 100 GB)
let peer = null;
let peerConnections = new Map();
let currentMediaCall = null;
let pendingIncomingCall = null;
let localStream = null;
let isMicMuted = false;
let isCamOff = false;

// Grabacion de notas
let voiceRecorder = null;
let voiceChunks = [];
let isRecordingVoice = false;

let videoNoteStream = null;
let videoNoteRecorder = null;
let videoNoteChunks = [];
let isRecordingVideoNote = false;

// Menus contextuales
let selectedMsgId = null;
let selectedContactId = null;

// 3 en Raya
let tttBoard = Array(9).fill('');
let tttMySymbol = 'X';
let tttTurn = 'X';

// --- INICIALIZACION Y MEMORIA DE SESION / TEMA ---
window.addEventListener('DOMContentLoaded', async () => {
  const savedTheme = localStorage.getItem('pcg_theme_pref') || 'dark';
  applyTheme(savedTheme);

  const savedSession = localStorage.getItem('pcg_v2_session');
  if (savedSession) {
    try {
      const parsed = JSON.parse(savedSession);
      const { data: userRow } = await db
        .from('pcg_users')
        .select('*')
        .eq('id', parsed.id)
        .eq('password', parsed.password)
        .single();

      if (userRow) {
        currentUser = userRow;
        applyTheme(currentUser.theme || savedTheme);
        await enterApp();
      }
    } catch (e) {}
  }

  document.addEventListener('click', () => {
    document.getElementById('msg-context-menu').style.display = 'none';
    document.getElementById('contact-context-menu').style.display = 'none';
  });

  ipcRenderer.on('window-restored', () => {
    applyTheme(currentUser?.theme || localStorage.getItem('pcg_theme_pref') || 'dark');
  });

  setInterval(updateCapsuleCountdowns, 1000);
});

// --- TEMA CLARO / OSCURO ---
function applyTheme(theme) {
  const isLight = theme === 'light';
  document.body.classList.toggle('light-theme', isLight);
  localStorage.setItem('pcg_theme_pref', isLight ? 'light' : 'dark');
  ipcRenderer.send('update-titlebar-theme', isLight ? 'light' : 'dark');
}

function previewThemeChoice() {
  const val = document.getElementById('set-theme').value;
  applyTheme(val);
}

// --- PANTALLAS DE INICIAR SESION Y REGISTRO ---
function switchAuthMode(mode) {
  document.getElementById('login-box').style.display = mode === 'login' ? 'block' : 'none';
  document.getElementById('register-box').style.display = mode === 'register' ? 'block' : 'none';
}

function selectRegAvatar(el) {
  regCustomAvatarDataUrl = null;
  document.querySelectorAll('#reg-avatar-grid .avatar-choice').forEach(c => c.classList.remove('selected'));
  el.classList.add('selected');
}

async function pickRegCustomAvatar() {
  const res = await ipcRenderer.invoke('pick-media-dataurl', [{ name: 'Imágenes', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]);
  if (res) {
    regCustomAvatarDataUrl = res.dataUrl;
    document.querySelectorAll('#reg-avatar-grid .avatar-choice').forEach(c => c.classList.remove('selected'));
    alert('Foto cargada correctamente para tu perfil.');
  }
}

function formatRawId(raw9) {
  return `${raw9.slice(0, 3)}-${raw9.slice(3, 6)}-${raw9.slice(6, 9)}`;
}

async function generateUniqueCloudId() {
  for (let i = 0; i < 15; i++) {
    const num = Math.floor(100000000 + Math.random() * 900000000).toString();
    const candidate = formatRawId(num);
    const { data } = await db.from('pcg_users').select('id').eq('id', candidate).maybeSingle();
    if (!data) return candidate;
  }
  return formatRawId(Date.now().toString().slice(-9));
}

async function registerAccount() {
  const username = document.getElementById('reg-user').value.trim();
  const password = document.getElementById('reg-pass').value.trim();
  if (!username || !password) {
    alert('Escribe tu nombre visible y una contraseña.');
    return;
  }

  const selectedEl = document.querySelector('#reg-avatar-grid .avatar-choice.selected');
  const avatar = regCustomAvatarDataUrl || (selectedEl ? selectedEl.dataset.avatar : 'assets/predeterminado.png');
  const newId = await generateUniqueCloudId();
  const currentTheme = localStorage.getItem('pcg_theme_pref') || 'dark';

  const newUser = {
    id: newId,
    username,
    password,
    avatar,
    bio: '¡Hola! Estoy usando PCG Chat',
    status: 'online',
    theme: currentTheme,
    call_tone: 'assets/cadence.mp3',
    msg_tone: 'assets/pluck.mp3'
  };

  const { error } = await db.from('pcg_users').insert(newUser);
  if (error) {
    alert('Error al crear cuenta en Supabase: ' + error.message);
    return;
  }

  currentUser = newUser;
  localStorage.setItem('pcg_v2_session', JSON.stringify({ id: currentUser.id, password: currentUser.password }));
  alert(`¡Cuenta creada con éxito!\n\nTu ID única es: ${newId}\nGuárdala para iniciar sesión o compartirla con tus amigos.`);
  await enterApp();
}

async function loginAccount() {
  const username = document.getElementById('login-user').value.trim();
  const password = document.getElementById('login-pass').value.trim();
  const rawId = document.getElementById('login-id').value.trim().replace(/[^0-9]/g, '');

  if (!username || !password || rawId.length !== 9) {
    alert('Ingresa tu nombre, tu contraseña y tu ID de 9 dígitos.');
    return;
  }

  const formattedId = formatRawId(rawId);
  const { data: userRow, error } = await db
    .from('pcg_users')
    .select('*')
    .eq('id', formattedId)
    .eq('password', password)
    .maybeSingle();

  if (error || !userRow || userRow.username.toLowerCase() !== username.toLowerCase()) {
    alert('Datos incorrectos. Verifica tu nombre, contraseña y tu ID de 9 dígitos.');
    return;
  }

  currentUser = userRow;
  currentUser.status = 'online';
  await db.from('pcg_users').update({ status: 'online' }).eq('id', currentUser.id);

  localStorage.setItem('pcg_v2_session', JSON.stringify({ id: currentUser.id, password: currentUser.password }));
  applyTheme(currentUser.theme || 'dark');
  await enterApp();
}

async function logoutAccount() {
  if (!confirm('¿Cerrar sesión? Podrás volver a entrar cuando quieras con tu nombre, contraseña e ID.')) return;
  if (currentUser) {
    await db.from('pcg_users').update({ status: 'offline' }).eq('id', currentUser.id);
  }
  if (peer) peer.destroy();
  db.removeAllChannels();
  localStorage.removeItem('pcg_v2_session');
  currentUser = null;
  document.getElementById('app-screen').style.display = 'none';
  document.getElementById('auth-screen').style.display = 'flex';
}

async function enterApp() {
  document.getElementById('auth-screen').style.display = 'none';
  document.getElementById('app-screen').style.display = 'flex';

  refreshTopProfileUI();
  await loadCloudData();
  renderSidebar();
  initRealtimeAndP2P();
  ipcRenderer.send('refocus-window');
}

function refreshTopProfileUI() {
  document.getElementById('my-top-avatar').src = currentUser.avatar || 'assets/predeterminado.png';
  document.getElementById('my-top-name').textContent = currentUser.username;
  document.getElementById('my-top-id').textContent = currentUser.id;
  document.getElementById('my-personal-msg').value = currentUser.bio || '';
  document.getElementById('my-status-select').value = currentUser.status || 'online';

  const dot = document.getElementById('my-top-status-dot');
  dot.className = 'status-dot status-' + (currentUser.status || 'online');
}

function copyMyId() {
  navigator.clipboard.writeText(currentUser.id);
  const badge = document.getElementById('my-top-id');
  const old = badge.textContent;
  badge.textContent = '¡Copiado!';
  setTimeout(() => { badge.textContent = old; }, 1200);
}

async function updatePersonalMessage() {
  currentUser.bio = document.getElementById('my-personal-msg').value.trim();
  await db.from('pcg_users').update({ bio: currentUser.bio }).eq('id', currentUser.id);
}

async function changeMyStatus() {
  currentUser.status = document.getElementById('my-status-select').value;
  refreshTopProfileUI();
  await db.from('pcg_users').update({ status: currentUser.status }).eq('id', currentUser.id);
}

// --- CARGAR CONTACTOS, GRUPOS Y MENSAJES DESDE SUPABASE ---
function makePairKey(id1, id2) {
  return [id1, id2].sort().join('_');
}

async function loadCloudData() {
  const { data: rels } = await db.from('pcg_contacts').select('*').eq('owner_id', currentUser.id);
  contacts = [];
  if (rels && rels.length > 0) {
    const friendIds = rels.map(r => r.friend_id);
    const { data: profiles } = await db.from('pcg_users').select('*').in('id', friendIds);
    rels.forEach(r => {
      const p = (profiles || []).find(item => item.id === r.friend_id);
      if (p) {
        contacts.push({
          id: p.id,
          name: p.username,
          alias: r.alias || '',
          avatar: p.avatar || 'assets/predeterminado.png',
          bio: p.bio || '',
          status: p.status || 'offline',
          blocked: !!r.blocked,
          unread: 0
        });
      }
    });
  }

  const { data: allGroups } = await db.from('pcg_groups').select('*');
  groups = (allGroups || [])
    .filter(g => Array.isArray(g.members) && g.members.includes(currentUser.id))
    .map(g => ({ id: g.id, name: g.name, members: g.members, unread: 0 }));

  const { data: msgs } = await db
    .from('pcg_messages')
    .select('*')
    .order('created_at', { ascending: true })
    .limit(500);

  chatHistory = {};
  (msgs || []).forEach(m => {
    if (Array.isArray(m.deleted_by) && m.deleted_by.includes(currentUser.id)) return;
    let targetChatId = null;
    if (m.is_group) {
      if (groups.find(g => g.id === m.chat_key)) targetChatId = m.chat_key;
    } else if (m.chat_key.includes(currentUser.id)) {
      const parts = m.chat_key.split('_');
      targetChatId = parts[0] === currentUser.id ? parts[1] : parts[0];
    }

    if (targetChatId) {
      if (!chatHistory[targetChatId]) chatHistory[targetChatId] = [];
      chatHistory[targetChatId].push(mapDbMsgToLocal(m));
    }
  });
}

function mapDbMsgToLocal(m) {
  return {
    id: m.id,
    senderId: m.sender_id,
    senderName: m.sender_name,
    senderAvatar: m.sender_avatar || 'assets/predeterminado.png',
    type: m.msg_type || 'text',
    text: m.text || '',
    mediaUrl: m.media_url || '',
    unlockAt: Number(m.unlock_at || 0),
    opened: !!m.opened,
    time: new Date(m.created_at || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    status: m.status || 'sent',
    reactions: m.reactions || {}
  };
}

// --- SUPABASE REALTIME + PEERJS HD ---
function initRealtimeAndP2P() {
  const pill = document.getElementById('connection-pill');
  pill.textContent = '● En línea (Supabase Realtime)';
  pill.style.color = '#22c55e';

  db.channel('pcg-realtime-hub')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'pcg_users' }, (payload) => {
      const updated = payload.new;
      if (!updated) return;
      const c = contacts.find(item => item.id === updated.id);
      if (c) {
        const wasOffline = c.status === 'offline';
        c.name = updated.username;
        c.avatar = updated.avatar || 'assets/predeterminado.png';
        c.bio = updated.bio || '';
        c.status = updated.status || 'offline';
        renderSidebar();
        if (activeChatId === c.id) updateChatHeader();

        if (wasOffline && c.status === 'online' && !c.blocked && currentUser.status !== 'busy') {
          playSound(currentUser.msg_tone, false);
          ipcRenderer.send('show-notification', {
            title: 'Amigo conectado',
            body: `${c.alias || c.name} está en línea 🟢`
          });
        }
      }
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'pcg_messages' }, async (payload) => {
      const m = payload.new;
      if (!m) return;
      if (Array.isArray(m.deleted_by) && m.deleted_by.includes(currentUser.id)) return;

      let targetChatId = null;
      if (m.is_group) {
        if (groups.find(g => g.id === m.chat_key)) targetChatId = m.chat_key;
      } else if (m.chat_key.includes(currentUser.id)) {
        const parts = m.chat_key.split('_');
        targetChatId = parts[0] === currentUser.id ? parts[1] : parts[0];
      }
      if (!targetChatId) return;

      if (!m.is_group && m.sender_id !== currentUser.id && !contacts.find(c => c.id === m.sender_id)) {
        await db.from('pcg_contacts').upsert({ owner_id: currentUser.id, friend_id: m.sender_id });
        await loadCloudData();
        renderSidebar();
      }

      if (!chatHistory[targetChatId]) chatHistory[targetChatId] = [];
      const existingIdx = chatHistory[targetChatId].findIndex(item => item.id === m.id);
      const mapped = mapDbMsgToLocal(m);

      if (existingIdx >= 0) {
        chatHistory[targetChatId][existingIdx] = mapped;
      } else {
        chatHistory[targetChatId].push(mapped);
        if (m.sender_id !== currentUser.id) {
          if (activeChatId === targetChatId) {
            await db.from('pcg_messages').update({ status: 'read' }).eq('id', m.id);
          } else {
            incrementUnread(targetChatId, m.is_group);
          }
          if (currentUser.status !== 'busy') {
            playSound(currentUser.msg_tone, false);
            ipcRenderer.send('show-notification', {
              title: m.sender_name,
              body: m.msg_type === 'capsule' ? '⏳ Envió una Cápsula del Tiempo' : (m.text || '📎 Archivo multimedia')
            });
          }
        }
      }

      if (activeChatId === targetChatId) renderMessages();
    })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'pcg_groups' }, (payload) => {
      const g = payload.new;
      if (g && Array.isArray(g.members) && g.members.includes(currentUser.id)) {
        if (!groups.find(item => item.id === g.id)) {
          groups.push({ id: g.id, name: g.name, members: g.members, unread: 0 });
          renderSidebar();
        }
      }
    })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'pcg_signals' }, (payload) => {
      const sig = payload.new;
      if (!sig || sig.target_id !== currentUser.id) return;
      handleRealtimeSignal(sig);
    })
    .subscribe();

  const myPeerId = 'pcgchat-' + currentUser.id.replace(/-/g, '');
  peer = new Peer(myPeerId, {
    config: {
      iceServers: [
        { urls: 'stun:://google.com' },
        { urls: 'stun:://google.com' }
      ]
    }
  });

  peer.on('connection', (conn) => setupDataConnection(conn));

  peer.on('call', (call) => {
    const callerId = formatRawId(call.peer.replace('pcgchat-', ''));
    const contact = contacts.find(c => c.id === callerId);
    if ((contact && contact.blocked) || currentUser.status === 'busy' || currentUser.status === 'offline') {
      call.close();
      return;
    }

    pendingIncomingCall = call;
    document.getElementById('incoming-caller-name').textContent = contact ? (contact.alias || contact.name) : callerId;
    document.getElementById('incoming-caller-avatar').src = contact ? contact.avatar : 'assets/predeterminado.png';
    document.getElementById('incoming-caller-type').textContent = (call.metadata && call.metadata.video) ? 'Videollamada HD entrante...' : 'Llamada de voz HD entrante...';
    openModal('modal-incoming-call');
    playSound(currentUser.call_tone, true);
    ipcRenderer.send('show-notification', {
      title: 'Llamada entrante - PCG Chat',
      body: `${contact ? (contact.alias || contact.name) : callerId} te está llamando`
    });
  });
}

// --- BUSQUEDA DE CONTACTOS EN SUPABASE ---
async function searchAndAddContact() {
  const input = document.getElementById('search-id-input');
  const raw = input.value.trim().replace(/[^0-9]/g, '');
  if (raw.length !== 9) {
    alert('Escribe una ID válida de 9 dígitos (Ej: 482-910-357).');
    return;
  }

  const formattedId = formatRawId(raw);
  if (formattedId === currentUser.id) {
    alert('No puedes agregarte a ti mismo.');
    return;
  }

  const existing = contacts.find(c => c.id === formattedId);
  if (existing) {
    input.value = '';
    selectChat(formattedId, 'contact');
    return;
  }

  const { data: friendProfile, error } = await db
    .from('pcg_users')
    .select('*')
    .eq('id', formattedId)
    .maybeSingle();

  if (error || !friendProfile) {
    alert('No se encontró ningún usuario con esa ID. Verifica los 9 dígitos.');
    return;
  }

  await db.from('pcg_contacts').upsert({
    owner_id: currentUser.id,
    friend_id: friendProfile.id,
    alias: '',
    blocked: false
  });

  contacts.push({
    id: friendProfile.id,
    name: friendProfile.username,
    alias: '',
    avatar: friendProfile.avatar || 'assets/predeterminado.png',
    bio: friendProfile.bio || '',
    status: friendProfile.status || 'offline',
    blocked: false,
    unread: 0
  });

  input.value = '';
  renderSidebar();
  selectChat(friendProfile.id, 'contact');
}

// --- SENALES EN TIEMPO REAL (ABRE VENTANAS Y 3 EN RAYA) ---
function handleRealtimeSignal(sig) {
  const contact = contacts.find(c => c.id === sig.from_id);
  if (contact && contact.blocked) return;

  if (sig.signal_type === 'abre-ventanas') {
    if (currentUser.status === 'online') {
      playSound('assets/abre_ventanas.mp3', false);
      ipcRenderer.send('abre-ventanas');
      ipcRenderer.send('show-notification', {
        title: '🪟 ¡Abre Ventanas!',
        body: `${sig.from_name} te está llamando la atención`
      });
    }
    return;
  }

  if (sig.signal_type === 'ttt-move') {
    tttBoard = sig.payload.board;
    tttTurn = sig.payload.nextTurn;
    tttMySymbol = sig.payload.receiverSymbol || 'O';
    openModal('modal-ttt');
    renderTicTacToe();
    return;
  }

  if (sig.signal_type === 'ttt-reset') {
    tttBoard = Array(9).fill('');
    tttMySymbol = 'O';
    tttTurn = 'X';
    openModal('modal-ttt');
    renderTicTacToe();
  }
}

async function triggerAbreVentanas() {
  if (!activeChatId) return;
  const targets = getActiveTargetIds();
  for (const targetId of targets) {
    await db.from('pcg_signals').insert({
      target_id: targetId,
      from_id: currentUser.id,
      from_name: currentUser.username,
      signal_type: 'abre-ventanas',
      payload: {}
    });
  }
  playSound('assets/abre_ventanas.mp3', false);
}

// --- SIDEBAR Y SELECCION DE CHAT ---
function switchSidebarTab(tab) {
  sidebarTab = tab;
  document.getElementById('tab-chats').className = tab === 'chats' ? 'btn-fluent btn-primary' : 'btn-fluent';
  document.getElementById('tab-groups').className = tab === 'groups' ? 'btn-fluent btn-primary' : 'btn-fluent';
  document.getElementById('add-contact-bar').style.display = tab === 'chats' ? 'flex' : 'none';
  renderSidebar();
}

function renderSidebar() {
  const listEl = document.getElementById('sidebar-list');
  listEl.innerHTML = '';

  if (sidebarTab === 'chats') {
    if (contacts.length === 0) {
      listEl.innerHTML = '<p style="font-size:12px; color:var(--text-secondary); text-align:center; margin-top:20px;">Aún no tienes contactos. Escribe la ID de un amigo arriba para buscarlo.</p>';
      return;
    }
    contacts.forEach(c => {
      const card = document.createElement('div');
      card.className = 'contact-card' + (activeChatId === c.id && activeChatType === 'contact' ? ' active' : '');
      card.onclick = () => selectChat(c.id, 'contact');
      card.oncontextmenu = (e) => {
        e.preventDefault();
        selectedContactId = c.id;
        const menu = document.getElementById('contact-context-menu');
        document.getElementById('ctx-block-btn').textContent = c.blocked ? '✅ Desbloquear contacto' : '🚫 Bloquear contacto';
        menu.style.left = e.pageX + 'px';
        menu.style.top = e.pageY + 'px';
        menu.style.display = 'flex';
      };

      const displayName = c.alias || c.name;
      const subText = c.blocked ? '🚫 Bloqueado' : (c.bio || c.id);
      card.innerHTML = `
        <div class="avatar-ring-wrap">
          <img src="${c.avatar}" alt="${displayName}">
          <span class="status-dot status-${c.status || 'offline'}"></span>
        </div>
        <div class="contact-meta">
          <div class="contact-title-line">
            <span>${escapeHtml(displayName)}</span>
            ${c.unread > 0 ? `<span class="unread-badge">${c.unread}</span>` : ''}
          </div>
          <div class="contact-sub">${escapeHtml(subText)}</div>
        </div>
      `;
      listEl.appendChild(card);
    });
  } else {
    if (groups.length === 0) {
      listEl.innerHTML = '<p style="font-size:12px; color:var(--text-secondary); text-align:center; margin-top:20px;">No tienes grupos aún. Crea uno arriba en "Nuevo Grupo".</p>';
      return;
    }
    groups.forEach(g => {
      const card = document.createElement('div');
      card.className = 'contact-card' + (activeChatId === g.id && activeChatType === 'group' ? ' active' : '');
      card.onclick = () => selectChat(g.id, 'group');
      card.innerHTML = `
        <div class="avatar-ring-wrap">
          <img src="assets/planeta.png" alt="Grupo">
        </div>
        <div class="contact-meta">
          <div class="contact-title-line">
            <span>👥 ${escapeHtml(g.name)}</span>
            ${g.unread > 0 ? `<span class="unread-badge">${g.unread}</span>` : ''}
          </div>
          <div class="contact-sub">${g.members.length} miembros</div>
        </div>
      `;
      listEl.appendChild(card);
    });
  }
}

async function selectChat(id, type) {
  activeChatId = id;
  activeChatType = type;

  if (type === 'contact') {
    const c = contacts.find(item => item.id === id);
    if (c) c.unread = 0;
    const chatKey = makePairKey(currentUser.id, id);
    await db.from('pcg_messages').update({ status: 'read' }).eq('chat_key', chatKey).neq('sender_id', currentUser.id);
  } else {
    const g = groups.find(item => item.id === id);
    if (g) g.unread = 0;
  }

  renderSidebar();
  updateChatHeader();
  document.getElementById('chat-tools').style.display = 'flex';
  document.getElementById('chat-composer').style.display = 'flex';
  renderMessages();
}

function updateChatHeader() {
  if (!activeChatId) return;
  if (activeChatType === 'contact') {
    const c = contacts.find(item => item.id === activeChatId);
    if (!c) return;
    document.getElementById('chat-header-avatar').src = c.avatar;
    document.getElementById('chat-header-name').textContent = c.alias ? `${c.alias} (${c.name})` : c.name;
    document.getElementById('chat-header-sub').textContent = `${statusLabel(c.status)} • ${c.bio || c.id}`;
  } else {
    const g = groups.find(item => item.id === activeChatId);
    if (!g) return;
    document.getElementById('chat-header-avatar').src = 'assets/planeta.png';
    document.getElementById('chat-header-name').textContent = g.name;
    document.getElementById('chat-header-sub').textContent = `Grupo (${g.members.length} participantes)`;
  }
}

// --- MENSAJES, REACCIONES Y CAPSULA DEL TIEMPO ---
async function sendTextMessage() {
  const input = document.getElementById('msg-input');
  const text = input.value.trim();
  if (!text || !activeChatId) return;

  if (activeChatType === 'contact') {
    const c = contacts.find(item => item.id === activeChatId);
    if (c && c.blocked) {
      alert('Desbloquea a este contacto antes de enviarle mensajes.');
      return;
    }
  }

  input.value = '';
  const msgId = 'msg_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
  const isGroup = activeChatType === 'group';
  const chatKey = isGroup ? activeChatId : makePairKey(currentUser.id, activeChatId);

  const dbRow = {
    id: msgId,
    chat_key: chatKey,
    is_group: isGroup,
    sender_id: currentUser.id,
    sender_name: currentUser.username,
    sender_avatar: currentUser.avatar,
    msg_type: 'text',
    text,
    status: 'sent',
    reactions: {}
  };

  if (!chatHistory[activeChatId]) chatHistory[activeChatId] = [];
  chatHistory[activeChatId].push(mapDbMsgToLocal({ ...dbRow, created_at: new Date().toISOString() }));
  renderMessages();

  await db.from('pcg_messages').insert(dbRow);
}

function openCapsuleModal() {
  if (!activeChatId) return;
  document.getElementById('capsule-text').value = '';
  openModal('modal-capsule');
}

async function sendTimeCapsule() {
  const text = document.getElementById('capsule-text').value.trim();
  const delaySec = parseInt(document.getElementById('capsule-delay').value, 10);
  if (!text || !activeChatId) return;

  const msgId = 'cap_' + Date.now();
  const unlockAt = Date.now() + delaySec * 1000;
  const isGroup = activeChatType === 'group';
  const chatKey = isGroup ? activeChatId : makePairKey(currentUser.id, activeChatId);

  const dbRow = {
    id: msgId,
    chat_key: chatKey,
    is_group: isGroup,
    sender_id: currentUser.id,
    sender_name: currentUser.username,
    sender_avatar: currentUser.avatar,
    msg_type: 'capsule',
    text,
    unlock_at: unlockAt,
    opened: false,
    status: 'sent',
    reactions: {}
  };

  closeModal('modal-capsule');
  if (!chatHistory[activeChatId]) chatHistory[activeChatId] = [];
  chatHistory[activeChatId].push(mapDbMsgToLocal({ ...dbRow, created_at: new Date().toISOString() }));
  renderMessages();

  await db.from('pcg_messages').insert(dbRow);
}

async function openCapsuleMessage(msgId) {
  const list = chatHistory[activeChatId] || [];
  const msg = list.find(m => m.id === msgId);
  if (!msg || Date.now() < msg.unlockAt) return;
  msg.opened = true;
  playSound('assets/capsula.mp3', false);
  renderMessages();
  await db.from('pcg_messages').update({ opened: true }).eq('id', msgId);
}

function updateCapsuleCountdowns() {
  if (!activeChatId) return;
  document.querySelectorAll('[data-capsule-unlock]').forEach(el => {
    const unlockAt = parseInt(el.dataset.capsuleUnlock, 10);
    const left = Math.ceil((unlockAt - Date.now()) / 1000);
    el.textContent = left > 0 ? `🔒 Se abre en ${left}s` : '🔓 ¡Lista! Haz clic para abrir';
  });
}

function renderMessages() {
  const feed = document.getElementById('messages-feed');
  feed.innerHTML = '';
  const list = chatHistory[activeChatId] || [];

  list.forEach(msg => {
    const isMine = msg.senderId === currentUser.id;
    const row = document.createElement('div');
    row.className = 'msg-row' + (isMine ? ' mine' : '');

    let bodyHtml = '';
    if (msg.type === 'text') {
      bodyHtml = `<div>${escapeHtml(msg.text)}</div>`;
    } else if (msg.type === 'audio') {
      bodyHtml = `<audio controls src="${msg.mediaUrl}" style="height:32px; max-width:220px;"></audio>`;
    } else if (msg.type === 'videonote') {
      bodyHtml = `<video controls src="${msg.mediaUrl}" style="width:170px; height:170px; border-radius:50%; object-fit:cover;"></video>`;
    } else if (msg.type === 'file') {
      bodyHtml = `<div>${escapeHtml(msg.text)}</div>`;
    } else if (msg.type === 'capsule') {
      const canOpen = Date.now() >= msg.unlockAt;
      if (msg.opened) {
        bodyHtml = `<div class="capsule-card"><strong>🔓 Cápsula Abierta:</strong><span>${escapeHtml(msg.text)}</span></div>`;
      } else {
        bodyHtml = `
          <div class="capsule-card" style="cursor:pointer;" onclick="openCapsuleMessage('${msg.id}')">
            <strong>⏳ Cápsula del Tiempo</strong>
            <span data-capsule-unlock="${msg.unlockAt}">${canOpen ? '🔓 ¡Lista! Haz clic para abrir' : '🔒 Esperando tiempo...'}</span>
          </div>
        `;
      }
    }

    const reactionsArr = msg.reactions ? Object.values(msg.reactions) : [];
    const reactionsHtml = reactionsArr.length > 0
      ? `<div class="msg-reactions">${reactionsArr.map(r => `<span class="reaction-pill">${r}</span>`).join('')}</div>`
      : '';

    const ticks = isMine ? (msg.status === 'read' ? '✓✓' : '✓') : '';

    row.innerHTML = `
      <img class="msg-pic" src="${msg.senderAvatar || 'assets/predeterminado.png'}">
      <div class="msg-bubble">
        ${!isMine && activeChatType === 'group' ? `<div class="msg-sender-name">${escapeHtml(msg.senderName)}</div>` : ''}
        ${bodyHtml}
        ${reactionsHtml}
        <div class="msg-footer">
          <span>${msg.time}</span>
          <span>${ticks}</span>
        </div>
      </div>
    `;

    row.oncontextmenu = (e) => {
      e.preventDefault();
      selectedMsgId = msg.id;
      const menu = document.getElementById('msg-context-menu');
      document.getElementById('ctx-delete-everyone').style.display = isMine ? 'block' : 'none';
      menu.style.left = e.pageX + 'px';
      menu.style.top = e.pageY + 'px';
      menu.style.display = 'flex';
    };

    feed.appendChild(row);
  });

  feed.scrollTop = feed.scrollHeight;
}

async function reactToSelectedMsg(emoji) {
  if (!selectedMsgId || !activeChatId) return;
  const list = chatHistory[activeChatId] || [];
  const msg = list.find(m => m.id === selectedMsgId);
  if (!msg) return;
  if (!msg.reactions) msg.reactions = {};
  msg.reactions[currentUser.id] = emoji;
  renderMessages();
  await db.from('pcg_messages').update({ reactions: msg.reactions }).eq('id', selectedMsgId);
}

function openEmojiForReaction() {
  openWindowsEmojiPanel();
}

async function deleteMsgForMe() {
  if (!selectedMsgId || !activeChatId) return;
  const targetId = selectedMsgId;
  chatHistory[activeChatId] = (chatHistory[activeChatId] || []).filter(m => m.id !== targetId);
  renderMessages();

  const { data } = await db.from('pcg_messages').select('deleted_by').eq('id', targetId).maybeSingle();
  const arr = Array.isArray(data?.deleted_by) ? data.deleted_by : [];
  if (!arr.includes(currentUser.id)) arr.push(currentUser.id);
  await db.from('pcg_messages').update({ deleted_by: arr }).eq('id', targetId);
}

async function deleteMsgForEveryone() {
  if (!selectedMsgId || !activeChatId) return;
  const targetId = selectedMsgId;
  const list = chatHistory[activeChatId] || [];
  const msg = list.find(m => m.id === targetId);
  if (msg) {
    msg.text = '🚫 Este mensaje fue eliminado';
    msg.type = 'text';
    msg.mediaUrl = '';
    renderMessages();
    await db.from('pcg_messages').update({
      text: '🚫 Este mensaje fue eliminado',
      msg_type: 'text',
      media_url: ''
    }).eq('id', targetId);
  }
}

// --- NOTAS DE VOZ Y VIDEO ---
async function toggleVoiceNote() {
  if (!activeChatId) return;
  const btn = document.getElementById('btn-voice-note');

  if (!isRecordingVoice) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      voiceRecorder = new MediaRecorder(stream);
      voiceChunks = [];
      voiceRecorder.ondataavailable = e => voiceChunks.push(e.data);
      voiceRecorder.onstop = () => {
        const blob = new Blob(voiceChunks, { type: 'audio/webm' });
        const reader = new FileReader();
        reader.onloadend = async () => {
          const msgId = 'aud_' + Date.now();
          const isGroup = activeChatType === 'group';
          const chatKey = isGroup ? activeChatId : makePairKey(currentUser.id, activeChatId);
          const dbRow = {
            id: msgId,
            chat_key: chatKey,
            is_group: isGroup,
            sender_id: currentUser.id,
            sender_name: currentUser.username,
            sender_avatar: currentUser.avatar,
            msg_type: 'audio',
            media_url: reader.result,
            status: 'sent',
            reactions: {}
          };
          if (!chatHistory[activeChatId]) chatHistory[activeChatId] = [];
          chatHistory[activeChatId].push(mapDbMsgToLocal({ ...dbRow, created_at: new Date().toISOString() }));
          renderMessages();
          await db.from('pcg_messages').insert(dbRow);
        };
        reader.readAsDataURL(blob);
        stream.getTracks().forEach(t => t.stop());
      };
      voiceRecorder.start();
      isRecordingVoice = true;
      btn.textContent = '⏹️';
      btn.classList.add('btn-danger');
    } catch (e) {
      alert('No se pudo acceder al micrófono. Revisa los permisos de Windows.');
    }
  } else {
    voiceRecorder.stop();
    isRecordingVoice = false;
    btn.textContent = '🎤';
    btn.classList.remove('btn-danger');
  }
}

async function openVideoNoteModal() {
  if (!activeChatId) return;
  try {
    videoNoteStream = await navigator.mediaDevices.getUserMedia({
      video: { width: 480, height: 480 },
      audio: true
    });
    document.getElementById('video-note-preview').srcObject = videoNoteStream;
    openModal('modal-video-note');
  } catch (e) {
    alert('No se pudo acceder a la cámara. Revisa los permisos de Windows.');
  }
}

function closeVideoNoteModal() {
  if (videoNoteStream) {
    videoNoteStream.getTracks().forEach(t => t.stop());
    videoNoteStream = null;
  }
  isRecordingVideoNote = false;
  document.getElementById('btn-record-vnote').textContent = '● Grabar';
  closeModal('modal-video-note');
}

function toggleRecordVideoNote() {
  const btn = document.getElementById('btn-record-vnote');
  if (!isRecordingVideoNote) {
    videoNoteChunks = [];
    videoNoteRecorder = new MediaRecorder(videoNoteStream);
    videoNoteRecorder.ondataavailable = e => videoNoteChunks.push(e.data);
    videoNoteRecorder.onstop = () => {
      const blob = new Blob(videoNoteChunks, { type: 'video/webm' });
      const reader = new FileReader();
      reader.onloadend = async () => {
        const msgId = 'vid_' + Date.now();
        const isGroup = activeChatType === 'group';
        const chatKey = isGroup ? activeChatId : makePairKey(currentUser.id, activeChatId);
        const dbRow = {
          id: msgId,
          chat_key: chatKey,
          is_group: isGroup,
          sender_id: currentUser.id,
          sender_name: currentUser.username,
          sender_avatar: currentUser.avatar,
          msg_type: 'videonote',
          media_url: reader.result,
          status: 'sent',
          reactions: {}
        };
        if (!chatHistory[activeChatId]) chatHistory[activeChatId] = [];
        chatHistory[activeChatId].push(mapDbMsgToLocal({ ...dbRow, created_at: new Date().toISOString() }));
        renderMessages();
        await db.from('pcg_messages').insert(dbRow);
      };
      reader.readAsDataURL(blob);
      closeVideoNoteModal();
    };
    videoNoteRecorder.start();
    isRecordingVideoNote = true;
    btn.textContent = '⏹️ Enviar Nota de Video';
  } else {
    videoNoteRecorder.stop();
  }
}

// --- VIDEOLLAMADAS HD Y ARCHIVOS HASTA 100 GB (PEERJS DIRECTO) ---
function setupDataConnection(conn) {
  const friendId = formatRawId(conn.peer.replace('pcgchat-', ''));
  conn.on('open', () => peerConnections.set(friendId, conn));
  conn.on('data', async (packet) => {
    if (packet.type === 'file-start') {
      await ipcRenderer.invoke('file-write-start', { transferId: packet.transferId, fileName: packet.fileName });
      const chatId = packet.groupId || friendId;
      if (!chatHistory[chatId]) chatHistory[chatId] = [];
      chatHistory[chatId].push({
        id: packet.transferId,
        senderId: friendId,
        senderName: packet.senderName,
        senderAvatar: packet.senderAvatar,
        type: 'file',
        text: `📥 Recibiendo: ${packet.fileName} (${formatBytes(packet.fileSize)})...`,
        time: getNowTime(),
        status: 'read',
        reactions: {}
      });
      if (activeChatId === chatId) renderMessages();
    } else if (packet.type === 'file-chunk') {
      await ipcRenderer.invoke('file-write-chunk', { transferId: packet.transferId, chunkBuffer: packet.chunk });
    } else if (packet.type === 'file-end') {
      await ipcRenderer.invoke('file-write-end', { transferId: packet.transferId });
      const chatId = packet.groupId || friendId;
      const msg = (chatHistory[chatId] || []).find(m => m.id === packet.transferId);
      if (msg) {
        msg.text = `✅ Archivo guardado en Descargas`;
        if (activeChatId === chatId) renderMessages();
      }
      playSound(currentUser.msg_tone, false);
    }
  });
  conn.on('close', () => peerConnections.delete(friendId));
}

function sendPacketToPeer(targetId, packet) {
  let conn = peerConnections.get(targetId);
  if (conn && conn.open) {
    conn.send(packet);
  } else if (peer) {
    conn = peer.connect('pcgchat-' + targetId.replace(/-/g, ''), { reliable: true });
    setupDataConnection(conn);
    conn.on('open', () => conn.send(packet));
  }
}

async function sendLargeFile() {
  if (!activeChatId) return;
  const fileInfo = await ipcRenderer.invoke('pick-file');
  if (!fileInfo) return;

  const MAX_100_GB = 100 * 1024 * 1024 * 1024;
  if (fileInfo.size > MAX_100_GB) {
    alert('El archivo supera el límite máximo de 100 GB.');
    return;
  }

  const targets = getActiveTargetIds();
  const transferId = 'file_' + Date.now();
  if (!chatHistory[activeChatId]) chatHistory[activeChatId] = [];
  chatHistory[activeChatId].push({
    id: transferId,
    senderId: currentUser.id,
    senderName: currentUser.username,
    senderAvatar: currentUser.avatar,
    type: 'file',
    text: `📤 Enviando: ${fileInfo.name} (${formatBytes(fileInfo.size)})...`,
    time: getNowTime(),
    status: 'sent',
    reactions: {}
  });
  renderMessages();

  for (const targetId of targets) {
    sendPacketToPeer(targetId, {
      type: 'file-start',
      transferId,
      fileName: fileInfo.name,
      fileSize: fileInfo.size,
      senderName: currentUser.username,
      senderAvatar: currentUser.avatar,
      groupId: activeChatType === 'group' ? activeChatId : null
    });

    const CHUNK_SIZE = 256 * 1024;
    let offset = 0;
    while (offset < fileInfo.size) {
      const chunk = await ipcRenderer.invoke('file-read-chunk', {
        filePath: fileInfo.path,
        offset,
        length: Math.min(CHUNK_SIZE, fileInfo.size - offset)
      });
      sendPacketToPeer(targetId, { type: 'file-chunk', transferId, chunk });
      offset += CHUNK_SIZE;
      await new Promise(r => setTimeout(r, 4));
    }

    sendPacketToPeer(targetId, {
      type: 'file-end',
      transferId,
      groupId: activeChatType === 'group' ? activeChatId : null
    });
  }

  const msg = (chatHistory[activeChatId] || []).find(m => m.id === transferId);
  if (msg) {
    msg.text = `✅ Archivo enviado: ${fileInfo.name} (${formatBytes(fileInfo.size)})`;
    renderMessages();
  }
}

async function startCall(withVideo) {
  if (!activeChatId || activeChatType !== 'contact') {
    alert('Selecciona un contacto individual para iniciar una llamada HD.');
    return;
  }
  const c = contacts.find(item => item.id === activeChatId);
  if (c && c.blocked) {
    alert('No puedes llamar a un contacto bloqueado.');
    return;
  }

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: withVideo ? { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } } : false
    });

    document.getElementById('video-stage').classList.add('active');
    document.getElementById('local-video').srcObject = withVideo ? localStream : null;
    document.getElementById('remote-video-label').textContent = c ? (c.alias || c.name) : activeChatId;

    const targetPeerId = 'pcgchat-' + activeChatId.replace(/-/g, '');
    const call = peer.call(targetPeerId, localStream, { metadata: { video: withVideo } });
    bindMediaCall(call);
  } catch (e) {
    alert('No se pudo acceder a la cámara o micrófono. Revisa que no estén siendo usados por otra aplicación.');
  }
}

async function acceptIncomingCall() {
  closeModal('modal-incoming-call');
  stopAllSounds();
  if (!pendingIncomingCall) return;

  const withVideo = pendingIncomingCall.metadata && pendingIncomingCall.metadata.video;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: withVideo ? { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } } : false
    });
    document.getElementById('video-stage').classList.add('active');
    document.getElementById('local-video').srcObject = withVideo ? localStream : null;

    pendingIncomingCall.answer(localStream);
    bindMediaCall(pendingIncomingCall);
  } catch (e) {
    alert('Error al acceder a cámara o micrófono.');
  }
  pendingIncomingCall = null;
}

function rejectIncomingCall() {
  closeModal('modal-incoming-call');
  stopAllSounds();
  if (pendingIncomingCall) {
    pendingIncomingCall.close();
    pendingIncomingCall = null;
  }
}

function bindMediaCall(call) {
  currentMediaCall = call;
  call.on('stream', (remoteStream) => {
    document.getElementById('remote-video').srcObject = remoteStream;
  });
  call.on('close', () => endCall());
}

function endCall() {
  if (currentMediaCall) {
    currentMediaCall.close();
    currentMediaCall = null;
  }
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  document.getElementById('local-video').srcObject = null;
  document.getElementById('remote-video').srcObject = null;
  document.getElementById('video-stage').classList.remove('active');
}

function toggleMic() {
  if (!localStream) return;
  isMicMuted = !isMicMuted;
  localStream.getAudioTracks().forEach(t => t.enabled = !isMicMuted);
  document.getElementById('btn-toggle-mic').textContent = isMicMuted ? '🔇 Activar Mic' : '🎙️ Silenciar Mic';
}

function toggleCam() {
  if (!localStream) return;
  isCamOff = !isCamOff;
  localStream.getVideoTracks().forEach(t => t.enabled = !isCamOff);
  document.getElementById('btn-toggle-cam').textContent = isCamOff ? '📷 Encender Cam' : '📷 Apagar Cam';
}

// --- GRUPOS ---
async function createGroup() {
  const name = document.getElementById('group-name-input').value.trim();
  if (!name) {
    alert('Escribe un nombre para el grupo.');
    return;
  }
  const checked = Array.from(document.querySelectorAll('#group-members-checklist input:checked')).map(el => el.value);
  if (checked.length === 0) {
    alert('Selecciona al menos un contacto.');
    return;
  }

  const groupId = 'grp_' + Date.now();
  const members = [currentUser.id, ...checked];
  const { error } = await db.from('pcg_groups').insert({ id: groupId, name, members });
  if (error) {
    alert('Error al crear grupo: ' + error.message);
    return;
  }

  groups.push({ id: groupId, name, members, unread: 0 });
  closeModal('modal-new-group');
  switchSidebarTab('groups');
  selectChat(groupId, 'group');
}

// --- JUEGO 3 EN RAYA EN VIVO POR SUPABASE ---
function openTicTacToe() {
  if (!activeChatId) return;
  tttBoard = Array(9).fill('');
  tttMySymbol = 'X';
  tttTurn = 'X';
  openModal('modal-ttt');
  renderTicTacToe();
}

function renderTicTacToe() {
  const boardEl = document.getElementById('ttt-board');
  boardEl.innerHTML = '';
  const winner = checkTicTacToeWinner();
  const statusEl = document.getElementById('ttt-status');

  if (winner) {
    statusEl.textContent = winner === 'EMPATE' ? '🤝 ¡Empate!' : `🏆 ¡Ganó ${winner}!`;
  } else {
    statusEl.textContent = tttTurn === tttMySymbol ? `Tu turno (${tttMySymbol})` : `Turno de tu amigo (${tttTurn})`;
  }

  tttBoard.forEach((cell, idx) => {
    const btn = document.createElement('button');
    btn.className = 'ttt-cell';
    btn.textContent = cell;
    btn.onclick = async () => {
      if (cell || winner || tttTurn !== tttMySymbol) return;
      tttBoard[idx] = tttMySymbol;
      const nextTurn = tttMySymbol === 'X' ? 'O' : 'X';
      tttTurn = nextTurn;
      renderTicTacToe();

      const targets = getActiveTargetIds();
      for (const targetId of targets) {
        await db.from('pcg_signals').insert({
          target_id: targetId,
          from_id: currentUser.id,
          from_name: currentUser.username,
          signal_type: 'ttt-move',
          payload: { board: tttBoard, nextTurn, receiverSymbol: nextTurn }
        });
      }
    };
    boardEl.appendChild(btn);
  });
}

async function resetTicTacToe(notify) {
  tttBoard = Array(9).fill('');
  tttMySymbol = 'X';
  tttTurn = 'X';
  renderTicTacToe();
  if (notify) {
    const targets = getActiveTargetIds();
    for (const targetId of targets) {
      await db.from('pcg_signals').insert({
        target_id: targetId,
        from_id: currentUser.id,
        from_name: currentUser.username,
        signal_type: 'ttt-reset',
        payload: {}
      });
    }
  }
}

function checkTicTacToeWinner() {
  const winCombos = [
    '0,1,2', '3,4,5', '6,7,8',
    '0,3,6', '1,4,7', '2,5,8',
    '0,4,8', '2,4,6'
  ];
  for (const combo of winCombos) {
    const [a, b, c] = combo.split(',').map(Number);
    if (tttBoard[a] && tttBoard[a] === tttBoard[b] && tttBoard[a] === tttBoard[c]) return tttBoard[a];
  }
  return tttBoard.includes('') ? null : 'EMPATE';
}

// --- AJUSTES Y PERFILES ---
async function openSettingsModal() {
  document.getElementById('set-theme').value = currentUser.theme || localStorage.getItem('pcg_theme_pref') || 'dark';
  document.getElementById('set-username').value = currentUser.username;
  document.getElementById('set-call-tone').value = currentUser.call_tone || 'assets/cadence.mp3';
  document.getElementById('set-msg-tone').value = currentUser.msg_tone || 'assets/pluck.mp3';
  document.querySelectorAll('#settings-avatar-grid .avatar-choice').forEach(el => {
    el.classList.toggle('selected', el.dataset.avatar === currentUser.avatar);
  });
  document.getElementById('set-autostart').checked = await ipcRenderer.invoke('get-autostart');
  openModal('modal-settings');
}

function selectSettingsAvatar(el) {
  document.querySelectorAll('#settings-avatar-grid .avatar-choice').forEach(c => c.classList.remove('selected'));
  el.classList.add('selected');
  currentUser.avatar = el.dataset.avatar;
}

async function pickCustomAvatar() {
  const res = await ipcRenderer.invoke('pick-media-dataurl', [{ name: 'Imágenes', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]);
  if (res) {
    currentUser.avatar = res.dataUrl;
    document.querySelectorAll('#settings-avatar-grid .avatar-choice').forEach(c => c.classList.remove('selected'));
  }
}

async function pickCustomTone(kind) {
  const res = await ipcRenderer.invoke('pick-media-dataurl', [{ name: 'Audio', extensions: ['mp3', 'wav', 'ogg'] }]);
  if (res) {
    if (kind === 'call') currentUser.call_tone = res.dataUrl;
    else currentUser.msg_tone = res.dataUrl;
    playSound(res.dataUrl, false);
  }
}

function previewTone(kind) {
  const val = document.getElementById(kind === 'call' ? 'set-call-tone' : 'set-msg-tone').value;
  if (kind === 'call') currentUser.call_tone = val;
  else currentUser.msg_tone = val;
  playSound(val, false);
}

function toggleAutoStart() {
  const enabled = document.getElementById('set-autostart').checked;
  ipcRenderer.send('set-autostart', enabled);
}

async function saveSettings() {
  stopAllSounds();
  const newName = document.getElementById('set-username').value.trim();
  const newTheme = document.getElementById('set-theme').value;
  if (newName) currentUser.username = newName;
  currentUser.theme = newTheme;

  applyTheme(newTheme);
  refreshTopProfileUI();

  await db.from('pcg_users').update({
    username: currentUser.username,
    avatar: currentUser.avatar,
    theme: currentUser.theme,
    call_tone: currentUser.call_tone,
    msg_tone: currentUser.msg_tone
  }).eq('id', currentUser.id);

  closeModal('modal-settings');
}

function openPeerProfileModal() {
  if (activeChatType !== 'contact' || !activeChatId) return;
  const c = contacts.find(item => item.id === activeChatId);
  if (!c) return;
  document.getElementById('profile-modal-avatar').src = c.avatar;
  document.getElementById('profile-modal-name').textContent = c.name;
  document.getElementById('profile-modal-id').textContent = 'ID: ' + c.id;
  document.getElementById('profile-modal-bio').textContent = c.bio || 'Sin mensaje personal';
  document.getElementById('profile-modal-alias').value = c.alias || '';
  openModal('modal-peer-profile');
}

async function saveContactAlias() {
  const c = contacts.find(item => item.id === activeChatId);
  if (!c) return;
  c.alias = document.getElementById('profile-modal-alias').value.trim();
  renderSidebar();
  updateChatHeader();
  closeModal('modal-peer-profile');
  await db.from('pcg_contacts').update({ alias: c.alias }).eq('owner_id', currentUser.id).eq('friend_id', c.id);
}

function ctxViewProfile() {
  selectChat(selectedContactId, 'contact');
  openPeerProfileModal();
}

async function ctxToggleBlock() {
  const c = contacts.find(item => item.id === selectedContactId);
  if (!c) return;
  c.blocked = !c.blocked;
  renderSidebar();
  await db.from('pcg_contacts').update({ blocked: c.blocked }).eq('owner_id', currentUser.id).eq('friend_id', c.id);
}

async function ctxDeleteContact() {
  const targetId = selectedContactId;
  contacts = contacts.filter(item => item.id !== targetId);
  if (activeChatId === targetId) activeChatId = null;
  renderSidebar();
  await db.from('pcg_contacts').delete().eq('owner_id', currentUser.id).eq('friend_id', targetId);
}

// --- REPRODUCTOR DE SONIDOS (DETIENE EL ANTERIOR AUTOMATICAMENTE) ---
let currentPreviewAudio = null;

function playSound(src, loop) {
  stopAllSounds();
  if (!src) return;
  try {
    currentPreviewAudio = new Audio(src);
    currentPreviewAudio.loop = !!loop;
    currentPreviewAudio.play().catch(() => {});
  } catch (e) {}
}

function stopAllSounds() {
  if (currentPreviewAudio) {
    try {
      currentPreviewAudio.pause();
      currentPreviewAudio.currentTime = 0;
    } catch (e) {}
    currentPreviewAudio = null;
  }
}

// --- UTILIDADES ---
function openWindowsEmojiPanel() {
  const input = document.getElementById('msg-input');
  if (input) input.focus();
  ipcRenderer.send('open-windows-emoji');
}

function openModal(id) {
  if (id === 'modal-new-group') {
    const box = document.getElementById('group-members-checklist');
    box.innerHTML = contacts.filter(c => !c.blocked).map(c => `
      <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
        <input type="checkbox" value="${c.id}"> ${escapeHtml(c.alias || c.name)} (${c.id})
      </label>
    `).join('') || '<small>Agrega contactos primero.</small>';
  }
  document.getElementById(id).classList.add('open');
}

function closeModal(id) {
  if (id === 'modal-settings') stopAllSounds();
  document.getElementById(id).classList.remove('open');
}

function getActiveTargetIds() {
  if (activeChatType === 'contact') return [activeChatId];
  const g = groups.find(item => item.id === activeChatId);
  return g ? g.members.filter(id => id !== currentUser.id) : [];
}

function incrementUnread(chatId, isGroup) {
  const list = isGroup ? groups : contacts;
  const item = list.find(i => i.id === chatId);
  if (item) {
    item.unread = (item.unread || 0) + 1;
    renderSidebar();
  }
}

function statusLabel(st) {
  if (st === 'online') return '🟢 Conectado';
  if (st === 'away') return '🟡 No estoy';
  if (st === 'busy') return '🔴 No puedo atender';
  return '⚪ Desconectado';
}

function getNowTime() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}
