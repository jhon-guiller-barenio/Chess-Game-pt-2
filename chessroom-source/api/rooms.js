import { Chess } from 'chess.js';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const TTL = 60 * 60 * 24 * 7;
const ID_RE = /^[A-Z2-9]{8}$/;
const TOKEN_RE = /^[a-f0-9]{48}$/;
const memory = new Map();
const dev = process.env.NODE_ENV !== 'production' && !process.env.VERCEL;
const roomKey = (id) => `chessroom:v1:${id}`;
const token = () => randomBytes(24).toString('hex');
const id = () => randomBytes(6).toString('base64url').toUpperCase().replace(/[^A-Z2-9]/g, '').padEnd(8, 'K').slice(0, 8);
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && TOKEN_RE.test(a) && TOKEN_RE.test(b) && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));

export function findRedisCredentials(env = process.env) {
  const names = ['UPSTASH_REDIS_REST_URL', 'KV_REST_API_URL',
    ...Object.keys(env).filter(name => name.endsWith('_REST_API_URL') || name.endsWith('_REST_URL'))];
  for (const urlName of new Set(names)) {
    const tokenName = urlName.replace(/_URL$/, '_TOKEN');
    if (env[urlName] && env[tokenName]) return {url: env[urlName], token: env[tokenName]};
  }
  return null;
}

async function redis(...args) {
  const credentials = findRedisCredentials();
  if (!credentials) throw new Error('Game storage is not configured. Check the Redis environment variables in this Vercel project.');
  const response = await fetch(credentials.url, {method: 'POST', headers: {'Authorization': `Bearer ${credentials.token}`, 'Content-Type': 'application/json'}, body: JSON.stringify(args)});
  if (!response.ok) throw new Error(`Game storage unavailable (${response.status}).`);
  const data = await response.json();
  if (data.error) throw new Error(`Game storage error: ${data.error}`);
  return data.result;
}
function normalizeRoom(room) {
  // Existing rooms stored before color rotation use the original white/black token fields.
  const normalized = room.playerOne ? room : {...room, playerOne: room.white, playerTwo: room.black, whitePlayer: 'one'};
  const clockMs = normalized.clockMs || 5 * 60 * 1000;
  return {...normalized, clockMs, clocks: normalized.clocks || {one: clockMs, two: clockMs}, clockStartedAt: normalized.clockStartedAt ?? null};
}
async function getRoom(roomId) {
  const raw = dev ? memory.get(roomId) : await redis('GET', roomKey(roomId));
  if (!raw) return null;
  const room = JSON.parse(raw);
  if (room.playerOne && room.clocks && room.clockMs) return room;
  const migrated = normalizeRoom(room);
  if (dev) memory.set(roomId, JSON.stringify(migrated));
  else if (await redis('EVAL', MIGRATE, 1, roomKey(roomId), raw, JSON.stringify(migrated), TTL) !== 1) return getRoom(roomId);
  return migrated;
}
async function createRoom(room) {
  if (dev) { if (memory.has(room.id)) return false; memory.set(room.id, JSON.stringify(room)); return true; }
  return await redis('SET', roomKey(room.id), JSON.stringify(room), 'NX', 'EX', TTL) === 'OK';
}
const CAS = `local old=redis.call('GET', KEYS[1]); if not old then return -1 end; if old ~= ARGV[1] then return 0 end; redis.call('SET',KEYS[1],ARGV[2],'EX',ARGV[3]); return 1`;
const MIGRATE = `local old=redis.call('GET', KEYS[1]); if old ~= ARGV[1] then return 0 end; redis.call('SET',KEYS[1],ARGV[2],'EX',ARGV[3]); return 1`;
async function updateRoom(before, after) {
  if (dev) { if (memory.get(before.id) !== JSON.stringify(before)) return false; memory.set(before.id, JSON.stringify(after)); return true; }
  return await redis('EVAL', CAS, 1, roomKey(before.id), JSON.stringify(before), JSON.stringify(after), TTL) === 1;
}
function publicRoom(room) {
  return {id: room.id, fen: room.fen, moves: room.moves, status: room.status, winner: room.winner, rematch: room.rematch ?? null, joined: Boolean(room.playerTwo), whitePlayer: room.whitePlayer, clockMs: room.clockMs, clocks: clockSnapshot(room), clockStartedAt: room.clockStartedAt, version: room.version, updatedAt: room.updatedAt};
}
const playerIdFor = (room, playerToken) => equal(playerToken, room.playerOne) ? 'one' : equal(playerToken, room.playerTwo) ? 'two' : null;
const colorFor = (room, playerId) => (room.whitePlayer === playerId ? 'w' : 'b');
const roleForColor = (room, color) => colorFor(room, 'one') === color ? 'one' : 'two';
function clockSnapshot(room, now = Date.now()) {
  const clocks = {...room.clocks};
  if (room.status === 'playing' && room.clockStartedAt) {
    const role = roleForColor(room, new Chess(room.fen).turn());
    clocks[role] = Math.max(0, clocks[role] - (now - room.clockStartedAt));
  }
  return clocks;
}
async function settleClock(room, now = Date.now()) {
  if (room.status !== 'playing' || !room.clockStartedAt) return room;
  const role = roleForColor(room, new Chess(room.fen).turn());
  if (room.clocks[role] - (now - room.clockStartedAt) > 0) return room;
  const status = new Chess(room.fen).isInsufficientMaterial() ? 'draw' : 'timeout';
  const winner = status === 'timeout' ? colorFor(room, role === 'one' ? 'two' : 'one') : null;
  const next = {...room, clocks: {...room.clocks, [role]: 0}, clockStartedAt: null, status, winner, version: room.version + 1, updatedAt: now};
  if (await updateRoom(room, next)) return next;
  return await getRoom(room.id);
}
const finished = (status) => ['checkmate', 'stalemate', 'draw', 'resigned', 'timeout'].includes(status);
function json(data, status = 200) { return new Response(JSON.stringify(data), {status, headers: {'Content-Type': 'application/json', 'Cache-Control': 'no-store'}}); }
function err(message, status) { return json({error: message}, status); }

export async function GET(request) {
  try {
    const roomId = new URL(request.url).searchParams.get('id')?.toUpperCase();
    if (!ID_RE.test(roomId ?? '')) return err('Invalid room link.', 400);
    let room = await getRoom(roomId);
    if (!room) return err('Room not found or expired.', 404);
    room = await settleClock(room);
    const playerId = playerIdFor(room, request.headers.get('x-player-token'));
    return json({room: publicRoom(room), ...(playerId ? {color: colorFor(room, playerId), playerId} : {})});
  } catch (e) { return err(e.message, 503); }
}
export async function POST(request) {
  try {
    let body;
    try { body = await request.json(); } catch { return err('Invalid request.', 400); }
    const {action, roomId: requestedId, playerToken, from, to, promotion, version, timeMinutes} = body ?? {};
    if (action === 'create') {
      for (let tries = 0; tries < 5; tries++) {
        const roomId = id();
        const playerOne = token();
        const whitePlayer = Math.random() < 0.5 ? 'one' : 'two';
        const clockMs = ([2,5,10].includes(Number(timeMinutes)) ? Number(timeMinutes) : 5) * 60 * 1000;
        const room = {id: roomId, fen: new Chess().fen(), moves: [], status: 'waiting', winner: null, rematch: null, playerOne, playerTwo: null, whitePlayer, clockMs, clocks: {one:clockMs,two:clockMs}, clockStartedAt: null, version: 0, updatedAt: Date.now()};
        if (await createRoom(room)) return json({room: publicRoom(room), color: colorFor(room, 'one'), playerId: 'one', playerToken: playerOne}, 201);
      }
      return err('Could not create a room. Try again.', 503);
    }
    const roomId = typeof requestedId === 'string' ? requestedId.toUpperCase() : '';
    if (!ID_RE.test(roomId)) return err('Invalid room link.', 400);
    let room = await getRoom(roomId);
    if (!room) return err('Room not found or expired.', 404);
    room = await settleClock(room);
    if (action === 'join') {
      if (room.playerTwo) return err('This room already has two players.', 409);
      const playerTwo = token();
      const startedAt = Date.now();
      const next = {...room, playerTwo, status: 'playing', clockStartedAt: startedAt, version: room.version + 1, updatedAt: startedAt};
      if (!await updateRoom(room, next)) return err('Someone joined first. Refresh the room.', 409);
      return json({room: publicRoom(next), color: colorFor(next, 'two'), playerId: 'two', playerToken: playerTwo});
    }
    const playerId = playerIdFor(room, playerToken);
    if (!playerId) return err('You are not a player in this room.', 403);
    const color = colorFor(room, playerId);
    if (action === 'challenge') {
      if (!finished(room.status)) return err('A rematch can only be offered after the game ends.', 409);
      if (room.rematch) return err('A rematch challenge is already waiting for a response.', 409);
      const next = {...room, rematch: {offeredBy: color}, version: room.version + 1, updatedAt: Date.now()};
      if (!await updateRoom(room, next)) return err('The room changed. Try again.', 409);
      return json({room: publicRoom(next)});
    }
    if (action === 'accept_rematch') {
      if (!finished(room.status) || !room.rematch) return err('There is no rematch challenge to accept.', 409);
      if (room.rematch.offeredBy === color) return err('Your opponent needs to accept the challenge.', 403);
      const startedAt = Date.now();
      const next = {...room, fen: new Chess().fen(), moves: [], status: 'playing', winner: null, rematch: null, whitePlayer: room.whitePlayer === 'one' ? 'two' : 'one', clocks: {one:room.clockMs,two:room.clockMs}, clockStartedAt: startedAt, version: room.version + 1, updatedAt: startedAt};
      if (!await updateRoom(room, next)) return err('The room changed. Try again.', 409);
      return json({room: publicRoom(next), color: colorFor(next, playerId), playerId});
    }
    if (action === 'decline_rematch') {
      if (!finished(room.status) || !room.rematch) return err('There is no rematch challenge to decline.', 409);
      if (room.rematch.offeredBy === color) return err('Only your opponent can decline this challenge.', 403);
      const next = {...room, rematch: null, version: room.version + 1, updatedAt: Date.now()};
      if (!await updateRoom(room, next)) return err('The room changed. Try again.', 409);
      return json({room: publicRoom(next)});
    }
    if (action === 'move') {
      if (room.status !== 'playing') return err('The game is not in progress.', 409);
      if (room.version !== version) return err('The board changed. Try your move again.', 409);
      const game = new Chess();
      for (const previous of room.moves) game.move(previous.san);
      if (game.turn() !== color) return err('Wait for your turn.', 409);
      if (!/^[a-h][1-8]$/.test(from ?? '') || !/^[a-h][1-8]$/.test(to ?? '')) return err('Invalid square.', 400);
      let move;
      try { move = game.move({from, to, promotion: /^[qrbn]$/.test(promotion ?? '') ? promotion : 'q'}); } catch { return err('That move is not legal.', 400); }
      if (!move) return err('That move is not legal.', 400);
      const status = game.isCheckmate() ? 'checkmate' : game.isStalemate() ? 'stalemate' : game.isThreefoldRepetition() ? 'draw' : game.isInsufficientMaterial() ? 'draw' : game.isDraw() ? 'draw' : 'playing';
      const movedAt = Date.now();
      const remaining = room.clocks[playerId] - Math.max(0, movedAt - room.clockStartedAt);
      if (remaining <= 0) {
        const expired = await settleClock(room, movedAt);
        return json({room: publicRoom(expired)});
      }
      const next = {...room, fen: game.fen(), moves: [...room.moves, {san: move.san, from: move.from, to: move.to, color, promotion: move.promotion ?? null}], status, winner: status === 'checkmate' ? color : null, clocks: {...room.clocks, [playerId]: remaining}, clockStartedAt: status === 'playing' ? movedAt : null, version: room.version + 1, updatedAt: movedAt};
      if (!await updateRoom(room, next)) return err('The board changed. Try your move again.', 409);
      return json({room: publicRoom(next)});
    }
    if (action === 'resign') {
      if (room.status !== 'playing') return err('The game is not in progress.', 409);
      const next = {...room, status: 'resigned', winner: color === 'w' ? 'b' : 'w', clockStartedAt: null, version: room.version + 1, updatedAt: Date.now()};
      if (!await updateRoom(room, next)) return err('The board changed. Refresh the room.', 409);
      return json({room: publicRoom(next)});
    }
    return err('Unknown action.', 400);
  } catch (e) { return err(e.message, 503); }
}

export default async function handler(req, res) {
  const url = new URL(req.url, `https://${req.headers.host || 'localhost'}`);
  const input = req.method === 'GET' ? new Request(url, {headers: {'x-player-token': req.headers['x-player-token'] || ''}}) : {json: async () => req.body};
  const output = req.method === 'GET' ? await GET(input) : req.method === 'POST' ? await POST(input) : err('Method not allowed.', 405);
  res.status(output.status);
  output.headers.forEach((value, key) => res.setHeader(key, value));
  res.send(await output.text());
}
