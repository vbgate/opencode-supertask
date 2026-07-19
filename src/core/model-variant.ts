const MAX_MODEL_VARIANT_LENGTH = 128;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F]/;

export function normalizeModelVariant(
    value: string | null | undefined,
): string | null | undefined {
    if (value === undefined || value === null) return value;
    const normalized = value.trim();
    if (!normalized) return null;
    if (normalized.length > MAX_MODEL_VARIANT_LENGTH) {
        throw new Error(`variant 长度不能超过 ${MAX_MODEL_VARIANT_LENGTH} 个字符`);
    }
    if (CONTROL_CHARACTER_PATTERN.test(normalized)) {
        throw new Error('variant 不能包含控制字符');
    }
    return normalized;
}
