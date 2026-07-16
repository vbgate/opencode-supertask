export const LEGACY_GUARDIAN_LAUNCH_PROTOCOL = 'gated-v2-guardian';
export const TOKEN_GUARDIAN_LAUNCH_PROTOCOL = 'gated-v3-token-guardian';
export const LAUNCH_IDENTITY_ARGUMENT = '--supertask-launch-identity';
export const DRAIN_PROOF_MESSAGE_TYPE = 'supertask-drained';
export const MANAGED_RUN_ENV = 'SUPERTASK_MANAGED_RUN';
export const MANAGED_RUN_ENV_VALUE = '1';

export function isLaunchIdentity(value: string | null | undefined): value is string {
    return value != null
        && /^gateway-[1-9]\d*:launch:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function drainProofForIdentity(launchIdentity: string) {
    return { type: DRAIN_PROOF_MESSAGE_TYPE, identity: launchIdentity } as const;
}

export function isMatchingDrainProof(message: unknown, launchIdentity: string): boolean {
    if (typeof message !== 'object' || message == null) return false;
    const candidate = message as Record<string, unknown>;
    return candidate.type === DRAIN_PROOF_MESSAGE_TYPE
        && candidate.identity === launchIdentity;
}
