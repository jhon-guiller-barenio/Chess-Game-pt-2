<img width="537" height="415" alt="Screenshot 2026-09-23 150114" src="https://github.com/user-attachments/assets/76edee07-af5c-4635-9ad8-a46d83dd8021" />
# Chessroom

A two-player online chess game. White creates a room and shares its URL; Black opens it on another device and joins. Moves are validated on the server using `chess.js`. Rooms live in Upstash Redis for seven days after the latest move.

## Run locally

**Do not double-click `index.html`.** The game needs its local server, and a `file:///C:/...` browser address will show a blank or setup page. Extract the whole ZIP first.

On Windows, install Node.js 20 or newer and double-click `start-windows.bat`. Keep the command window open. The browser will open at `http://localhost:5173`. This runs the game only on your computer for testing; the invite link works across computers after online deployment with shared storage.

Alternatively, run these commands in a terminal:

```bash
npm install
npm run dev
```

Open `http://localhost:5173`, create a game, and open the room URL in a second browser profile on the same computer. Local development uses in-memory game storage; restarting the dev server clears rooms.

## Deploy to Vercel

1. Import this project into Vercel, or log in with the Vercel CLI and run `vercel --prod` from this directory.
2. In Vercel, add the **Upstash for Redis** Marketplace integration to this project. Connect the database to Production and Preview, then redeploy. The app accepts either `KV_REST_API_URL` and `KV_REST_API_TOKEN` or `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`.
3. Open the deployment, create a room, copy the invite link, and have a friend open it on a separate device. The link is a seat invitation; only the first guest can claim Black.

The API deliberately returns a storage configuration error in production if the Redis environment variables are missing. It never falls back to local memory on Vercel, since serverless instances do not share memory.

## Rules and behavior

- Legal moves, castling, en passant, promotion, checkmate, stalemate, insufficient material, repetition, and the 50-move rule use `chess.js` on the server.
- White and Black receive separate secret player tokens stored in their own browser's local storage. Sharing the room link does not share a token.
- The room polls for updates about every 1.8 seconds. One player can refresh and keep their seat on the same browser.
- Rooms expire after seven days of inactivity. If a player clears browser storage, they lose their seat. A room is limited to two players; additional visitors can watch.

Run `npm test` and `npm run build` before deploying.
