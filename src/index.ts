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
	endTime: Date | null
}

interface IHCMessageData {
	type: string;
	stateUpdate: Partial<IHCSessionData> | null
}

const deleteDelay = 24 * 60 * 60 * 1000;

const corsHeader = {"Access-Control-Allow-Origin": "*"}

// Worker
export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
	const url = new URL(request.url)
    if (url.pathname != '/ihc-gameserver') {
		return new Response(
			`Supported endpoints:
/ihc-gameserver: inhuman conditions game server workers`,
			{
				status: 200,
				headers: {'Content-Type': 'text/plain',...corsHeader},
		});
	}
	if (request.method !== 'GET') {
		return new Response('Worker expected GET method', {
			status: 400,
			headers: corsHeader
		});
	}

	const upgradeHeader = request.headers.get('Upgrade');
	if (!upgradeHeader || upgradeHeader !== 'websocket') {
		return new Response('Worker expected Upgrade: websocket', {
			status: 426,
			headers: corsHeader
		});
	}

	const sessionID = url.searchParams.get("sessionID");
	const joinType = url.searchParams.get("joinType");
	if (sessionID === null || /[^A-Z0-9]/.test(sessionID)) {
		return new Response('Invalid session ID', {
			status: 400,
			headers: corsHeader
		});
	}
	if (joinType === null || (joinType !== "existing" && joinType !== "new")) {
		return new Response('Bad session join type', {
			status: 400,
			headers: corsHeader
		});
	}
	  
	let stub = env.IHC_GAME_SERVER.getByName(sessionID);
	return await stub.fetch(request);
	}
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

		// Get all WebSocket connections from the DO
		this.ctx.getWebSockets().forEach((ws) => {
			let attachment = ws.deserializeAttachment();
			if (attachment) {
				// If we previously attached state to our WebSocket,
				// let's add it to `sessions` map to restore the state of the connection.
				this.sessions.set(ws, { ...attachment });
			}
		});

		this.ctx.blockConcurrencyWhile(async () => {
			this.sessionData = (await ctx.storage.get("sessionData")) || {
				gameState: "init",
				moduleID: null,
				robotCardID: null,
				penaltyCardID: null,
				backgroundCardID: null,
				permanentPenalty: false,
				continuousCatalyzation: false,
				sealedFile: false,
				endTime: null
			}

			// As part of constructing the Durable Object,
			// we wake up any hibernating WebSockets and
			// place them back in the `sessions` map.
			await this.ctx.storage.setAlarm(Date.now() + deleteDelay);
		});
	}

	async fetch(request: Request): Promise<Response> {
		const joinType = new URL(request.url).searchParams.get("joinType");

		if (this.sessions.size >= 2) {
			return new Response('Session full, use another sessionID', {
				status: 409,
				headers: corsHeader
			});
		}
		else if (joinType === "existing" && this.sessions.size < 1) {
			return new Response('Session empty, cannot join', {
				status: 409,
				headers: corsHeader
			});
		}
		else if (joinType === "new" && this.sessions.size > 0) {
			return new Response('Session already exists, cannot create a new session with this ID', {
				status: 409,
				headers: corsHeader
			});
		}
		else {
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
				headers: corsHeader
			});
		}
	}

	async webSocketMessage(ws: WebSocket, message: string) {
		const incomingMessage: IHCMessageData = JSON.parse(message)

		if (incomingMessage.type === "query") {
			ws.send(JSON.stringify(this.sessionData))
		}
		else if (incomingMessage.type === "update" && incomingMessage.stateUpdate !== null) {
			this.sessionData = { ...this.sessionData, ...incomingMessage.stateUpdate };
			// Send a message to all WebSocket connections with the new sessionData.
			this.sessions.forEach((_attachment, connectedWs) => {
				connectedWs.send(JSON.stringify(this.sessionData));
			});
		}
	}

	async webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean) {
	// With web_socket_auto_reply_to_close (compat date >= 2026-04-07), the runtime
	// auto-replies to Close frames. Calling close() is safe but no longer required.
		this.sessions.delete(ws);
		if (this.sessions.size == 0) {
			await this.ctx.storage.deleteAll()
		}
	}
	
	async alarm() {
		await this.ctx.storage.deleteAll()
	}
}