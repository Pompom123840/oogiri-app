const socket = io();
let room = null;
let myId = null;
let currentUser = null;
let currentStats = null;
let roomList = [];

const $ = (id) => document.getElementById(id);
const auth = $('auth');
const lobby = $('lobby');
const roomView = $('room');
const toast = $('toast');

const mobileNav = $('mobileNav');
let currentMobilePane = 'lobby';
function isMobileLayout() {
  return window.matchMedia('(max-width: 760px)').matches;
}
function setMobilePane(pane) {
  currentMobilePane = pane;
  document.querySelectorAll('.mobileNavBtn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.target === pane);
  });
  document.querySelectorAll('.mobilePane').forEach(el => {
    el.classList.toggle('activePane', el.dataset.pane === pane);
  });
}
function updateMobileNav() {
  const loggedIn = !!currentUser;
  const inRoom = !!room;
  if (!loggedIn) {
    mobileNav?.classList.add('hidden');
    document.body.classList.remove('mobile-tabs-active');
    return;
  }
  mobileNav?.classList.remove('hidden');
  document.body.classList.toggle('mobile-tabs-active', isMobileLayout());
  document.querySelectorAll('.mobileNavBtn').forEach(btn => {
    const target = btn.dataset.target;
    btn.disabled = target !== 'lobby' && !inRoom;
  });
  if (!inRoom && currentMobilePane !== 'lobby') currentMobilePane = 'lobby';
  setMobilePane(currentMobilePane);
}


function showToast(message) {
  toast.textContent = message;
  toast.classList.remove('hidden');
  setTimeout(() => toast.classList.add('hidden'), 2600);
}
function phaseName(phase) {
  return {
    waiting: '待機中',
    topic: 'お題決め',
    answer: '回答タイム',
    vote: '投票タイム',
    result: '結果発表'
  }[phase] || phase;
}
function formatTime(sec) {
  if (!sec) return '--';
  const m = Math.floor(sec / 60);
  const s = String(sec % 60).padStart(2, '0');
  return `${m}:${s}`;
}
function rankIcon(index) {
  return ['🥇', '🥈', '🥉'][index] || `${index + 1}`;
}
function signed(value) {
  return value > 0 ? `+${value}` : `${value}`;
}
function escapeHtml(text) {
  return String(text).replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
}
function updateAccountView() {
  if (!currentUser) return;
  $('accountTitle').textContent = `${currentUser.displayName}（@${currentUser.loginId}）`;
  if (currentStats) {
    $('accountStats').textContent = `Rating ${currentStats.rating || 1000} / 🏆 ${currentStats.trophies || 0} / 優勝 ${currentStats.wins || 0}回 / ${currentStats.games || 0}戦`;
  }
  $('displayNameInput').value = currentUser.displayName || '';
}
function showLobby() {
  auth.classList.add('hidden');
  lobby.classList.remove('hidden');
  roomView.classList.add('hidden');
  $('roomBadge').textContent = 'ロビー';
  updateAccountView();
  renderRoomList();
  currentMobilePane = 'lobby';
  updateMobileNav();
}
function renderLeaderboard(targetId, players, type) {
  const rows = players || [];
  $(targetId).innerHTML = rows.map((p, index) => {
    const mainValue = type === 'rating' ? p.rating : p.trophies;
    const sub = type === 'rating'
      ? `@${escapeHtml(p.loginId || '')} / 優勝 ${p.wins || 0}回 / 総得票 ${p.totalVotes || 0}`
      : `@${escapeHtml(p.loginId || '')} / 総得票 ${p.totalVotes || 0} / 回答 ${p.answers || 0} / ${p.games || 0}戦`;
    return `
      <div class="rankRow ${p.id === myId ? 'me' : ''}">
        <div class="rankNo">${rankIcon(index)}</div>
        <div class="rankBody">
          <strong>${escapeHtml(p.name)}${p.isHost ? ' 👑' : ''}</strong>
          <div class="small">${sub}</div>
        </div>
        <div class="rankScore">${mainValue}</div>
      </div>
    `;
  }).join('') || '<p>参加者が入ると表示されます。</p>';
}
function renderRoomList() {
  const target = $('roomList');
  if (!target) return;
  target.innerHTML = roomList.map(r => `
    <div class="roomCard ${r.canJoin ? '' : 'disabled'}">
      <div>
        <div class="roomCode">${escapeHtml(r.code)}</div>
        <div class="small">${escapeHtml(r.phaseName)} / ${r.playerCount}/${r.maxPlayers}人 / ホスト：${escapeHtml(r.hostName)}</div>
        <div class="small">${r.topic ? `お題：${escapeHtml(r.topic)}` : '待機中はここから参加できます。'}</div>
      </div>
      <button ${r.canJoin ? '' : 'disabled'} onclick="joinRoomFromList('${escapeHtml(r.code)}')">参加</button>
    </div>
  `).join('') || '<p class="small">まだ部屋がありません。最初の部屋を作ろう。</p>';
}
function render() {
  if (!room) return;
  auth.classList.add('hidden');
  lobby.classList.remove('hidden');
  roomView.classList.remove('hidden');
  $('roomBadge').textContent = `部屋 ${room.code}`;
  $('phaseTitle').textContent = phaseName(room.phase);
  $('timer').textContent = formatTime(room.remaining);

  const me = room.players.find(p => p.id === myId);
  const isHost = !!me?.isHost;
  const isTopicChooser = room.phase === 'topic' && room.topicChooserName === me?.name;

  $('topicText').textContent = room.topic
    ? `お題：${room.topic}`
    : room.phase === 'topic'
      ? `今回のお題担当：${room.topicChooserName}`
      : 'ホストが開始するとルーレットでお題担当が決まります。';

  $('startBtn').classList.toggle('hidden', !(room.phase === 'waiting' || room.phase === 'result'));
  $('startBtn').disabled = !isHost || room.players.length < (room.minPlayersToStart || 2);
  $('topicBox').classList.toggle('hidden', !isTopicChooser);
  $('answerBox').classList.toggle('hidden', room.phase !== 'answer');

  $('players').innerHTML = room.players.map(p => `
    <div class="item">
      <div class="itemHeader">
        <div>
          <strong>${escapeHtml(p.name)}${p.isHost ? ' 👑' : ''}</strong>
          <div class="small">@${escapeHtml(p.loginId || '')} / 🏆 ${p.trophies} / Rating ${p.rating} / ${p.totalVotes || 0}票 / ${p.games || 0}戦</div>
        </div>
        ${p.id !== myId ? `<button class="report" onclick="reportPlayer('${p.id}')">通報</button>` : '<span class="small">あなた</span>'}
      </div>
    </div>
  `).join('') || '<p>参加者なし</p>';

  $('answers').innerHTML = room.answers.map(a => `
    <div class="item">
      <div class="itemHeader">
        <div>
          <div class="answerText">${escapeHtml(a.text)}</div>
          <div class="small">${escapeHtml(a.authorName)}${a.votes !== undefined ? ` / ${a.votes}票` : ''}</div>
        </div>
        ${room.phase === 'vote' ? `<button class="vote" onclick="vote('${a.id}')">投票</button>` : ''}
      </div>
    </div>
  `).join('') || '<p>まだ回答はありません。</p>';

  renderLeaderboard('trophyRanking', room.trophyRanking, 'trophy');
  renderLeaderboard('ratingRanking', room.ratingRanking, 'rating');

  updateMobileNav();

  $('results').innerHTML = room.results.map(r => `
    <div class="item">
      <strong>${r.rank}位：${escapeHtml(r.authorName)}</strong>
      <p>${escapeHtml(r.answer)}</p>
      <div class="small">${r.votes}票 / 🏆 +${r.trophyGain || 0} / Rating ${signed(r.ratingChange || 0)}${r.ratingBefore ? `（${r.ratingBefore} → ${r.ratingAfter}）` : ''}</div>
    </div>
  `).join('') || '<p>ラウンド終了後に表示されます。</p>';
}
function handleAuthResponse(res) {
  if (!res.ok) return showToast(res.error);
  currentUser = res.user;
  currentStats = res.stats;
  localStorage.setItem('oogiriLastLoginId', currentUser.loginId);
  showToast('ログインしました。');
  showLobby();
}

$('loginId').value = localStorage.getItem('oogiriLastLoginId') || '';
$('loginBtn').onclick = () => {
  socket.emit('auth:login', {
    loginId: $('loginId').value,
    password: $('loginPassword').value
  }, handleAuthResponse);
};
$('registerBtn').onclick = () => {
  socket.emit('auth:register', {
    loginId: $('registerId').value,
    displayName: $('registerName').value,
    password: $('registerPassword').value
  }, handleAuthResponse);
};
$('logoutBtn').onclick = () => {
  socket.emit('auth:logout', () => {
    currentUser = null;
    currentStats = null;
    room = null;
    auth.classList.remove('hidden');
    lobby.classList.add('hidden');
    roomView.classList.add('hidden');
    $('roomBadge').textContent = '未入室';
    updateMobileNav();
  });
};
$('updateNameBtn').onclick = () => {
  socket.emit('auth:updateName', { displayName: $('displayNameInput').value }, (res) => {
    if (!res.ok) return showToast(res.error);
    currentUser = res.user;
    updateAccountView();
    showToast('表示名を変更しました。');
  });
};
$('createBtn').onclick = () => {
  socket.emit('room:create', {}, (res) => {
    if (!res.ok) return showToast(res.error);
    room = res.room;
    myId = socket.id;
    currentMobilePane = 'room';
    render();
  });
};
$('quickJoinBtn').onclick = () => {
  socket.emit('room:quickJoin', {}, (res) => {
    if (!res.ok) return showToast(res.error);
    room = res.room;
    myId = socket.id;
    currentMobilePane = 'room';
    render();
  });
};
$('refreshRoomsBtn').onclick = () => {
  socket.emit('room:list', (res) => {
    if (!res.ok) return showToast(res.error);
    roomList = res.rooms || [];
    renderRoomList();
  });
};
$('joinBtn').onclick = () => {
  socket.emit('room:join', { code: $('roomCode').value }, (res) => {
    if (!res.ok) return showToast(res.error);
    room = res.room;
    myId = socket.id;
    currentMobilePane = 'room';
    render();
  });
};
window.joinRoomFromList = (code) => {
  socket.emit('room:join', { code }, (res) => {
    if (!res.ok) return showToast(res.error);
    room = res.room;
    myId = socket.id;
    currentMobilePane = 'room';
    render();
  });
};
$('leaveRoomBtn').onclick = () => {
  socket.emit('room:leave', (res) => {
    if (!res.ok) return showToast(res.error);
    room = null;
    roomView.classList.add('hidden');
    $('roomBadge').textContent = 'ロビー';
    currentMobilePane = 'lobby';
    updateMobileNav();
    showToast('部屋を退出しました。');
  });
};
$('startBtn').onclick = () => socket.emit('round:start');
$('submitTopicBtn').onclick = () => {
  socket.emit('topic:submit', { topic: $('topicInput').value });
  $('topicInput').value = '';
};
$('presetTopicBtn').onclick = () => socket.emit('topic:preset');
$('submitAnswerBtn').onclick = () => {
  socket.emit('answer:submit', { text: $('answerInput').value });
  $('answerInput').value = '';
};
window.vote = (answerId) => socket.emit('vote:submit', { answerId });
window.reportPlayer = (targetId) => socket.emit('report:player', { targetId });

socket.on('room:update', nextRoom => {
  room = nextRoom;
  myId = socket.id;
  const me = room.players.find(p => p.id === myId);
  if (me) {
    currentStats = {
      rating: me.rating,
      trophies: me.trophies,
      wins: me.wins,
      games: me.games,
      totalVotes: me.totalVotes,
      answers: me.answers
    };
    updateAccountView();
  }
  render();
});
socket.on('rooms:update', rooms => {
  roomList = rooms || [];
  renderRoomList();
});
socket.on('system:message', showToast);
setInterval(() => {
  if (room?.remaining > 0) {
    room.remaining -= 1;
    $('timer').textContent = formatTime(room.remaining);
  }
}, 1000);


document.querySelectorAll('.mobileNavBtn').forEach(btn => {
  btn.addEventListener('click', () => setMobilePane(btn.dataset.target));
});
window.addEventListener('resize', updateMobileNav);
updateMobileNav();
