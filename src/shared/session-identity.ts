interface SessionIdentityManager {
	getSessionFile(): string | null | undefined;
	getSessionId(): string | null | undefined;
}

let workflowHostIdentity: string | undefined;
/** The model-free workflow owner writes its context copy while retaining its real parent identity. */
export function setWorkflowHostSessionIdentity(identity: string): void { workflowHostIdentity = identity; }
export function resolveCurrentSessionId(sessionManager: SessionIdentityManager): string {
	if(workflowHostIdentity)return workflowHostIdentity;
	const sessionId = sessionManager.getSessionFile() ?? sessionManager.getSessionId();
	if (!sessionId) throw new Error("Current session identity is unavailable.");
	return sessionId;
}
