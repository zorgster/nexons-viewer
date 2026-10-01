// Copyright (C) 2026 Oliver Slay and Simon Andrews
// SPDX-License-Identifier: GPL-3.0-only

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const distDirectory = resolve(fileURLToPath(new URL("./dist/", import.meta.url)));
const host = process.env.HOST || "127.0.0.1";
const port = Number.parseInt(process.env.PORT || "4173", 10);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${process.env.PORT}`);
}

const contentTypes = new Map([
    [".css", "text/css; charset=utf-8"],
    [".html", "text/html; charset=utf-8"],
    [".ico", "image/x-icon"],
    [".js", "text/javascript; charset=utf-8"],
    [".json", "application/json; charset=utf-8"],
    [".map", "application/json; charset=utf-8"],
    [".png", "image/png"],
    [".svg", "image/svg+xml"],
    [".txt", "text/plain; charset=utf-8"],
    [".webp", "image/webp"],
    [".woff", "font/woff"],
    [".woff2", "font/woff2"],
]);

function sendText(response, statusCode, message) {
    response.writeHead(statusCode, {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Length": Buffer.byteLength(message),
        "Cache-Control": "no-store",
    });
    response.end(message);
}

const server = createServer(async (request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
        response.setHeader("Allow", "GET, HEAD");
        sendText(response, 405, "Method not allowed\n");
        return;
    }

    let pathname;
    try {
        pathname = decodeURIComponent(new URL(request.url || "/", "http://localhost").pathname);
    } catch {
        sendText(response, 400, "Bad request\n");
        return;
    }

    const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const filePath = resolve(distDirectory, relativePath);
    if (filePath !== distDirectory && !filePath.startsWith(distDirectory + sep)) {
        sendText(response, 403, "Forbidden\n");
        return;
    }

    try {
        const fileStats = await stat(filePath);
        if (!fileStats.isFile()) {
            sendText(response, 404, "Not found\n");
            return;
        }

        const headers = {
            "Content-Type": contentTypes.get(extname(filePath).toLowerCase()) || "application/octet-stream",
            "Content-Length": fileStats.size,
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": pathname.startsWith("/assets/")
                ? "public, max-age=31536000, immutable"
                : "no-cache",
        };
        response.writeHead(200, headers);
        if (request.method === "HEAD") {
            response.end();
            return;
        }

        const stream = createReadStream(filePath);
        stream.on("error", () => {
            if (!response.headersSent) sendText(response, 500, "Internal server error\n");
            else response.destroy();
        });
        stream.pipe(response);
    } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
            sendText(response, 404, "Not found\n");
        } else {
            console.error(error);
            sendText(response, 500, "Internal server error\n");
        }
    }
});

server.on("clientError", (_error, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
});

server.listen(port, host, () => {
    console.log(`Nexons Viewer static server listening on http://${host}:${port}`);
});

function shutDown(signal) {
    console.log(`Received ${signal}; shutting down`);
    server.close((error) => {
        if (error) {
            console.error(error);
            process.exitCode = 1;
        }
    });
}

process.on("SIGINT", () => shutDown("SIGINT"));
process.on("SIGTERM", () => shutDown("SIGTERM"));
