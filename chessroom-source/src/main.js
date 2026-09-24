import { Chess } from 'chess.js';
import './style.css';
import { inject } from '@vercel/analytics';

inject();

const glyphs = {wk:'♔', wq:'♕', wr:'♖', wb:'♗', wn:'♘', wp:'♙', bk:'♚', bq:'♛', br:'♜', bb:'♝', bn:'♞', bp:'♟'};
const pieceNames = {k:'king', q:'queen', r:'rook', b:'bishop', n:'knight', p:'pawn'};
const app = document.querySelector('#app');
const state = {room:null, color:null, token:null, selected:null, legal:[], busy:false, error:'', notice:'', promotion:null, history:[], loading:false};
const roomId = () => location.pathname.match(/^\/room\/([A-Z2-9]{8})\/?$/i)?.[1]?.toUpperCase();
const sessionKey = (id) => `chessroom:${id}`;
const chess = () => new Chess(state.room?.fen);
const other = (color) => color === 'w' ? 'b' : 'w';
const colorName = (color) => color === 'w' ? 'White' : 'Black';

async function api(body) {
  let response;
  try {
    response = await fetch('/api/rooms' + (body ? '' : `?id=${encodeURIComponent(roomId())}`), {method: body ? 'POST' : 'GET', headers: body ? {'Content-Type':'application/json'} : undefined, body: body ? JSON.stringify(body) : undefined, cache: 'no-store'});
  } catch { throw new Error('Cannot reach the game server. Check your connection.'); }
  let data;
  try { data = await response.json(); } catch { throw new Error('The game server did not respond correctly.'); }
  if (!response.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}
function setSession(data) {
  state.room = data.room;
  state.color = data.color;
  state.token = data.playerToken;
  localStorage.setItem(sessionKey(data.room.id), JSON.stringify({color: data.color, token: data.playerToken}));
  state.selected = null; state.legal = []; state.error = '';
}
function toast(message, isError = false) {
  state.error = isError ? message : '';
  state.notice = isError ? '' : message;
  render();
}
async function load() {
  const id = roomId();
  if (!id) {state.loading = false; render(); return;}
  state.loading = true; render();
  try {
    const saved = JSON.parse(localStorage.getItem(sessionKey(id)) || 'null');
    state.color = saved?.color || null;
    state.token = saved?.token || null;
    const {room} = await api(); state.room = room; state.error = '';
  } catch (e) {state.error = e.message; state.room = null;}
  state.loading = false; render();
}
async function createRoom() {
  state.busy = true; render();
  try {
    const data = await api({action:'create'});
    history.pushState({}, '', `/room/${data.room.id}`);
    setSession(data);
  } catch (e) {state.error = e.message;}
  state.busy = false; render();
}
async function joinRoom() {
  state.busy = true; render();
  try {setSession(await api({action:'join', roomId: state.room.id}));}
  catch (e) {state.error = e.message; await refresh();}
  state.busy = false; render();
}
async function refresh() {
  if (!roomId()) return;
  try {
    const {room} = await api();
    if (!state.room || room.version !== state.room.version) {state.room = room; state.selected = null; state.legal = []; state.error = ''; render();}
  } catch (e) {if (state.room) toast(e.message, true);}
}
async function sendMove(from, to, promotion = 'q') {
  state.promotion = null;
  state.busy = true; render();
  try {
    const {room} = await api({action:'move', roomId: state.room.id, playerToken: state.token, from, to, promotion, version: state.room.version});
    state.room = room; state.selected = null; state.legal = []; state.error = '';
  } catch (e) {state.error = e.message; await refresh();}
  state.busy = false; render();
}
async function resign() {
  if (!confirm('Resign this game?')) return;
  state.busy = true; render();
  try {const {room} = await api({action:'resign', roomId: state.room.id, playerToken: state.token}); state.room = room; state.error = '';}
  catch (e) {state.error = e.message; await refresh();}
  state.busy = false; render();
}
function onSquare(square) {
  const room = state.room;
  if (!room || room.status !== 'playing' || state.busy || !state.color) return;
  const game = chess();
  if (game.turn() !== state.color) return;
  const piece = game.get(square);
  if (state.selected && state.legal.includes(square)) {
    const from = state.selected;
    const chosen = game.get(from);
    if (chosen?.type === 'p' && (square[1] === '1' || square[1] === '8')) {state.promotion = {from, to:square}; render();}
    else sendMove(from, square);
    return;
  }
  if (piece?.color === state.color) {
    state.selected = square;
    state.legal = game.moves({square, verbose:true}).map(m => m.to);
  } else {state.selected = null; state.legal = [];}
  render();
}
function boardHtml() {
  const game = state.room ? chess() : new Chess();
  const flipped = state.color === 'b';
  const ranks = flipped ? [1,2,3,4,5,6,7,8] : [8,7,6,5,4,3,2,1];
  const files = flipped ? [...'hgfedcba'] : [...'abcdefgh'];
  const last = state.room?.moves.at(-1);
  const checkSquare = game.isCheck() ? [...'abcdefgh'].flatMap(f => [1,2,3,4,5,6,7,8].map(r => `${f}${r}`)).find(s => game.get(s)?.type === 'k' && game.get(s)?.color === game.turn()) : '';
  return `<div class="board" role="grid" aria-label="Chess board">${ranks.map((rank, ri) => files.map((file, fi) => {
    const sq = `${file}${rank}`;
    const piece = game.get(sq);
    const dark = (file.charCodeAt(0) - 97 + rank) % 2 === 0;
    const legal = state.legal.includes(sq);
    const classes = ['square', dark ? 'dark' : 'light', state.selected === sq ? 'selected' : '', last?.from === sq || last?.to === sq ? 'last-move' : '', legal ? 'legal' : '', checkSquare === sq ? 'in-check' : ''].filter(Boolean).join(' ');
    const name = piece ? `${colorName(piece.color)} ${pieceNames[piece.type]}` : 'empty';
    return `<button class="${classes}" data-square="${sq}" role="gridcell" aria-label="${sq}, ${name}" ${state.busy ? 'disabled' : ''}>
      ${fi === 0 ? `<span class="coord rank">${rank}</span>` : ''}${ri === 7 ? `<span class="coord file">${file}</span>` : ''}
      ${piece ? `<span class="piece ${piece.color === 'w' ? 'white-piece' : 'black-piece'}" aria-hidden="true">${glyphs[piece.color + piece.type]}</span>` : legal ? '<span class="move-dot" aria-hidden="true"></span>' : ''}
      ${legal && piece ? '<span class="capture-ring" aria-hidden="true"></span>' : ''}
    </button>`;
  }).join('')).join('')}</div>`;
}
function status() {
  const room = state.room;
  if (!room) return 'Create a room to start playing';
  if (room.status === 'waiting') return 'Waiting for your opponent';
  if (room.status === 'checkmate') return `Checkmate · ${colorName(room.winner)} wins`;
  if (room.status === 'resigned') return `${colorName(room.winner)} wins by resignation`;
  if (room.status === 'stalemate') return 'Draw by stalemate';
  if (room.status === 'draw') return 'Game drawn';
  const game = chess();
  return `${colorName(game.turn())} to move${game.isCheck() ? ' · Check' : ''}`;
}
function statusDescription() {
  const room = state.room;
  if (!room) return 'Create a private room, then invite a friend with a link.';
  if (room.status === 'waiting') return 'Send the link below to a friend. They will play Black.';
  if (room.status !== 'playing') return 'Start a new room for another game.';
  if (!state.color) return 'You are watching this game.';
  return `You're playing ${colorName(state.color)}. ${chess().turn() === state.color ? 'Your move.' : 'Waiting for your opponent.'}`;
}
function playerRow(color, position) {
  const isTurn = state.room?.status === 'playing' && chess().turn() === color;
  const isEmpty = color === 'b' && !state.room?.joined;
  return `<div class="player-row ${isTurn ? 'active-turn' : ''}"><div class="avatar ${color === 'w' ? 'white-avatar' : 'black-avatar'}">${glyphs[color+'n']}</div><div class="player-label"><strong>${isEmpty ? 'Waiting for player' : colorName(color)}</strong><span>${state.color === color ? 'You' : isEmpty ? 'Share the room link' : 'Opponent'}</span></div><span class="player-pos">${position}</span>${isTurn ? '<span class="turn-mark" title="Current turn"></span>' : ''}</div>`;
}
function moveHistory() {
  const moves = state.room?.moves ?? [];
  if (!moves.length) return `<p class="empty-moves">Moves will appear here once the game starts.</p>`;
  let html = '';
  for (let i=0;i<moves.length;i+=2) html += `<div class="move-pair"><span class="move-number">${Math.floor(i/2)+1}.</span><span>${escapeHtml(moves[i].san)}</span><span>${moves[i+1] ? escapeHtml(moves[i+1].san) : ''}</span></div>`;
  return html;
}
function escapeHtml(s) {return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function render() {
  const room = state.room;
  const flipped = state.color === 'b';
  const url = room ? `${location.origin}/room/${room.id}` : '';
  app.innerHTML = `<div class="app-shell">
    <header class="topbar"><a class="brand" href="/" aria-label="Chessroom home"><span class="brand-icon">♞</span><span>chessroom<span class="brand-period">.</span></span></a><span class="topbar-right">PLAY TOGETHER, ANYWHERE <span class="topbar-line"></span> ♙</span></header>
    <main class="main-layout">
      <section class="game-area" aria-label="Game">
        <div class="game-heading"><div><div class="eyebrow">${room ? `ROOM ${room.id}` : 'A GAME BETWEEN FRIENDS'}</div><h1>${room ? 'The board is yours.' : 'Make your move.'}</h1></div><div class="game-indicator"><span class="indicator-orb"></span>${room ? room.status === 'waiting' ? 'Waiting' : room.status === 'playing' ? 'In progress' : 'Finished' : 'New game'}</div></div>
        <div class="board-wrap">
          ${playerRow(flipped ? 'w':'b','TOP')}
          <div class="board-frame">${boardHtml()}</div>
          ${playerRow(flipped ? 'b':'w','BOTTOM')}
        </div>
      </section>
      <aside class="sidebar">
        <div class="panel status-panel"><span class="panel-kicker">MATCH STATUS</span><h2>${escapeHtml(status())}</h2><p>${escapeHtml(statusDescription())}</p>
          ${state.error ? `<div class="message error" role="alert">${escapeHtml(state.error)}</div>` : ''}
          ${state.notice ? `<div class="message" role="status">${escapeHtml(state.notice)}</div>` : ''}
          ${state.loading ? '<div class="loading">Loading room…</div>' : ''}
          ${!room ? `<button class="primary-button" id="create" ${state.busy ? 'disabled':''}>${state.busy ? 'Creating…' : 'Create a game'} <span>↗</span></button>` : ''}
          ${room && !state.color && !room.joined ? `<button class="primary-button" id="join" ${state.busy ? 'disabled':''}>${state.busy ? 'Joining…' : 'Join as Black'} <span>↗</span></button>` : ''}
          ${room && !state.color && room.joined ? '<div class="spectator-note">This room is full. You can watch the game here.</div>' : ''}
          ${room ? `<div class="share-label">INVITE LINK</div><div class="share-row"><input id="share-url" value="${escapeHtml(url)}" readonly aria-label="Invite link" /><button id="copy" title="Copy invite link" aria-label="Copy invite link">COPY</button></div>` : ''}
        </div>
        <div class="panel moves-panel"><div class="panel-head"><span class="panel-kicker">MOVE HISTORY</span><span class="move-count">${room?.moves.length ?? 0} MOVES</span></div><div class="move-list" id="move-list">${moveHistory()}</div></div>
        <div class="sidebar-footer">${room && room.status === 'playing' && state.color ? `<button id="resign" class="quiet-button">Resign game</button><span class="footer-separator">·</span>` : ''}<button id="new" class="quiet-button">New game</button></div>
      </aside>
    </main>
    <footer class="site-footer"><span>CHESSROOM <span class="footer-accent">/</span> TWO PLAYERS. ONE BOARD.</span><span>GOOD LUCK &amp; HAVE FUN</span></footer>
  </div>
  ${state.promotion ? `<div class="modal-backdrop"><div class="promotion-dialog" role="dialog" aria-modal="true" aria-labelledby="promote-title"><h2 id="promote-title">Choose promotion</h2><p>What should your pawn become?</p><div class="promotion-options">${['q','r','b','n'].map(p => `<button data-promotion="${p}" aria-label="Promote to ${pieceNames[p]}">${glyphs[state.color+p]}</button>`).join('')}</div><button class="quiet-button" id="cancel-promotion">Cancel</button></div></div>` : ''}`;
  document.querySelector('#create')?.addEventListener('click', createRoom);
  document.querySelector('#join')?.addEventListener('click', joinRoom);
  document.querySelector('#copy')?.addEventListener('click', async () => {try {await navigator.clipboard.writeText(url); toast('Link copied. Send it to your friend.');} catch {document.querySelector('#share-url').select(); toast('Select and copy the link above.');}});
  document.querySelector('#resign')?.addEventListener('click', resign);
  document.querySelector('#new')?.addEventListener('click', () => {history.pushState({}, '', '/'); state.room = null; state.color = null; state.token = null; state.error = ''; state.notice = ''; state.selected = null; state.legal = []; render();});
  document.querySelectorAll('[data-square]').forEach(el => el.addEventListener('click', () => onSquare(el.dataset.square)));
  document.querySelectorAll('[data-promotion]').forEach(el => el.addEventListener('click', () => sendMove(state.promotion.from, state.promotion.to, el.dataset.promotion)));
  document.querySelector('#cancel-promotion')?.addEventListener('click', () => {state.promotion = null; render();});
  const list = document.querySelector('#move-list'); if (list) list.scrollTop = list.scrollHeight;
}
window.addEventListener('popstate', load);
setInterval(() => {if (state.room && !state.busy) refresh();}, 1800);
load();
