'use strict';

const STORAGE_KEYS = {
  supabaseUrl: 'word_duel_supabase_url',
  supabaseAnonKey: 'word_duel_supabase_anon_key',
  session: 'word_duel_session',
  nickname: 'word_duel_nickname',
};

const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const state = {
  supabase: null,
  connected: false,
  channel: null,
  session: null,
  room: null,
  guesses: [],
  roomBusy: false,
};

const els = {
  supabaseUrl: document.getElementById('supabase-url'),
  supabaseKey: document.getElementById('supabase-key'),
  connectBtn: document.getElementById('connect-btn'),
  clearConfigBtn: document.getElementById('clear-config-btn'),
  connectStatus: document.getElementById('connect-status'),

  nickname: document.getElementById('nickname'),
  wordLength: document.getElementById('word-length'),
  roomCode: document.getElementById('room-code'),
  createRoomBtn: document.getElementById('create-room-btn'),
  joinRoomBtn: document.getElementById('join-room-btn'),
  lobbyMessage: document.getElementById('lobby-message'),

  lobbyCard: document.getElementById('lobby-card'),
  roomCard: document.getElementById('room-card'),
  roomCodeShow: document.getElementById('room-code-show'),
  roomMeta: document.getElementById('room-meta'),
  roomStats: document.getElementById('room-stats'),

  copyRoomBtn: document.getElementById('copy-room-btn'),
  leaveRoomBtn: document.getElementById('leave-room-btn'),

  secretWord: document.getElementById('secret-word'),
  submitSecretBtn: document.getElementById('submit-secret-btn'),
  guessWord: document.getElementById('guess-word'),
  submitGuessBtn: document.getElementById('submit-guess-btn'),
  roomMessage: document.getElementById('room-message'),

  myGuesses: document.getElementById('my-guesses'),
  opponentGuesses: document.getElementById('opponent-guesses'),
};

bindEvents();
restoreCachedInputs();
setConnectStatus(false);
renderScene();

async function autoConnectIfPossible() {
  const url = els.supabaseUrl.value.trim();
  const key = els.supabaseKey.value.trim();
  if (!url || !key) return;
  await connectSupabase();
}

autoConnectIfPossible();

function bindEvents() {
  els.connectBtn.addEventListener('click', connectSupabase);
  els.clearConfigBtn.addEventListener('click', clearConfig);

  els.createRoomBtn.addEventListener('click', createRoom);
  els.joinRoomBtn.addEventListener('click', joinRoom);

  els.submitSecretBtn.addEventListener('click', submitSecretWord);
  els.submitGuessBtn.addEventListener('click', submitGuessWord);

  els.copyRoomBtn.addEventListener('click', copyRoomCode);
  els.leaveRoomBtn.addEventListener('click', () => leaveRoom('你已离开房间。', true));
}

function restoreCachedInputs() {
  els.supabaseUrl.value = localStorage.getItem(STORAGE_KEYS.supabaseUrl) || '';
  els.supabaseKey.value = localStorage.getItem(STORAGE_KEYS.supabaseAnonKey) || '';
  els.nickname.value = localStorage.getItem(STORAGE_KEYS.nickname) || '';
}

async function connectSupabase() {
  const url = els.supabaseUrl.value.trim();
  const anonKey = els.supabaseKey.value.trim();

  if (!url || !anonKey) {
    setLobbyMessage('请先填写 Supabase URL 和 anon key。', 'error');
    return;
  }

  if (!window.supabase || typeof window.supabase.createClient !== 'function') {
    setLobbyMessage('Supabase SDK 加载失败，请刷新页面重试。', 'error');
    return;
  }

  setConnectBusy(true);
  setLobbyMessage('正在连接 Supabase...', 'info');

  try {
    const client = window.supabase.createClient(url, anonKey, {
      auth: { persistSession: false },
    });

    const { error } = await client.from('rooms').select('id').limit(1);
    if (error) throw error;

    state.supabase = client;
    state.connected = true;

    localStorage.setItem(STORAGE_KEYS.supabaseUrl, url);
    localStorage.setItem(STORAGE_KEYS.supabaseAnonKey, anonKey);

    setConnectStatus(true);
    setLobbyMessage('连接成功，可以创建或加入房间。', 'success');

    await restoreRoomSessionIfAny();
  } catch (err) {
    state.supabase = null;
    state.connected = false;
    setConnectStatus(false);
    setLobbyMessage(`连接失败：${friendlyError(err)}`, 'error');
  } finally {
    setConnectBusy(false);
  }
}

async function clearConfig() {
  localStorage.removeItem(STORAGE_KEYS.supabaseUrl);
  localStorage.removeItem(STORAGE_KEYS.supabaseAnonKey);
  els.supabaseUrl.value = '';
  els.supabaseKey.value = '';

  await teardownRealtime();
  state.supabase = null;
  state.connected = false;
  state.session = null;
  state.room = null;
  state.guesses = [];
  state.roomBusy = false;

  localStorage.removeItem(STORAGE_KEYS.session);

  setConnectStatus(false);
  renderScene();
  setLobbyMessage('配置已清空，请重新输入并连接。', 'info');
}

function setConnectBusy(busy) {
  els.connectBtn.disabled = busy;
  els.clearConfigBtn.disabled = busy;
}

function setConnectStatus(online) {
  els.connectStatus.textContent = online ? '已连接' : '未连接';
  els.connectStatus.className = `tag ${online ? 'online' : 'offline'}`;
}

async function restoreRoomSessionIfAny() {
  const raw = localStorage.getItem(STORAGE_KEYS.session);
  if (!raw) return;

  try {
    const saved = JSON.parse(raw);
    if (!saved?.roomId || !saved?.role || !saved?.nickname) {
      localStorage.removeItem(STORAGE_KEYS.session);
      return;
    }
    await enterRoom(saved.roomId, saved.role, saved.nickname, true);
    setRoomMessage('已恢复到上次房间。', 'info');
  } catch {
    localStorage.removeItem(STORAGE_KEYS.session);
  }
}

function validateNickname() {
  const nickname = els.nickname.value.trim();
  if (!nickname) {
    setLobbyMessage('请输入昵称。', 'error');
    return null;
  }

  localStorage.setItem(STORAGE_KEYS.nickname, nickname);
  return nickname;
}

async function createRoom() {
  if (!state.connected || !state.supabase) {
    setLobbyMessage('请先连接 Supabase。', 'error');
    return;
  }

  const nickname = validateNickname();
  if (!nickname) return;

  const length = Number.parseInt(els.wordLength.value.trim(), 10);
  if (!Number.isInteger(length) || length < 3 || length > 12) {
    setLobbyMessage('单词长度必须在 3 到 12 之间。', 'error');
    return;
  }

  setLobbyBusy(true);
  setLobbyMessage('正在创建房间...', 'info');

  try {
    let room = null;

    for (let i = 0; i < 8; i += 1) {
      const roomCode = generateRoomCode();
      const { data, error } = await state.supabase
        .from('rooms')
        .insert({
          room_code: roomCode,
          word_length: length,
          host_name: nickname,
          status: 'waiting',
        })
        .select('*')
        .single();

      if (!error) {
        room = data;
        break;
      }

      if (error.code !== '23505') {
        throw error;
      }
    }

    if (!room) {
      throw new Error('房间码冲突过多，请重试。');
    }

    await enterRoom(room.id, 'host', nickname, false);
    setRoomMessage('房间创建成功，把房间码发给对方。', 'success');
  } catch (err) {
    setLobbyMessage(`创建失败：${friendlyError(err)}`, 'error');
  } finally {
    setLobbyBusy(false);
  }
}

async function joinRoom() {
  if (!state.connected || !state.supabase) {
    setLobbyMessage('请先连接 Supabase。', 'error');
    return;
  }

  const nickname = validateNickname();
  if (!nickname) return;

  const code = els.roomCode.value.trim().toUpperCase();
  if (!code) {
    setLobbyMessage('请输入房间码。', 'error');
    return;
  }

  setLobbyBusy(true);
  setLobbyMessage('正在加入房间...', 'info');

  try {
    const { data: room, error } = await state.supabase
      .from('rooms')
      .select('*')
      .eq('room_code', code)
      .maybeSingle();

    if (error) throw error;
    if (!room) {
      setLobbyMessage(`房间不存在：${code}`, 'error');
      return;
    }

    let role = 'guest';

    if (room.host_name === nickname) {
      role = 'host';
    } else if (room.guest_name === nickname) {
      role = 'guest';
    } else if (room.guest_name && room.guest_name !== nickname) {
      setLobbyMessage('房间已满，请让对方重新创建房间。', 'error');
      return;
    } else {
      const nextStatus = room.host_secret && room.guest_secret ? 'playing' : 'ready';
      const { error: updateError } = await state.supabase
        .from('rooms')
        .update({
          guest_name: nickname,
          status: nextStatus,
        })
        .eq('id', room.id);

      if (updateError) throw updateError;
    }

    await enterRoom(room.id, role, nickname, false);
    setRoomMessage('加入房间成功。', 'success');
  } catch (err) {
    setLobbyMessage(`加入失败：${friendlyError(err)}`, 'error');
  } finally {
    setLobbyBusy(false);
  }
}

async function enterRoom(roomId, role, nickname, restoring) {
  state.session = { roomId, role, nickname };
  localStorage.setItem(STORAGE_KEYS.session, JSON.stringify(state.session));

  try {
    await subscribeRoomRealtime(roomId);
    const exists = await refreshRoomAndGuesses();

    if (!exists) {
      await leaveRoom('房间不存在或已被删除。', true);
      return;
    }

    renderScene();

    if (!restoring) {
      setLobbyMessage('已进入房间。', 'success');
    }
  } catch (err) {
    await teardownRealtime();
    state.session = null;
    state.room = null;
    state.guesses = [];
    state.roomBusy = false;
    localStorage.removeItem(STORAGE_KEYS.session);
    renderScene();
    throw err;
  }
}

async function leaveRoom(message, clearSession) {
  await teardownRealtime();
  state.session = null;
  state.room = null;
  state.guesses = [];
  state.roomBusy = false;

  if (clearSession) {
    localStorage.removeItem(STORAGE_KEYS.session);
  }

  renderScene();
  setLobbyMessage(message || '已离开房间。', 'info');
}

function setLobbyBusy(busy) {
  els.createRoomBtn.disabled = busy;
  els.joinRoomBtn.disabled = busy;
}

async function subscribeRoomRealtime(roomId) {
  await teardownRealtime();

  if (!state.supabase) return;

  const channel = state.supabase
    .channel(`room-duel-${roomId}`)
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'rooms',
      filter: `id=eq.${roomId}`,
    }, async () => {
      try {
        const exists = await refreshRoom();
        if (!exists) {
          await leaveRoom('房间已不存在。', true);
          return;
        }
        renderRoom();
      } catch (err) {
        setRoomMessage(`房间同步失败：${friendlyError(err)}`, 'error');
      }
    })
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'guesses',
      filter: `room_id=eq.${roomId}`,
    }, async () => {
      try {
        await refreshGuesses();
        renderRoom();
      } catch (err) {
        setRoomMessage(`猜词同步失败：${friendlyError(err)}`, 'error');
      }
    });

  channel.subscribe((status) => {
    if (status === 'SUBSCRIBED') {
      setRoomMessage('实时同步已连接。', 'info');
    }
  });

  state.channel = channel;
}

async function teardownRealtime() {
  if (!state.channel || !state.supabase) return;

  try {
    await state.supabase.removeChannel(state.channel);
  } catch {
    // ignore removal failure for best-effort cleanup
  }
  state.channel = null;
}

async function refreshRoomAndGuesses() {
  const [exists] = await Promise.all([refreshRoom(), refreshGuesses()]);
  renderRoom();
  return exists;
}

async function refreshRoom() {
  if (!state.supabase || !state.session) return false;

  const { data, error } = await state.supabase
    .from('rooms')
    .select('*')
    .eq('id', state.session.roomId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  state.room = data || null;
  return !!data;
}

async function refreshGuesses() {
  if (!state.supabase || !state.session) return;

  const { data, error } = await state.supabase
    .from('guesses')
    .select('*')
    .eq('room_id', state.session.roomId)
    .order('id', { ascending: true });

  if (error) {
    throw error;
  }

  state.guesses = Array.isArray(data) ? data : [];
}

function renderScene() {
  const inRoom = !!state.session;
  els.lobbyCard.classList.toggle('hidden', inRoom);
  els.roomCard.classList.toggle('hidden', !inRoom);

  if (inRoom) {
    renderRoom();
  }
}

function renderRoom() {
  const room = state.room;
  const session = state.session;

  if (!room || !session) return;

  const isHost = session.role === 'host';
  const selfSlot = isHost ? 1 : 2;

  const selfSecretCol = isHost ? 'host_secret' : 'guest_secret';
  const opponentSecretCol = isHost ? 'guest_secret' : 'host_secret';
  const selfSolvedCol = isHost ? 'host_solved_attempt' : 'guest_solved_attempt';
  const opponentSolvedCol = isHost ? 'guest_solved_attempt' : 'host_solved_attempt';

  const wordLength = Number(room.word_length) || 5;
  const status = String(room.status || 'waiting');

  const selfSecretSet = !!room[selfSecretCol];
  const opponentSecretSet = !!room[opponentSecretCol];
  const selfSolvedAttempt = room[selfSolvedCol] || null;
  const opponentSolvedAttempt = room[opponentSolvedCol] || null;

  els.roomCodeShow.textContent = room.room_code || '------';
  els.roomMeta.textContent = `状态：${statusLabel(status)} · 单词长度：${wordLength}`;

  const winner = winnerText(room);
  const myResult = selfSolvedAttempt ? `${selfSolvedAttempt} 次猜中` : '未猜中';
  const opponentResult = opponentSolvedAttempt ? `${opponentSolvedAttempt} 次猜中` : '未猜中';

  els.roomStats.innerHTML = '';
  appendStat('你', session.nickname, els.roomStats);
  appendStat('主机', room.host_name || '-', els.roomStats);
  appendStat('来宾', room.guest_name || '等待加入', els.roomStats);
  appendStat('我的成绩', myResult, els.roomStats);
  appendStat('对方成绩', opponentResult, els.roomStats);
  appendStat('我的密词', selfSecretSet ? '已提交' : '未提交', els.roomStats);
  appendStat('对方密词', opponentSecretSet ? '已提交' : '未提交', els.roomStats);
  appendStat('对局结果', winner || '进行中', els.roomStats);

  els.secretWord.placeholder = `输入 ${wordLength} 位英文字母`;
  els.guessWord.placeholder = `输入 ${wordLength} 位英文字母`;

  els.submitSecretBtn.disabled = state.roomBusy || selfSecretSet || status === 'finished';
  els.submitSecretBtn.textContent = selfSecretSet ? '已提交密词' : '提交密词';

  const canGuess = status !== 'finished' && opponentSecretSet && !selfSolvedAttempt;
  els.submitGuessBtn.disabled = state.roomBusy || !canGuess;

  renderGuessPanels(selfSlot);

  if (winner) {
    const banner = document.createElement('div');
    banner.className = 'winner-banner';
    banner.textContent = winner;
    els.roomStats.appendChild(banner);
  }
}

function appendStat(label, value, container) {
  const item = document.createElement('div');
  item.className = 'stat-item';

  const title = document.createElement('strong');
  title.textContent = label;

  const content = document.createElement('span');
  content.textContent = String(value);

  item.appendChild(title);
  item.appendChild(content);
  container.appendChild(item);
}

async function submitSecretWord() {
  if (!state.supabase || !state.session || !state.room) return;

  const room = state.room;
  const isHost = state.session.role === 'host';
  const selfSecretCol = isHost ? 'host_secret' : 'guest_secret';
  const wordLength = Number(room.word_length) || 5;

  const secret = els.secretWord.value.trim().toLowerCase();

  if (!isEnglishWord(secret) || secret.length !== wordLength) {
    setRoomMessage(`秘密单词必须是 ${wordLength} 位英文字母。`, 'error');
    return;
  }

  if (room[selfSecretCol]) {
    setRoomMessage('你已经提交过秘密单词了。', 'info');
    return;
  }

  setRoomBusy(true);
  setRoomMessage('正在提交秘密单词...', 'info');

  try {
    const { error } = await state.supabase
      .from('rooms')
      .update({ [selfSecretCol]: secret })
      .eq('id', room.id);

    if (error) throw error;

    await syncRoomStatus(room.id);
    await refreshRoom();
    renderRoom();

    els.secretWord.value = '';
    setRoomMessage('秘密单词已提交。', 'success');
  } catch (err) {
    setRoomMessage(`提交失败：${friendlyError(err)}`, 'error');
  } finally {
    setRoomBusy(false);
  }
}

async function submitGuessWord() {
  if (!state.supabase || !state.session || !state.room) return;

  const room = state.room;
  const isHost = state.session.role === 'host';
  const selfSlot = isHost ? 1 : 2;

  const opponentSecretCol = isHost ? 'guest_secret' : 'host_secret';
  const selfSolvedCol = isHost ? 'host_solved_attempt' : 'guest_solved_attempt';

  const wordLength = Number(room.word_length) || 5;
  const guess = els.guessWord.value.trim().toLowerCase();

  if (!isEnglishWord(guess) || guess.length !== wordLength) {
    setRoomMessage(`猜词必须是 ${wordLength} 位英文字母。`, 'error');
    return;
  }

  if (room.status === 'finished') {
    setRoomMessage('本局已经结束。', 'info');
    return;
  }

  if (room[selfSolvedCol]) {
    setRoomMessage('你已经猜中，等待对方完成。', 'info');
    return;
  }

  const target = room[opponentSecretCol];
  if (!target) {
    setRoomMessage('对方还没提交秘密单词。', 'info');
    return;
  }

  const myAttempts = state.guesses.filter((g) => Number(g.player_slot) === selfSlot).length;
  const nextAttempt = myAttempts + 1;

  const marks = scoreGuess(guess, target);

  setRoomBusy(true);
  setRoomMessage('正在提交猜词...', 'info');

  try {
    const { error: insertError } = await state.supabase.from('guesses').insert({
      room_id: room.id,
      player_slot: selfSlot,
      guess,
      marks,
      attempt_no: nextAttempt,
    });

    if (insertError) throw insertError;

    if (guess === target) {
      const { error: solvedError } = await state.supabase
        .from('rooms')
        .update({ [selfSolvedCol]: nextAttempt })
        .eq('id', room.id);
      if (solvedError) throw solvedError;
    }

    await syncRoomStatus(room.id);
    await refreshRoomAndGuesses();

    els.guessWord.value = '';
    setRoomMessage(guess === target ? '猜中啦！等待对方完成。' : '已提交本次猜词。', 'success');
  } catch (err) {
    setRoomMessage(`提交失败：${friendlyError(err)}`, 'error');
  } finally {
    setRoomBusy(false);
  }
}

async function syncRoomStatus(roomId) {
  if (!state.supabase) return;

  const { data, error } = await state.supabase
    .from('rooms')
    .select('id,status,host_secret,guest_secret,host_solved_attempt,guest_solved_attempt')
    .eq('id', roomId)
    .single();

  if (error) throw error;

  const updates = {};

  if (
    data.host_secret &&
    data.guest_secret &&
    data.status !== 'playing' &&
    data.status !== 'finished'
  ) {
    updates.status = 'playing';
  }

  if (data.host_solved_attempt && data.guest_solved_attempt && data.status !== 'finished') {
    updates.status = 'finished';
  }

  if (Object.keys(updates).length > 0) {
    const { error: updateError } = await state.supabase.from('rooms').update(updates).eq('id', roomId);
    if (updateError) throw updateError;
  }
}

function renderGuessPanels(selfSlot) {
  const myGuesses = state.guesses.filter((g) => Number(g.player_slot) === selfSlot);
  const opponentGuesses = state.guesses.filter((g) => Number(g.player_slot) !== selfSlot);

  paintGuessList(els.myGuesses, myGuesses);
  paintGuessList(els.opponentGuesses, opponentGuesses);
}

function paintGuessList(container, rows) {
  container.innerHTML = '';

  if (!rows.length) {
    container.classList.add('empty');
    container.textContent = '暂无记录';
    return;
  }

  container.classList.remove('empty');

  rows.forEach((row, index) => {
    const guessRow = document.createElement('div');
    guessRow.className = 'guess-row';

    const no = document.createElement('span');
    no.className = 'attempt-no';
    no.textContent = `#${row.attempt_no || index + 1}`;

    const wrap = document.createElement('div');
    wrap.className = 'tile-wrap';

    const guess = String(row.guess || '').toUpperCase();
    const marks = normalizeMarks(row.marks);

    for (let i = 0; i < guess.length; i += 1) {
      const tile = document.createElement('span');
      const mark = marks[i] || 'absent';
      tile.className = `tile ${mark}`;
      tile.textContent = guess[i];
      wrap.appendChild(tile);
    }

    guessRow.appendChild(no);
    guessRow.appendChild(wrap);
    container.appendChild(guessRow);
  });
}

function normalizeMarks(raw) {
  if (Array.isArray(raw)) {
    return raw.map((v) => String(v));
  }

  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.map((v) => String(v));
      }
    } catch {
      return [];
    }
  }

  return [];
}

async function copyRoomCode() {
  const code = state.room?.room_code;
  if (!code) return;

  try {
    await navigator.clipboard.writeText(code);
    setRoomMessage(`房间码已复制：${code}`, 'success');
  } catch {
    setRoomMessage(`房间码：${code}`, 'info');
  }
}

function setRoomBusy(busy) {
  state.roomBusy = busy;
  if (busy) {
    els.submitSecretBtn.disabled = true;
    els.submitGuessBtn.disabled = true;
    return;
  }
  renderRoom();
}

function statusLabel(status) {
  switch (status) {
    case 'waiting':
      return '等待对手加入';
    case 'ready':
      return '等待双方提交秘密单词';
    case 'playing':
      return '进行中';
    case 'finished':
      return '已结束';
    default:
      return status;
  }
}

function winnerText(room) {
  if (room.status !== 'finished') return '';

  const hostSolved = room.host_solved_attempt;
  const guestSolved = room.guest_solved_attempt;

  if (!hostSolved || !guestSolved) {
    return '对局结束';
  }

  if (hostSolved === guestSolved) {
    return '结果：平局';
  }

  const winnerName = hostSolved < guestSolved ? room.host_name : room.guest_name;
  if (!winnerName) return '对局结束';

  if (state.session && winnerName === state.session.nickname) {
    return `你赢了（${winnerName}）`;
  }

  return `胜者：${winnerName}`;
}

function generateRoomCode() {
  let out = '';
  for (let i = 0; i < 6; i += 1) {
    const idx = Math.floor(Math.random() * ROOM_CODE_CHARS.length);
    out += ROOM_CODE_CHARS[idx];
  }
  return out;
}

function scoreGuess(guess, target) {
  const marks = new Array(guess.length).fill('absent');
  const remaining = new Map();

  for (let i = 0; i < guess.length; i += 1) {
    const g = guess[i];
    const t = target[i];

    if (g === t) {
      marks[i] = 'correct';
    } else {
      remaining.set(t, (remaining.get(t) || 0) + 1);
    }
  }

  for (let i = 0; i < guess.length; i += 1) {
    if (marks[i] === 'correct') continue;

    const g = guess[i];
    const left = remaining.get(g) || 0;
    if (left > 0) {
      marks[i] = 'present';
      remaining.set(g, left - 1);
    }
  }

  return marks;
}

function isEnglishWord(text) {
  return /^[a-zA-Z]+$/.test(text);
}

function friendlyError(err) {
  if (!err) return '未知错误';
  if (typeof err === 'string') return err;
  if (err.message) return err.message;
  return JSON.stringify(err);
}

function setLobbyMessage(text, type) {
  setMessage(els.lobbyMessage, text, type);
}

function setRoomMessage(text, type) {
  setMessage(els.roomMessage, text, type);
}

function setMessage(el, text, type) {
  el.textContent = text;
  el.className = `message ${type || 'info'}`;
}
