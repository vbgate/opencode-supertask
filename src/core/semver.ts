interface SemanticVersion {
    major: number;
    minor: number;
    patch: number;
    prerelease: string[];
}

function parseSemanticVersion(version: string): SemanticVersion | null {
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version);
    if (!match) return null;
    const prerelease = match[4]?.split('.') ?? [];
    if (prerelease.some((identifier) => /^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith('0'))) {
        return null;
    }
    return {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
        prerelease,
    };
}

export function compareSemanticVersions(left: string, right: string): number | null {
    const a = parseSemanticVersion(left);
    const b = parseSemanticVersion(right);
    if (!a || !b) return null;

    for (const key of ['major', 'minor', 'patch'] as const) {
        if (a[key] !== b[key]) return a[key] - b[key];
    }
    if (a.prerelease.length === 0 || b.prerelease.length === 0) {
        if (a.prerelease.length === b.prerelease.length) return 0;
        return a.prerelease.length === 0 ? 1 : -1;
    }

    const identifiers = Math.max(a.prerelease.length, b.prerelease.length);
    for (let index = 0; index < identifiers; index += 1) {
        const leftIdentifier = a.prerelease[index];
        const rightIdentifier = b.prerelease[index];
        if (leftIdentifier === undefined || rightIdentifier === undefined) {
            return leftIdentifier === rightIdentifier ? 0 : leftIdentifier === undefined ? -1 : 1;
        }
        if (leftIdentifier === rightIdentifier) continue;

        const leftNumeric = /^\d+$/.test(leftIdentifier);
        const rightNumeric = /^\d+$/.test(rightIdentifier);
        if (leftNumeric && rightNumeric) return Number(leftIdentifier) - Number(rightIdentifier);
        if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
        return leftIdentifier < rightIdentifier ? -1 : 1;
    }
    return 0;
}

export function isSemanticVersion(version: string): boolean {
    return parseSemanticVersion(version) !== null;
}
