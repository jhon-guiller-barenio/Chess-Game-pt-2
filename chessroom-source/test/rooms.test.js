import test from 'node:test';
import assert from 'node:assert/strict';
import {Chess} from 'chess.js';
import {GET, POST} from '../api/rooms.js';
const call = async (body) => {const response = await POST(new Request('http://localhost/api/rooms', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)})); return {status:response.status, data:await response.json()};};

test('two remote clients join, alternate legal moves, and finish a game', async () => {
  const created = await call({action:'create'});
  assert.equal(created.status, 201);
  const {room, playerToken:white} = created.data;
  const creatorColor = created.data.color;
  const fetched = await GET(new Request(`http://localhost/api/rooms?id=${room.id}`));
  assert.equal((await fetched.json()).room.status, 'waiting');
  const joined = await call({action:'join', roomId:room.id});
  assert.equal(joined.status, 200);
  const black = joined.data.playerToken;
  assert.equal(['w','b'].includes(creatorColor), true);
  assert.equal(joined.data.color, creatorColor === 'w' ? 'b' : 'w');
  const playerForColor = color => color === creatorColor ? white : black;
  assert.equal((await call({action:'join', roomId:room.id})).status, 409);
  assert.equal((await call({action:'move', roomId:room.id, playerToken:playerForColor('b'), from:'e7', to:'e5', version:1})).status, 409);
  assert.equal((await call({action:'move', roomId:room.id, playerToken:playerForColor('w'), from:'e2', to:'e5', version:1})).status, 400);
  assert.equal((await call({action:'move', roomId:room.id, playerToken:'f'.repeat(48), from:'e2', to:'e4', version:1})).status, 403);
  let version = 1;
  const moves = [['w','f2','f3'],['b','e7','e5'],['w','g2','g4'],['b','d8','h4']];
  for (const [color, from, to] of moves) {
    const result = await call({action:'move', roomId:room.id, playerToken:playerForColor(color), from,to,version});
    assert.equal(result.status, 200, JSON.stringify(result.data));
    version = result.data.room.version;
  }
  const end = await GET(new Request(`http://localhost/api/rooms?id=${room.id}`));
  const result = (await end.json()).room;
  assert.equal(result.status, 'checkmate');
  assert.equal(result.winner, 'b');
  assert.equal(result.moves.at(-1).san, 'Qh4#');
  assert.equal((await call({action:'move', roomId:room.id, playerToken:playerForColor('w'), from:'a2', to:'a3', version})).status, 409);
});

test('simultaneous joins only grant one second-player seat', async () => {
  const {data:{room}} = await call({action:'create'});
  const results = await Promise.all([call({action:'join', roomId:room.id}),call({action:'join', roomId:room.id})]);
  assert.deepEqual(results.map(x=>x.status).sort(), [200,409]);
});

test('rematch challenges stay in the room and acceptance resets the board', async () => {
  const {data:{room:created,playerToken:white}} = await call({action:'create'});
  const {data:{playerToken:black}} = await call({action:'join',roomId:created.id});
  const firstWhitePlayer = created.whitePlayer;
  const tokenForRole = role => role === 'one' ? white : black;
  const firstWhiteToken = tokenForRole(firstWhitePlayer);
  const firstBlackToken = tokenForRole(firstWhitePlayer === 'one' ? 'two' : 'one');
  const creatorColor = firstWhitePlayer === 'one' ? 'w' : 'b';
  assert.equal((await call({action:'challenge',roomId:created.id,playerToken:white})).status,409);
  let version = 1;
  for (const [color,from,to] of [['w','f2','f3'],['b','e7','e5'],['w','g2','g4'],['b','d8','h4']]) {
    const result = await call({action:'move',roomId:created.id,playerToken:color === 'w' ? firstWhiteToken:firstBlackToken,from,to,version});
    assert.equal(result.status,200);
    version = result.data.room.version;
  }

  const challenged = await call({action:'challenge',roomId:created.id,playerToken:white});
  assert.equal(challenged.status,200);
  assert.deepEqual(challenged.data.room.rematch,{offeredBy:creatorColor});
  const challengerToken = white;
  const acceptingToken = black;
  assert.equal((await call({action:'accept_rematch',roomId:created.id,playerToken:challengerToken})).status,403);
  const accepted = await call({action:'accept_rematch',roomId:created.id,playerToken:acceptingToken});
  assert.equal(accepted.status,200);
  assert.equal(accepted.data.room.id,created.id);
  assert.equal(accepted.data.room.status,'playing');
  assert.equal(accepted.data.room.winner,null);
  assert.equal(accepted.data.room.rematch,null);
  assert.deepEqual(accepted.data.room.moves,[]);
  assert.equal(accepted.data.room.fen,new Chess().fen());
  assert.equal(accepted.data.room.joined,true);
  assert.deepEqual(accepted.data.room.clocks,{one:accepted.data.room.clockMs,two:accepted.data.room.clockMs});
  assert.ok(accepted.data.room.clockStartedAt);
  assert.equal(accepted.data.room.whitePlayer, firstWhitePlayer === 'one' ? 'two' : 'one');
  assert.equal(accepted.data.color, accepted.data.room.whitePlayer === 'one' ? 'b' : 'w');
  const colorFor = async playerToken => {
    const response = await GET(new Request(`http://localhost/api/rooms?id=${created.id}`, {headers:{'x-player-token':playerToken}}));
    return (await response.json()).color;
  };
  assert.equal(await colorFor(white), firstWhitePlayer === 'one' ? 'b' : 'w');
  assert.equal(await colorFor(black), firstWhitePlayer === 'one' ? 'w' : 'b');
  const nextWhiteToken = tokenForRole(accepted.data.room.whitePlayer);
  const nextBlackToken = tokenForRole(accepted.data.room.whitePlayer === 'one' ? 'two' : 'one');
  assert.equal((await call({action:'move',roomId:created.id,playerToken:nextBlackToken,from:'e2',to:'e4',version:accepted.data.room.version})).status,409);
  assert.equal((await call({action:'move',roomId:created.id,playerToken:nextWhiteToken,from:'e2',to:'e4',version:accepted.data.room.version})).status,200);
});

test('the challenged player may decline and a new challenge can then be sent', async () => {
  const {data:{room,playerToken:white}} = await call({action:'create'});
  const {data:{playerToken:black}} = await call({action:'join',roomId:room.id});
  // Resigning provides a short legal path to a finished room.
  await call({action:'resign',roomId:room.id,playerToken:white});
  const offered = await call({action:'challenge',roomId:room.id,playerToken:white});
  assert.equal(offered.status,200);
  assert.equal((await call({action:'decline_rematch',roomId:room.id,playerToken:black})).status,200);
  assert.equal((await call({action:'challenge',roomId:room.id,playerToken:black})).status,200);
});

test('the selected chess clock runs for the active player and flags timeout', async () => {
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    const created = await call({action:'create',timeMinutes:2});
    assert.equal(created.data.room.clockMs,120_000);
    assert.deepEqual(created.data.room.clocks,{one:120_000,two:120_000});
    const joined = await call({action:'join',roomId:created.data.room.id});
    const roomId = created.data.room.id;
    const whiteRole = created.data.room.whitePlayer;
    const whiteToken = created.data.color === 'w' ? created.data.playerToken : joined.data.playerToken;
    now += 2_500;
    const moved = await call({action:'move',roomId,playerToken:whiteToken,from:'e2',to:'e4',version:joined.data.room.version});
    assert.equal(moved.status,200);
    assert.equal(moved.data.room.clocks[whiteRole],117_500);
    assert.equal(moved.data.room.clocks[whiteRole === 'one' ? 'two' : 'one'],120_000);
    const activeRole = whiteRole === 'one' ? 'two' : 'one';
    now += 120_001;
    const response = await GET(new Request(`http://localhost/api/rooms?id=${roomId}`));
    const expired = (await response.json()).room;
    assert.equal(expired.status,'timeout');
    assert.equal(expired.clocks[activeRole],0);
    assert.equal(expired.winner,'w');
    assert.equal(moved.data.room.clockStartedAt,1_002_500);
  } finally {
    Date.now = realNow;
  }
});
