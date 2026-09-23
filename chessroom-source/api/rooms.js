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
async function getRoom(roomId) {
  const raw = dev ? memory.get(roomId) : await redis('GET', roomKey(roomId));
  return raw ? JSON.parse(raw) : null;
}
async function createRoom(room) {
  if (dev) { if (memory.has(room.id)) return false; memory.set(room.id, JSON.stringify(room)); return true; }
  return await redis('SET', roomKey(room.id), JSON.stringify(room), 'NX', 'EX', TTL) === 'OK';
}
const CAS = `local old=redis.call('GET', KEYS[1]); if not old then return -1 end; if old ~= ARGV[1] then return 0 end; redis.call('SET',KEYS[1],ARGV[2],'EX',ARGV[3]); return 1`;
async function updateRoom(before, after) {
  if (dev) { if (memory.get(before.id) !== JSON.stringify(before)) return false; memory.set(before.id, JSON.stringify(after)); return true; }
  return await redis('EVAL', CAS, 1, roomKey(before.id), JSON.stringify(before), JSON.stringify(after), TTL) === 1;
}
function publicRoom(room) {
  return {id: room.id, fen: room.fen, moves: room.moves, status: room.status, winner: room.winner, joined: Boolean(room.black), version: room.version, updatedAt: room.updatedAt};
}
function json(data, status = 200) { return new Response(JSON.stringify(data), {status, headers: {'Content-Type': 'application/json', 'Cache-Control': 'no-store'}}); }
function err(message, status) { return json({error: message}, status); }

export async function GET(request) {
  try {
    const roomId = new URL(request.url).searchParams.get('id')?.toUpperCase();
    if (!ID_RE.test(roomId ?? '')) return err('Invalid room link.', 400);
    const room = await getRoom(roomId);
    return room ? json({room: publicRoom(room)}) : err('Room not found or expired.', 404);
  } catch (e) { return err(e.message, 503); }
}
export async function POST(request) {
  try {
    let body;
    try { body = await request.json(); } catch { return err('Invalid request.', 400); }
    const {action, roomId: requestedId, playerToken, from, to, promotion, version} = body ?? {};
    if (action === 'create') {
      for (let tries = 0; tries < 5; tries++) {
        const roomId = id();
        const white = token();
        const room = {id: roomId, fen: new Chess().fen(), moves: [], status: 'waiting', winner: null, white, black: null, version: 0, updatedAt: Date.now()};
        if (await createRoom(room)) return json({room: publicRoom(room), color: 'w', playerToken: white}, 201);
      }
      return err('Could not create a room. Try again.', 503);
    }
    const roomId = typeof requestedId === 'string' ? requestedId.toUpperCase() : '';
    if (!ID_RE.test(roomId)) return err('Invalid room link.', 400);
    const room = await getRoom(roomId);
    if (!room) return err('Room not found or expired.', 404);
    if (action === 'join') {
      if (room.black) return err('This room already has two players.', 409);
      const black = token();
      const next = {...room, black, status: 'playing', version: room.version + 1, updatedAt: Date.now()};
      if (!await updateRoom(room, next)) return err('Someone joined first. Refresh the room.', 409);
      return json({room: publicRoom(next), color: 'b', playerToken: black});
    }
    const color = equal(playerToken, room.white) ? 'w' : equal(playerToken, room.black) ? 'b' : null;
    if (!color) return err('You are not a player in this room.', 403);
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
      const next = {...room, fen: game.fen(), moves: [...room.moves, {san: move.san, from: move.from, to: move.to, color, promotion: move.promotion ?? null}], status, winner: status === 'checkmate' ? color : null, version: room.version + 1, updatedAt: Date.now()};
      if (!await updateRoom(room, next)) return err('The board changed. Try your move again.', 409);
      return json({room: publicRoom(next)});
    }
    if (action === 'resign') {
      if (room.status !== 'playing') return err('The game is not in progress.', 409);
      const next = {...room, status: 'resigned', winner: color === 'w' ? 'b' : 'w', version: room.version + 1, updatedAt: Date.now()};
      if (!await updateRoom(room, next)) return err('The board changed. Refresh the room.', 409);
      return json({room: publicRoom(next)});
    }
    return err('Unknown action.', 400);
  } catch (e) { return err(e.message, 503); }
}

export default async function handler(req, res) {
  const url = new URL(req.url, `https://${req.headers.host || 'localhost'}`);
  const input = req.method === 'GET' ? new Request(url) : {json: async () => req.body};
  const output = req.method === 'GET' ? await GET(input) : req.method === 'POST' ? await POST(input) : err('Method not allowed.', 405);
  res.status(output.status);
  output.headers.forEach((value, key) => res.setHeader(key, value));
  res.send(await output.text());
}
