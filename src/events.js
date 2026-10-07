// Server-Sent Events hub. Keeps every connected dashboard in sync in real time
// without adding a WebSocket dependency (and works through HTTP proxies).

const clients = new Set();
let heartbeat = null;

export function clientCount() {
  return clients.size;
}

export function addClient(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no' // stop proxies from buffering the stream
  });
  res.write(': connected\n\n');
  res.write(`event: hello\ndata: ${JSON.stringify({ clients: clients.size + 1 })}\n\n`);
  clients.add(res);

  if (!heartbeat) {
    heartbeat = setInterval(() => {
      for (const client of clients) client.write(': ping\n\n');
    }, 25000);
    heartbeat.unref?.();
  }

  req.on('close', () => {
    clients.delete(res);
    if (clients.size === 0 && heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  });
}

export function broadcast(type, data) {
  if (clients.size === 0) return;
  const frame = `event: ${type}\ndata: ${JSON.stringify(data ?? {})}\n\n`;
  for (const client of clients) {
    try {
      client.write(frame);
    } catch {
      clients.delete(client);
    }
  }
}

export function closeAll() {
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = null;
  for (const client of clients) client.end();
  clients.clear();
}
