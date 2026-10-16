const FORBIDDEN_DISPLAY_CHARACTER = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

const encoder = new TextEncoder();



function utf8Bytes(value: string): Uint8Array {
    return encoder.encode(value);
}

function utf8ByteCount(value: string): number {
    return utf8Bytes(value).byteLength;
}

function hasUnpairedUTF16Surrogate(value: string): boolean {
    for (let index = 0; index < value.length; index += 1) {
        const codeUnit = value.charCodeAt(index);
        if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
            const next = value.charCodeAt(index + 1);
            if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
            index += 1;
        } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
            return true;
        }
    }
    return false;
}

function hasForbiddenBoundaryWhitespace(value: string): boolean {
    return value !== value.trim()
        || value.startsWith("\u200b")
        || value.endsWith("\u200b")
        || value.startsWith("\ufeff")
        || value.endsWith("\ufeff");
}

function isValidBoundedText(value: unknown, maxBytes: number): value is string {
    if (
        typeof value !== "string"
        || !value
        || hasForbiddenBoundaryWhitespace(value)
        || FORBIDDEN_DISPLAY_CHARACTER.test(value)
        || hasUnpairedUTF16Surrogate(value)
    ) return false;
    return utf8ByteCount(value) <= maxBytes;
}

function isValidVaultName(value: unknown): value is string {
    return isValidBoundedText(value, 256);
}

export function portableVaultNamesMatch(left: unknown, right: unknown): boolean {
    if (!isValidVaultName(left) || !isValidVaultName(right)) return false;
    const normalize = (value: string): string => value
        .normalize("NFC")
        .toLocaleLowerCase("en-US")
        .normalize("NFC");
    return normalize(left) === normalize(right);
}
