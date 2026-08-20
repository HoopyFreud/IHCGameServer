export interface IHCStateData {
    gameState: (
        "init" | "game-setup" | 
        "select-penalty-prelim" | "select-penalty-final" | "calibrate-penalty" |
        "select-module" | "confirm-module" |
        "select-background-fail" | "select-background-success" | "select-background-sealed" |
        "interrogate" |
        "end-game-win-together" | "end-game-lose-together" | "end-game-win-robot" | "end-game-win-detective" );
    interrogationState: (
        "prelim" | "ongoing" | "pause" | "last-question" | "kill-attempt" );
    validatedSessions: number;
    moduleID: number | null;
    penaltyCardID: number | [number, number] | null;
    backgroundCardID: number | null;
    suspectProfileType: "human" | "patientRobot" | "violentRobot" | null;
    suspectProfileID: number | null;
    permanentPenalty: boolean;
    continuousCatalyzation: boolean;
    digitalGame: boolean;
    sealedFile: boolean;
    endTime: Date | null
}

export type IHCRole = "detective" | "suspect"


export interface IHCWebSocketInfo {
    validated: boolean;
    role: IHCRole | null
}

export interface IHCRoleData {
    self: IHCRole;
    other: IHCRole;
}

export interface IHCIntroductionData {
    type: "intro";
    data: {
        sessionID: string;
        joinType: string;
    }
}

export interface IHCQuery {
    type: "query";
    data: null
}

export interface IHCStateUpdate {
    type: "state-update";
    data: Partial<IHCStateData>
}

export interface IHCRoleUpdate {
    type: "role-update";
    data: IHCRoleData
}

export interface IHCResetSession {
    type: "reset-session";
    data: null
}

export type IHCMessageData = (IHCIntroductionData | IHCQuery | IHCStateUpdate | IHCRoleUpdate | IHCResetSession)

export interface IHCStateResponse {
    type: "state-response";
    state: Partial<IHCStateData>
    role: null
    string: "confirm" | null
}

export interface IHCRoleResponse {
    type: "role-response";
    state: null
    role: IHCRole
    string: "confirm" | null
}

export interface IHCCombinedResponse {
    type: "combined-response";
    state: Partial<IHCStateData> | null
    role: IHCRole | null
    string: "confirm" | null
}

export type IHCResponse = (IHCStateResponse | IHCRoleResponse | IHCCombinedResponse)