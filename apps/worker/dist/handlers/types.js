/** Read a required string field from an untrusted job payload. */
export function requireStringField(payload, field) {
    const value = payload[field];
    return typeof value === 'string' && value.length > 0 ? value : null;
}
//# sourceMappingURL=types.js.map