import { defineConfig } from 'vite';
import { GET, POST } from './api/rooms.js';
export default defineConfig({plugins: [{name: 'local-api', configureServer(server) {
  server.middlewares.use('/api/rooms', async (req, res) => {
    try {
      let result;
      if (req.method === 'GET') result = await GET(new Request(`http://localhost${req.url}`));
      else if (req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += chunk;
        result = await POST(new Request('http://localhost/api/rooms', {method:'POST', headers:{'Content-Type':'application/json'}, body}));
      } else result = new Response('Method not allowed', {status:405});
      res.statusCode = result.status;
      result.headers.forEach((value,key) => res.setHeader(key,value));
      res.end(await result.text());
    } catch (e) {res.statusCode = 500; res.end(JSON.stringify({error:e.message}));}
  });
}}]});
