// Week 2 WebSocket broadcast server.
//
// One WS server, one channel per instrument: clients connect to
// /stream/:instrumentId. On the same EngineEvent list that drives persistence,
// we emit a trade print for every trade and a refreshed depth snapshot for any
// event that changes book depth (via engine.getSnapshot — full snapshot, no
// hand-rolled diff). Broadcasting is fire-and-forget: a slow or disconnected
// client can never block or slow order processing.

import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { EngineEvent, BookSnapshot } from '../engine/types';

/** Just the slice of the engine the broadcaster needs. */
export interface DepthProvider {
  getSnapshot(instrumentId: string): BookSnapshot;
}

export interface Broadcaster {
  /** Wire to the http server's 'upgrade' event. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  /** Fan out the events from one engine call to subscribed clients. */
  broadcast(events: EngineEvent[]): void;
  close(): Promise<void>;
}

export function createBroadcaster(depth: DepthProvider): Broadcaster {
  const wss = new WebSocketServer({ noServer: true });
  const subscribers = new Map<string, Set<WebSocket>>(); // instrumentId -> clients

  function subscribe(instrumentId: string, ws: WebSocket): void {
    let set = subscribers.get(instrumentId);
    if (!set) {
      set = new Set();
      subscribers.set(instrumentId, set);
    }
    set.add(ws);
    ws.on('close', () => {
      const s = subscribers.get(instrumentId);
      if (s) {
        s.delete(ws);
        if (s.size === 0) subscribers.delete(instrumentId);
      }
    });
  }

  function sendTo(instrumentId: string, payload: unknown): void {
    const set = subscribers.get(instrumentId);
    if (!set || set.size === 0) return;
    const data = JSON.stringify(payload);
    for (const ws of set) {
      // Fire-and-forget: never awaited. ws buffers internally, so a slow client
      // cannot back-pressure onto order processing.
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    }
  }

  return {
    handleUpgrade(req, socket, head) {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const match = url.pathname.match(/^\/stream\/([^/]+)$/);
      if (!match) {
        socket.destroy();
        return;
      }
      const instrumentId = decodeURIComponent(match[1]);
      wss.handleUpgrade(req, socket, head, (ws) => subscribe(instrumentId, ws));
    },

    broadcast(events) {
      // A trade print goes out immediately; depth-changing events are collected
      // and flushed as one snapshot per affected instrument (a partial fill
      // emits only a `trade`, which still changes depth — so trades count too).
      const depthChanged = new Set<string>();
      for (const event of events) {
        if (event.type === 'trade') {
          const t = event.trade;
          sendTo(t.instrumentId, {
            type: 'trade',
            instrumentId: t.instrumentId,
            price: t.price,
            quantity: t.quantity,
            timestamp: Date.now(),
          });
          depthChanged.add(t.instrumentId);
        } else if (
          event.type === 'order_resting' ||
          event.type === 'order_filled' ||
          event.type === 'order_cancelled'
        ) {
          depthChanged.add(event.order.instrumentId);
        }
        // order_rejected: nothing to broadcast.
      }
      for (const instrumentId of depthChanged) {
        const snapshot = depth.getSnapshot(instrumentId);
        sendTo(instrumentId, {
          type: 'depth',
          instrumentId,
          bids: snapshot.bids,
          asks: snapshot.asks,
        });
      }
    },

    close() {
      return new Promise<void>((resolve) => {
        for (const set of subscribers.values()) {
          for (const ws of set) ws.close();
        }
        subscribers.clear();
        wss.close(() => resolve());
      });
    },
  };
}
