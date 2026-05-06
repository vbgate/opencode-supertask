const DURATION_REGEX = /^(\d+(?:\.\d+)?)\s*(ms|s|sec|seconds?|min|minutes?|m|h|hours?|d|days?|w|weeks?)$/i;
const ISO8601_REGEX = /^P(?:([.\d]+)D)?(?:T(?:([.\d]+)H)?(?:([.\d]+)M)?(?:([.\d]+)S)?)?$/i;

export function parseDuration(input: string): number | null {
    const trimmed = input.trim();

    const simple = DURATION_REGEX.exec(trimmed);
    if (simple) {
        const value = parseFloat(simple[1]);
        const unit = simple[2].toLowerCase();
        if (unit === "ms") return value;
        if (unit === "s" || unit === "sec" || unit === "second" || unit === "seconds") return value * 1000;
        if (unit === "min" || unit === "minute" || unit === "minutes" || unit === "m") return value * 60_000;
        if (unit === "h" || unit === "hour" || unit === "hours") return value * 3_600_000;
        if (unit === "d" || unit === "day" || unit === "days") return value * 86_400_000;
        if (unit === "w" || unit === "week" || unit === "weeks") return value * 604_800_000;
    }

    const iso = ISO8601_REGEX.exec(trimmed);
    if (iso) {
        const days = parseFloat(iso[1] ?? "0");
        const hours = parseFloat(iso[2] ?? "0");
        const minutes = parseFloat(iso[3] ?? "0");
        const seconds = parseFloat(iso[4] ?? "0");
        return ((days * 86400) + (hours * 3600) + (minutes * 60) + seconds) * 1000;
    }

    const asNumber = Number(trimmed);
    if (!isNaN(asNumber) && asNumber > 0) return asNumber;

    return null;
}
