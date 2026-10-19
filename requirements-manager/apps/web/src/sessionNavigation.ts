export function safeReturnTo(value: unknown) {
    if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return "/";
    const path = value.split(/[?#]/, 1)[0].replace(/\/+$/, "") || "/";
    return path === "/login" ? "/" : value
}
