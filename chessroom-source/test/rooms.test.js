import test from 'node:test';
import assert from 'node:assert/strict';
import {Chess} from 'chess.js';
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
  const creatorSync = await call({action:'sync',roomId:room.id,playerToken:white});
  assert.equal(creatorSync.status,200);
  const tokenForColor = {[creatorSync.data.color]:white,[joined.data.color]:joined.data.playerToken};
  assert.notEqual(creatorSync.data.color,joined.data.color);
  assert.equal((await call({action:'join', roomId:room.id})).status, 409);
  assert.equal((await call({action:'move', roomId:room.id, playerToken:tokenForColor.b, from:'e7', to:'e5', version:1})).status, 409);
  assert.equal((await call({action:'move', roomId:room.id, playerToken:tokenForColor.w, from:'e2', to:'e5', version:1})).status, 400);
  assert.equal((await call({action:'move', roomId:room.id, playerToken:'f'.repeat(48), from:'e2', to:'e4', version:1})).status, 403);
  let version = 1;
  const moves = [['w','f2','f3'],['b','e7','e5'],['w','g2','g4'],['b','d8','h4']];
  for (const [color, from, to] of moves) {
    const result = await call({action:'move', roomId:room.id, playerToken:tokenForColor[color], from,to,version});
    assert.equal(result.status, 200, JSON.stringify(result.data));
    version = result.data.room.version;
  }
  const end = await GET(new Request(`http://localhost/api/rooms?id=${room.id}`));
  const result = (await end.json()).room;
  assert.equal(result.status, 'checkmate');
  assert.equal(result.winner, 'b');
  assert.equal(result.moves.at(-1).san, 'Qh4#');
  assert.equal((await call({action:'move', roomId:room.id, playerToken:tokenForColor.w, from:'a2', to:'a3', version})).status, 409);
});

test('simultaneous joins only grant one black seat', async () => {
  const {data:{room}} = await call({action:'create'});
  const results = await Promise.all([call({action:'join', roomId:room.id}),call({action:'join', roomId:room.id})]);
  assert.deepEqual(results.map(x=>x.status).sort(), [200,409]);
});

test('rematch challenges stay in the room and acceptance resets the board', async () => {
  const {data:{room:created,playerToken:white}} = await call({action:'create'});
  const {data:{playerToken:black,color:blackInitialColor}} = await call({action:'join',roomId:created.id});
  const {data:{color:whiteInitialColor}} = await call({action:'sync',roomId:created.id,playerToken:white});
  const tokenForColor = {[whiteInitialColor]:white,[blackInitialColor]:black};
  assert.notEqual(whiteInitialColor,blackInitialColor);
  assert.equal((await call({action:'challenge',roomId:created.id,playerToken:white})).status,409);
  let version = 1;
  for (const [color,from,to] of [['w','f2','f3'],['b','e7','e5'],['w','g2','g4'],['b','d8','h4']]) {
    const result = await call({action:'move',roomId:created.id,playerToken:tokenForColor[color],from,to,version});
    assert.equal(result.status,200);
    version = result.data.room.version;
  }

  const challengerToken = tokenForColor.b;
  const challenged = await call({action:'challenge',roomId:created.id,playerToken:challengerToken});
  assert.equal(challenged.status,200);
  assert.deepEqual(challenged.data.room.rematch,{offeredBy:'b'});
  const responderToken = tokenForColor.w;
  assert.equal((await call({action:'accept_rematch',roomId:created.id,playerToken:challengerToken})).status,403);
  const accepted = await call({action:'accept_rematch',roomId:created.id,playerToken:responderToken});
  assert.equal(accepted.status,200);
  assert.equal(accepted.data.room.id,created.id);
  assert.equal(accepted.data.room.status,'playing');
  assert.equal(accepted.data.room.winner,null);
  assert.equal(accepted.data.room.rematch,null);
  assert.deepEqual(accepted.data.room.moves,[]);
  assert.equal(accepted.data.room.fen,new Chess().fen());
  assert.equal(accepted.data.room.joined,true);
  assert.ok(['w','b'].includes(accepted.data.color));
  const challengerSync = await call({action:'sync',roomId:created.id,playerToken:challengerToken});
  assert.notEqual(challengerSync.data.color,accepted.data.color);
});

test('the challenged player may decline and a new challenge can then be sent', async () => {
  const {data:{room,playerToken:white}} = await call({action:'create'});
  const {data:{playerToken:black,color:blackColor}} = await call({action:'join',roomId:room.id});
  const {data:{color:whiteColor}} = await call({action:'sync',roomId:room.id,playerToken:white});
  const tokenForColor = {[whiteColor]:white,[blackColor]:black};
  assert.notEqual(whiteColor,blackColor);
  // Resigning provides a short legal path to a finished room.
  await call({action:'resign',roomId:room.id,playerToken:tokenForColor.w});
  const offered = await call({action:'challenge',roomId:room.id,playerToken:tokenForColor.w});
  assert.equal(offered.status,200);
  assert.equal((await call({action:'decline_rematch',roomId:room.id,playerToken:tokenForColor.b})).status,200);
  assert.equal((await call({action:'challenge',roomId:room.id,playerToken:tokenForColor.b})).status,200);
});
