import { DurableObject } from 'cloudflare:workers';

import type { IHCCombinedResponse, IHCMessageData, IHCRole, IHCRoleResponse, IHCStateData, IHCStateResponse, IHCWebSocketInfo } from './typeInterfaces'

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
	if (sessionID === null || /[^A-Z0-9]/.test(sessionID)) {
		return new Response('Invalid session ID', {
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
	sessions: Map<WebSocket, IHCWebSocketInfo>;
	sessionData!: IHCStateData;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sessions = new Map();

		this.ctx.blockConcurrencyWhile(async () => {
			// Get all WebSocket connections from the DO
			this.ctx.getWebSockets().forEach((ws) => {
				let attachment: IHCWebSocketInfo = ws.deserializeAttachment();
				// If we previously attached state to our WebSocket,
				// let's add it to `sessions` map to restore the state of the connection.
				this.sessions.set(ws, attachment);
			});

			// As part of constructing the Durable Object,
			// we wake up any hibernating WebSockets and
			// place them back in the `sessions` map.
			this.sessionData = (await ctx.storage.get("sessionData")) || {
				gameState: "init",
				interrogationState: "prelim",
				validatedSessions: 0,
				moduleID: null,
				penaltyCardID: null,
				backgroundCardID: null,
				suspectProfileType: null,
				suspectProfileID: null,
				permanentPenalty: false,
				continuousCatalyzation: false,
				digitalGame: false,
				sealedFile: false,
				endTime: null
			}
		});
		this.ctx.storage.setAlarm(Date.now() + deleteDelay);
	}

	async fetch(request: Request): Promise<Response> {		
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
		const websocketInfo: IHCWebSocketInfo = {
			validated: false,
			role: null
		}

		// Attach the session ID to the WebSocket connection and serialize it.
		// This is necessary to restore the state of the connection when the Durable Object wakes up.
		server.serializeAttachment(websocketInfo);

		// Add the WebSocket connection to the map of active sessions.
		this.sessions.set(server, websocketInfo);

		return new Response(null, {
			status: 101,
			webSocket: client,
			headers: corsHeader
		});
	}

	async webSocketMessage(ws: WebSocket, message: string) {
		const incomingMessage: IHCMessageData = JSON.parse(message)
		//offset destruction every time a message comes along
		this.ctx.storage.setAlarm(Date.now() + deleteDelay);

		this.ctx.blockConcurrencyWhile(async () => {
			if (incomingMessage.type === "intro") {
				if (this.sessionData.validatedSessions >= 2) {
					ws.close(4001,"session is full")
				}
				else if (incomingMessage.data.joinType === "existing" && this.sessionData.validatedSessions < 1) {
					ws.close(4002,'Session empty, cannot join')
				}
				else if (incomingMessage.data.joinType === "new" && this.sessionData.validatedSessions > 0) {
					ws.close(4003,'Session already exists, cannot create a new session with this ID')
				}
				else if (!this.sessions.has(ws)) {
					ws.close(4004,'Unable to validate this session.')
				}
				else {
					//we just checked that sessions has the websocket as a key
					const websocketInfo: IHCWebSocketInfo = this.sessions.get(ws)!

					websocketInfo.validated = true
					// check if we should assign a role
					const alreadyAssignedRole: IHCRole | null = this.sessions.values().find(
						(attachment: IHCWebSocketInfo) => attachment?.validated && (attachment?.role === "detective" || attachment?.role === "suspect")
					)?.role ?? null
					if (alreadyAssignedRole !== null) {
						websocketInfo.role = alreadyAssignedRole === "detective"? "suspect" : "detective"
					}

					ws.serializeAttachment(websocketInfo)

					this.sessionData.validatedSessions += 1
					await this.ctx.storage.put("sessionData",this.sessionData)

					const {suspectProfileType: _0,suspectProfileID: _1,...publicData} = this.sessionData

					this.sessions.forEach((attachment, connectedWs) => {
						if (attachment.validated) {
							if (connectedWs === ws) {
								const response: IHCCombinedResponse = {
									type: "combined-response",
									state: null,
									role: attachment.role,
									string: "confirm"
								}
								if (attachment.role === "suspect") {
									response.state = this.sessionData
								}
								else {
									response.state = publicData
								}
								connectedWs.send(JSON.stringify(response))
							}
							else {
								const response: IHCStateResponse = {
									type: "state-response",
									state: {validatedSessions: this.sessionData.validatedSessions},
									role: null,
									string: null
								}
								connectedWs.send(JSON.stringify(response))
							}
						}
					});
				}
			}
			else if (incomingMessage.type === "query") {
				const response: IHCCombinedResponse = {
					type: "combined-response",
					state: null,
					role: this.sessions.get(ws)?.role ?? null,
					string: "confirm"
				}
				if (response.role === "suspect") {
					response.state = this.sessionData
				}
				else {
					const {suspectProfileType: _0,suspectProfileID: _1,...publicData} = this.sessionData
					response.state = publicData
				}
				ws.send(JSON.stringify(response))
			}
			else if (incomingMessage.type === "state-update") {
				const {suspectProfileType: _0,suspectProfileID: _1,...updatePublicData} = incomingMessage.data
				this.sessionData = { ...this.sessionData, ...incomingMessage.data };
				await this.ctx.storage.put("sessionData",this.sessionData)
				// Send a message to all WebSocket connections with the new sessionData.
				this.sessions.forEach((attachment, connectedWs) => {
					if (attachment.validated) {
						const response: IHCStateResponse = {
							type: "state-response",
							state: {},
							role: null,
							string: null
						}
						if (attachment.role === "suspect") {
							response.state = incomingMessage.data
						}
						else {
							response.state = updatePublicData
						}
						if (connectedWs === ws) {
							response.string = "confirm"
						}
						if (Object.keys(response.state).length !== 0) {
							connectedWs.send(JSON.stringify(response))
						}
					}
				});
			}
			else if (incomingMessage.type === "role-update") {
				this.sessions.forEach((attachment, connectedWs) => {
					if (attachment.validated) {
						const response: IHCRoleResponse = {
							type: "role-response",
							state: null,
							role: incomingMessage.data.other,
							string: null
						}
						if (connectedWs === ws) {
							attachment.role = incomingMessage.data.self
							response.role = attachment.role
							response.string = "confirm"
						}
						else {
							attachment.role = incomingMessage.data.other
						}
						connectedWs.serializeAttachment(attachment)
						connectedWs.send(JSON.stringify(response));
					}
				});
			}
		})
	}

	async webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean) {
		// With web_socket_auto_reply_to_close (compat date >= 2026-04-07), the runtime
		// auto-replies to Close frames. Calling close() is safe but no longer required.
		this.ctx.blockConcurrencyWhile(async () => {
			if (this.sessions.get(ws)?.validated) {
				this.sessionData.validatedSessions -= 1
			}
			this.sessions.delete(ws);
			if (this.sessionData.validatedSessions <= 0) {
				this.sessions.forEach((_attachment, connectedWs) => {
					connectedWs.close(4000,"Websocket deleted");
				});
				this.sessions.clear()
				await this.ctx.storage.deleteAll()
			}
			else {
				const broadcastUpdate: IHCStateResponse = {
					type: "state-response",
					state: {validatedSessions: this.sessionData.validatedSessions},
					role: null,
					string: null
				}
				this.sessions.forEach((attachment, connectedWs) => {
					if (attachment.validated) {
						connectedWs.send(JSON.stringify(broadcastUpdate));
					}
				});
				await this.ctx.storage.put("sessionData",this.sessionData)
			}
		})
	}
	
	async alarm() {
		this.ctx.blockConcurrencyWhile(async () => {
			await this.ctx.storage.deleteAll()
			this.sessions.forEach((_attachment, connectedWs) => {
				connectedWs.close(4005,"websocket expired")
			})
		})
	}
}