export function formatOpenAIError(status, err) {
    return {
        error: {
            message: err.message,
            type: err.type,
            param: err.param ?? null,
            code: err.code ?? null,
        },
    };
}
export function writeOpenAIError(c, status, err) {
    return c.json(formatOpenAIError(status, err), status);
}
//# sourceMappingURL=errors.js.map