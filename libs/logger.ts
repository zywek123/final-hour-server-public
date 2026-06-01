import fs from "fs";
import path from "path";

const LOG_DIR = "./logs";
const LOG_FILE = path.join(LOG_DIR, "server.log");

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

function timestamp(): string {
    return new Date().toISOString();
}

function write(level: string, category: string, message: string, data?: any): void {
    const line = `[${timestamp()}] [${level}] [${category}] ${message}${data !== undefined ? " " + JSON.stringify(data) : ""}\n`;
    process.stdout.write(line);
    fs.appendFileSync(LOG_FILE, line);
}

const logger = {
    info(category: string, message: string, data?: any) { write("INFO", category, message, data); },
    warn(category: string, message: string, data?: any) { write("WARN", category, message, data); },
    error(category: string, message: string, data?: any) { write("ERROR", category, message, data); },
};

export default logger;
