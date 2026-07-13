// Week 2 composition root: wire the engine, the persistence layer, and the WS
// broadcaster together behind one http server, and bind it to loopback only.

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MatchingEngine } from './engine/matchingEngine';
import { createHttpServer } from './http/server';
import { createBroadcaster } from './ws/broadcaster';
import type { Db } from './db/persistence';

// Internal endpoints are never publicly exposed — always loopback, never
// 0.0.0.0. Laravel is the only caller, over 127.0.0.1 on the same box.
const LOOPBACK = '127.0.0.1';

export interface App {
  server: Server;
  engine: MatchingEngine;
  listen(port: number): Promise<{ host: string; port: number }>;
  close(): Promise<void>;
}

export interface AppOptions {
  db: Db;
  /** Reuse an already-bootstrapped engine; otherwise one is created. */
  engine?: MatchingEngine;
  /** Seed value for a freshly created engine (see readNextSequence). */
  startSequence?: number;
}

export function createApp(opts: AppOptions): App {
  const engine = opts.engine ?? new MatchingEngine(opts.startSequence ?? 1);
  const broadcaster = createBroadcaster(engine);
  const server = createHttpServer({
    engine,
    db: opts.db,
    broadcast: broadcaster.broadcast,
  });
  // WebSocket upgrades ride the same server; one channel per instrument.
  server.on('upgrade', broadcaster.handleUpgrade);

  return {
    server,
    engine,
    listen(port) {
      return new Promise((resolve) => {
        // Bind explicitly to loopback — NOT 0.0.0.0. Verified in tests.
        server.listen(port, LOOPBACK, () => {
          const addr = server.address() as AddressInfo;
          resolve({ host: LOOPBACK, port: addr.port });
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        void broadcaster.close().then(() => server.close(() => resolve()));
      });
    },
  };
}
