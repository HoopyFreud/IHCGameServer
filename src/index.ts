import { DurableObject } from 'cloudflare:workers';

interface IHCSessionData {
	gameState: string;
	moduleID: number | null;
	robotCardID: number | null;
	penaltyCardID: number | null;
	backgroundCardID: number | null;
	permanentPenalty: boolean;
	continuousCatalyzation: boolean;
	sealedFile: boolean;
}

// Worker
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.url.endsWith('/ihc-gameserver')) {
      if (request.method !== 'GET') {
        return new Response('Worker expected GET method', {
          status: 400,
        });
      }
	  const url = new URL(request.url);
	  const sessionCode = url.searchParams.get("sessionCode");

	  if (sessionCode === null) {
		return new Response('Worker expected session code for IHC gameserver initialization', {
          status: 400,
        });
	  }
	  
	  let stub = env.IHC_GAME_SERVER.getByName(sessionCode);
	  return stub.fetch(request);
	}

    return new Response(
      `Supported endpoints:
/ihc-gameserver: inhuman conditions game server workers`,
      {
        status: 200,
        headers: {
          'Content-Type': 'text/plain',
        },
      }
    );
  },
};

// Durable Object
export class IHCGameServer extends DurableObject<Env> {
  // Keeps track of all WebSocket connections
  // When the DO hibernates, gets reconstructed in the constructor
  sessions: Map<WebSocket, { [key: string]: string }>;
  sessionData!: IHCSessionData;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sessions = new Map();

	this.ctx.blockConcurrencyWhile(async () => {
		this.sessionData = (await ctx.storage.get("sessionData")) || {
			gameState: "init",
			moduleID: null,
			robotCardID: null,
			penaltyCardID: null,
			backgroundCardID: null,
			permanentPenalty: false,
			continuousCatalyzation: false,
			sealedFile: false
		}

		// As part of constructing the Durable Object,
		// we wake up any hibernating WebSockets and
		// place them back in the `sessions` map.

		// Get all WebSocket connections from the DO
		this.ctx.getWebSockets().forEach((ws) => {
			let attachment = ws.deserializeAttachment();
			if (attachment) {
				// If we previously attached state to our WebSocket,
				// let's add it to `sessions` map to restore the state of the connection.
				this.sessions.set(ws, { ...attachment });
			}
		});
			
	});
  }

  async fetch(request: Request): Promise<Response> {
	if (this.sessions.size < 2) {
		// Creates two ends of a WebSocket connection.
		const webSocketPair = new WebSocketPair();
		const [client, server] = Object.values(webSocketPair);

		// Calling `acceptWebSocket()` informs the runtime that this WebSocket is to begin terminating
		// request within the Durable Object. It has the effect of "accepting" the connection,
		// and allowing the WebSocket to send and receive messages.
		// Unlike `ws.accept()`, `this.ctx.acceptWebSocket(ws)` informs the Workers Runtime that the WebSocket
		// is "hibernatable", so the runtime does not need to pin this Durable Object to memory while
		// the connection is open. During periods of inactivity, the Durable Object can be evicted
		// from memory, but the WebSocket connection will remain open. If at some later point the
		// WebSocket receives a message, the runtime will recreate the Durable Object
		// (run the `constructor`) and deliver the message to the appropriate handler.
		this.ctx.acceptWebSocket(server);

		// Generate a random UUID for the session.
		const id = crypto.randomUUID();

		// Attach the session ID to the WebSocket connection and serialize it.
		// This is necessary to restore the state of the connection when the Durable Object wakes up.
		server.serializeAttachment({ id });

		// Add the WebSocket connection to the map of active sessions.
		this.sessions.set(server, { id });

		return new Response(null, {
			status: 101,
			webSocket: client,
		});
	}

	return new Response('Session full, use another sessionID', {
		status: 409
	});
  }

  async webSocketMessage(ws: WebSocket, message: string) {
	const incomingData: Partial<IHCSessionData> = JSON.parse(message)

	// currently both clients have full control over the shared state, that might be a little bit bad but whatever
	this.sessionData = { ...this.sessionData, ...incomingData };

    // Send a message to all WebSocket connections with the new sessionData.
    this.sessions.forEach((attachment, connectedWs) => {
      connectedWs.send(JSON.stringify(this.sessionData));
    });
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
    // With web_socket_auto_reply_to_close (compat date >= 2026-04-07), the runtime
    // auto-replies to Close frames. Calling close() is safe but no longer required.
    this.sessions.delete(ws);
	if (this.sessions.size == 0) {
		this.ctx.storage.deleteAll()
	}
  }
}