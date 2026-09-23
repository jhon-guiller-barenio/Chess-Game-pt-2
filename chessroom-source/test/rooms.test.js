import test from 'node:test';
import assert from 'node:assert/strict';
import {GET, POST} from '../api/rooms.js';
const call = async (body) => {const response = await POST(new Request('http://localhost/api/rooms', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)})); return {status:response.status, data:await response.json()};};

test('two remote clients join, alternate legal moves, and finish a game', async () => {
  const created = await call({action:'create'});
  assert.equal(created.status, 201);
  const {room, playerToken:white} = created.data;
  const fetched = await GET(new Request(`http://localhost/api/rooms?id=${room.id}`));
  assert.equal((await fetched.json()).room.status, 'waiting');
  const joined = await call({action:'join', roomId:room.id});
  assert.equal(joined.status, 200);
  const black = joined.data.playerToken;
  assert.equal((await call({action:'join', roomId:room.id})).status, 409);
  assert.equal((await call({action:'move', roomId:room.id, playerToken:black, from:'e7', to:'e5', version:1})).status, 409);
  assert.equal((await call({action:'move', roomId:room.id, playerToken:white, from:'e2', to:'e5', version:1})).status, 400);
  assert.equal((await call({action:'move', roomId:room.id, playerToken:'f'.repeat(48), from:'e2', to:'e4', version:1})).status, 403);
  let version = 1;
  const moves = [['w','f2','f3'],['b','e7','e5'],['w','g2','g4'],['b','d8','h4']];
  for (const [color, from, to] of moves) {
    const result = await call({action:'move', roomId:room.id, playerToken:color === 'w' ? white:black, from,to,version});
    assert.equal(result.status, 200, JSON.stringify(result.data));
    version = result.data.room.version;
  }
  const end = await GET(new Request(`http://localhost/api/rooms?id=${room.id}`));
  const result = (await end.json()).room;
  assert.equal(result.status, 'checkmate');
  assert.equal(result.winner, 'b');
  assert.equal(result.moves.at(-1).san, 'Qh4#');
  assert.equal((await call({action:'move', roomId:room.id, playerToken:white, from:'a2', to:'a3', version})).status, 409);
});

test('simultaneous joins only grant one black seat', async () => {
  const {data:{room}} = await call({action:'create'});
  const results = await Promise.all([call({action:'join', roomId:room.id}),call({action:'join', roomId:room.id})]);
  assert.deepEqual(results.map(x=>x.status).sort(), [200,409]);
});
