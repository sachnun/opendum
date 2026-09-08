import type { Context } from "hono";
export interface ErrorInfo {
    message: string;
    type: string;
    param?: string | null;
    code?: string | null;
}
export declare function formatOpenAIError(status: number, err: ErrorInfo): {
    error: {
        message: string;
        type: string;
        param: string | null;
        code: string | null;
    };
};
export declare function writeOpenAIError(c: Context, status: number, err: ErrorInfo): Response & import("hono").TypedResponse<{
    error: {
        message: string;
        type: string;
        param: string | null;
        code: string | null;
    };
}, any, "json">;
//# sourceMappingURL=errors.d.ts.map