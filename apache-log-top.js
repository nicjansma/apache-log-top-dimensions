#!/usr/bin/env node
//
// apache-log-top.js
//
// Parses an Apache Combined Log Format access log, extracts key dimensions,
// shows the top 5 values for each dimension, and highlights any single value
// that accounts for more than a user-specified percentage of total hits.
//
// Usage:
//   node apache-log-top.js <logfile> [threshold_percent] [options]
//
// Options:
//   --groups, -g <file>          URL-groups definition file
//   --geoip, -G <file>           MaxMind GeoLite2-Country.mmdb file
//                                 (auto-detected in the log file's directory)
//   --filter, -f <dim=value>     Only count lines where <dim> equals <value>
//                                 May be specified multiple times (AND logic)
//
// Examples:
//   node apache-log-top.js /var/log/apache2/access.log
//   node apache-log-top.js /var/log/apache2/access.log 20
//   node apache-log-top.js access.log 30 --groups url-groups.txt
//   node apache-log-top.js access.log --filter "IP Address=1.2.3.4"
//   node apache-log-top.js access.log --filter "HTTP Method=POST" -f "Status Class=5xx"
//
// Default threshold is 30%.

//
// Imports
//
const fs = require("fs");
const path = require("path");
const readline = require("readline");

//
// Constants
//
const isTTY = process.stdout.isTTY;
const colour = (code) => (isTTY ? code : "");
const RED = colour("\x1b[1;31m");
const YEL = colour("\x1b[1;33m");
const CYN = colour("\x1b[0;36m");
const BLD = colour("\x1b[1m");
const RST = colour("\x1b[0m");

/* eslint-disable max-len */
//
// Apache Combined Log regex
//
// Format: %h %l %u %t "%r" %>s %b "%{Referer}i" "%{User-Agent}i" %D %H
// Example:
//   192.168.1.1 - - [10/Oct/2000:13:55:36 -0700] "GET /index.html HTTP/1.0" 200 2326 "http://ref/" "Mozilla/5.0 ..." 123 HTTP/1.1
//
/* eslint-enable max-len */

const LOG_RE = new RegExp(
    [
        /^(\S+)/, // 1  IP / host
        /\s+\S+/, //    ident (skip)
        /\s+\S+/, //    user  (skip)
        /\s+\[([^\]]+)\]/, // 2  datetime
        /\s+"([^"]*)"/, // 3  request line
        /\s+(\d{3})/, // 4  status code
        /\s+(\S+)/, // 5  size
        /(?:\s+"([^"]*)")?/, // 6  referer  (optional)
        /(?:\s+"([^"]*)")?/, // 7  user-agent (optional)
        /\s+(\d+)?/, // 8  time taken to serve the request (optional)
        /\s+(HTTP\/\d\.\d)?/ // 9  HTTP version (optional)

    ]
        .map((r) => r.source)
        .join("")
);

//
// User-Agent family detection
//
const UA_PATTERNS = [
    [/gptbot/i, "GPTBot"],
    [/Googlebot/i, "Googlebot"],
    [/bingbot/i, "Bingbot"],
    [/Baiduspider/i, "Baiduspider"],
    [/YandexBot/i, "YandexBot"],
    [/AhrefsBot/i, "AhrefsBot"],
    [/SemrushBot/i, "SemrushBot"],
    [/DotBot/i, "DotBot"],
    [/MJ12bot/i, "MJ12bot"],
    [/curl/i, "curl"],
    [/Wget/i, "Wget"],
    [/python-requests/i, "python-requests"],
    [/Firefox/i, "Firefox"],
    [/Edg\//i, "Edge"],
    [/Chrome/i, "Chrome"],
    [/Safari/i, "Safari"],
    [/MSIE|Trident/i, "IE"],
    [/Opera|OPR/i, "Opera"]
];

//
// Program Arguments
//
const rawArgs = process.argv.slice(2);

// Extract named options from anywhere in the argument list
let groupsFile = null;
let geoipFile = null;

// Array of { dimName: string, value: string }
const filters = [];

const positionalArgs = [];

for (let i = 0; i < rawArgs.length; i++) {
    if (rawArgs[i] === "--groups" || rawArgs[i] === "-g") {
        groupsFile = rawArgs[++i];
    } else if (rawArgs[i] === "--geoip" || rawArgs[i] === "-G") {
        geoipFile = rawArgs[++i];
    } else if (rawArgs[i] === "--filter" || rawArgs[i] === "-f") {
        const spec = rawArgs[++i];
        const eqIdx = spec ? spec.indexOf("=") : -1;

        if (!spec || eqIdx <= 0) {
            console.error(`Error: --filter requires 'Dimension=value' (got '${spec ?? ""}').`);
            process.exit(1);
        }

        filters.push({ dimName: spec.substring(0, eqIdx), value: spec.substring(eqIdx + 1) });
    } else {
        positionalArgs.push(rawArgs[i]);
    }
}

if (positionalArgs.length < 1) {
    console.log(`Usage: node ${path.basename(__filename)} <logfile> [threshold_percent] [options]`);
    console.log("  logfile            Path to an Apache Combined-format access log");
    console.log("  threshold_percent  Highlight values exceeding this % of total hits (default: 30)");
    console.log("  --groups, -g       Path to a URL-groups definition file (see README)");
    console.log("  --geoip, -G        Path to a MaxMind GeoLite2-Country.mmdb file");
    console.log("  --filter, -f       Filter to lines matching Dimension=Value (repeatable, AND logic)");
    process.exit(1);
}

const logFile = positionalArgs[0];
const threshold = parseFloat(positionalArgs[1] ?? "30");

if (!fs.existsSync(logFile)) {
    console.error(`Error: '${logFile}' not found or is not a regular file.`);
    process.exit(1);
}

if (Number.isNaN(threshold)) {
    console.error(`Error: threshold must be a number (got '${positionalArgs[1]}').`);
    process.exit(1);
}

//
// Class: DimensionCounter
//
class DimensionCounter {
    constructor(name) {
        this.name = name;
        this.counts = new Map();
    }

    add(value) {
        if (value === null || value === "") {
            return;
        }

        this.counts.set(value, (this.counts.get(value) || 0) + 1);
    }

    // Return array of [value, count] sorted descending by count, limited to n.
    top(n = 5) {
        return [...this.counts.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, n);
    }

    get size() {
        return this.counts.size;
    }
}

//
// URL Groups loader
//
// File format (one rule per line):
//   <regex>  =>  <output_expression>
//
// Lines starting with # are comments. Blank lines are ignored.
//
// The output expression can reference capture groups from the regex using $1,
// $2, etc.  If no "=>" separator is present the regex match itself ($0) is
// used as the output value.
//
// Examples:
//   ^/wiki/(.*)$               => Wiki: $1
//   ^/api/v[0-9]+/             => API call
//   ^/static/                  => Static asset
//   ^/(images|css|js)/         => Asset: $1
//   ^/products/(\d+)           => Product #$1

// Array of { re: RegExp, output: string|null, name: string }
const urlGroups = [];

// DimensionCounter – created only when groups are loaded
let urlGroupDim = null;

function loadUrlGroups(filePath) {
    if (!fs.existsSync(filePath)) {
        console.error(`Error: URL-groups file '${filePath}' not found.`);
        process.exit(1);
    }

    const lines = fs.readFileSync(filePath, "utf-8").split(/\r?\n/);

    for (const raw of lines) {
        const line = raw.trim();

        if (line === "" || line.startsWith("#")) {
            continue;
        }

        let pattern, output;
        const sepIdx = line.indexOf("=>");

        if (sepIdx >= 0) {
            pattern = line.substring(0, sepIdx).trim();
            output = line.substring(sepIdx + 2).trim();
        } else {
            pattern = line;

            // use full match ($0)
            output = null;
        }

        try {
            urlGroups.push({ re: new RegExp(pattern), output, name: pattern });
        } catch (e) {
            console.error(`Warning: invalid regex '${pattern}' in ${filePath} – skipped (${e.message})`);
        }
    }
}

function matchUrlGroup(url) {
    for (const group of urlGroups) {
        const m = group.re.exec(url);

        if (!m) {
            continue;
        }

        if (group.output === null) {
            // full match
            return m[0];
        }

        // Replace $1, $2, … with captured groups
        return group.output.replace(/\$(\d+)/g, (_, n) => m[parseInt(n, 10)] ?? "");
    }

    // no group matched
    return null;
}

// ── GeoIP database ──────────────────────────────────────────────────────────
let geoipDb = null;

// Auto-detect GeoLite2-Country.mmdb in the same directory if --geoip not given
if (!geoipFile) {
    const autoPath = path.join(path.dirname(logFile), "GeoLite2-Country.mmdb");

    if (fs.existsSync(autoPath)) {
        geoipFile = autoPath;
    }
}

if (geoipFile) {
    if (!fs.existsSync(geoipFile)) {
        console.error(`Error: GeoIP database '${geoipFile}' not found.`);
        process.exit(1);
    }
}

if (groupsFile) {
    loadUrlGroups(groupsFile);

    if (urlGroups.length > 0) {
        urlGroupDim = new DimensionCounter("URL Group");
    }
}

function detectUAFamily(ua) {
    if (!ua) {
        return null;
    }

    for (const [re, name] of UA_PATTERNS) {
        if (re.test(ua)) {
            return name;
        }
    }

    return "Other";
}

// ── Size bucket helper ──────────────────────────────────────────────────────
function sizeBucket(bytes) {
    if (bytes < 1024) {
        return "0-1K";
    }

    if (bytes < 10240) {
        return "1K-10K";
    }

    if (bytes < 102400) {
        return "10K-100K";
    }

    if (bytes < 1048576) {
        return "100K-1M";
    }

    return "1M+";
}

// ── Time bucket helper ──────────────────────────────────────────────────────
function timeBucket(ms) {
    if (ms < 100) {
        return "0-100ms";
    }

    if (ms < 500) {
        return "100-500ms";
    }

    if (ms < 1000) {
        return "500ms-1s";
    }

    if (ms < 5000) {
        return "1-5s";
    }

    return "5s+";
}

// ── Initialise dimensions ───────────────────────────────────────────────────
const dims = {
    ipAddress:    new DimensionCounter("IP Address"),
    ipSubnet:     new DimensionCounter("IP Subnet (/24)"),
    country:      new DimensionCounter("Country"),
    date:         new DimensionCounter("Date"),
    hour:         new DimensionCounter("Hour"),
    httpMethod:   new DimensionCounter("HTTP Method"),
    url:          new DimensionCounter("URL (full)"),
    urlPath:      new DimensionCounter("URL Path (no query)"),
    extension:    new DimensionCounter("File Extension"),
    statusCode:   new DimensionCounter("HTTP Status Code"),
    statusClass:  new DimensionCounter("Status Class"),
    sizeBucket:   new DimensionCounter("Response Size Bucket"),
    timeBucket:   new DimensionCounter("Response Time Bucket"),
    referer:      new DimensionCounter("Referer"),
    userAgent:    new DimensionCounter("User-Agent"),
    uaFamily:     new DimensionCounter("User-Agent Family"),
    httpProtocol: new DimensionCounter("HTTP Protocol")
};

// Ordered list for printing
const dimOrder = [
    "ipAddress", "ipSubnet", "country", "date", "hour",
    "httpMethod", "url", "urlPath", "extension",
    "statusCode", "statusClass", "sizeBucket", "timeBucket",
    "referer", "userAgent", "uaFamily", "httpProtocol"
];

// ── Dimension display-name → internal key lookup ────────────────────────────
// Maps each dimension's display name (case-insensitive) to its internal key.
// This is used by --filter to resolve user-supplied dimension names.
const dimNameToKey = new Map();

for (const [key, counter] of Object.entries(dims)) {
    dimNameToKey.set(counter.name.toLowerCase(), key);
}

// Also register the URL Group dimension name for filter lookups
dimNameToKey.set("url group", "urlGroup");

// ── Validate filter dimension names ─────────────────────────────────────────
const resolvedFilters = filters.map(({ dimName, value }) => {
    const key = dimNameToKey.get(dimName.toLowerCase());

    if (!key) {
        const available = [...new Set([
            ...Object.values(dims).map((d) => d.name),
            ...(urlGroupDim ? ["URL Group"] : [])
        ])];

        console.error(`Error: unknown dimension '${dimName}'.`);
        console.error(`Available dimensions: ${available.join(", ")}`);
        process.exit(1);
    }

    return { key, value };
});

// ── Extract all dimension values from a single log line ─────────────────────
// Returns a plain object keyed by internal dimension key, or null if the line
// doesn't match the log format.
function extractRecord(line) {
    const m = LOG_RE.exec(line);

    if (!m) {
    // no match
        return null;
    }

    const [, ip, datetime, request, status, sizeStr, referer, ua, timeTakenStr, httpProtocol] = m;
    const rec = {};

    // IP address
    rec.ipAddress = ip;

    // IP /24 subnet
    const octets = ip.split(".");

    if (octets.length === 4) {
        rec.ipSubnet = `${octets[0]}.${octets[1]}.${octets[2]}.0/24`;
    } else {
        rec.ipSubnet = ip;
    }

    // Country (GeoIP)
    if (geoipDb) {
        const geo = geoipDb.get(ip);

        rec.country = geo && geo.country ? geo.country.iso_code : "(unknown)";
    }

    // Date & hour
    if (datetime) {
        const parts = datetime.split(":");

        rec.date = parts[0];
        rec.hour = parts[1] + ":00";
    }

    // Request line
    if (request) {
        const rp = request.split(" ");
        const method = rp[0];
        const rawUrl = rp[1];

        if (method) {
            rec.httpMethod = method;
        }

        if (rawUrl) {
            rec.url = rawUrl;

            // URL group
            if (urlGroupDim) {
                const group = matchUrlGroup(rawUrl);

                rec.urlGroup = group ?? "(unmatched)";
            }

            // URL path without query string
            const urlPath = rawUrl.split("?")[0];

            rec.urlPath = urlPath;

            // File extension
            const lastSeg = urlPath.split("/").pop() || "";
            const dotIdx = lastSeg.lastIndexOf(".");

            rec.extension = dotIdx >= 0 ? lastSeg.substring(dotIdx) : "(none)";
        }
    }

    // Status code
    if (status) {
        rec.statusCode = status;
        rec.statusClass = status[0] + "xx";
    }

    // Response size bucket
    if (sizeStr && sizeStr !== "-") {
        const bytes = parseInt(sizeStr, 10);

        if (!Number.isNaN(bytes)) {
            rec.sizeBucket = sizeBucket(bytes);
        }
    }

    // Time taken bucket
    if (timeTakenStr && timeTakenStr !== "-") {
        // Convert microseconds to milliseconds
        const timeTaken = parseInt(timeTakenStr, 10) / 1000;

        if (!Number.isNaN(timeTaken)) {
            rec.timeBucket = timeBucket(timeTaken);
        }
    }

    // Referer
    if (referer && referer !== "-") {
        rec.referer = referer;
    }

    // User-Agent
    if (ua && ua !== "-") {
        rec.userAgent = ua;
        rec.uaFamily = detectUAFamily(ua);
    }

    // HTTP Protocol
    if (httpProtocol) {
        rec.httpProtocol = httpProtocol;
    }

    return rec;
}

// ── Check whether a record passes all active filters ────────────────────────
function passesFilter(rec) {
    for (const { key, value } of resolvedFilters) {
        if ((rec[key] ?? "") !== value) {
            return false;
        }
    }

    return true;
}

// ── Add an extracted record to all dimension counters ───────────────────────
function addRecord(rec) {
    for (const key of dimOrder) {
        if (rec[key] !== null) {
            dims[key].add(rec[key]);
        }
    }

    if (urlGroupDim && rec.urlGroup !== null) {
        urlGroupDim.add(rec.urlGroup);
    }
}

// ── Progress bar ────────────────────────────────────────────────────────────
const stderrIsTTY = process.stderr.isTTY;
const stderrCols = () => (process.stderr.columns || 80);

function formatBytes(b) {
    if (b < 1024) {
        return b + " B";
    }

    if (b < 1048576) {
        return (b / 1024).toFixed(1) + " KB";
    }

    if (b < 1073741824) {
        return (b / 1048576).toFixed(1) + " MB";
    }

    return (b / 1073741824).toFixed(1) + " GB";
}

function renderProgress(bytesRead, totalBytes, lines) {
    if (!stderrIsTTY) {
        return;
    }

    const pct = Math.min(100, (bytesRead / totalBytes) * 100);
    const cols = stderrCols();
    const label = `  ${pct.toFixed(1).padStart(5)}%  ` +
      `${formatBytes(bytesRead).padStart(9)} / ${formatBytes(totalBytes)}  ${lines} lines `;

    // 2 brackets + 2 margin
    const barWidth = Math.max(10, cols - label.length - 4);
    const filled = Math.round((pct / 100) * barWidth);
    const bar = "█".repeat(filled) + "░".repeat(barWidth - filled);

    process.stderr.write(`\r${label}[${bar}]`);
}

function clearProgress() {
    if (!stderrIsTTY) {
        return;
    }

    process.stderr.write("\r" + " ".repeat(stderrCols()) + "\r");
}

// ── Output helpers ──────────────────────────────────────────────────────────
function pad(str, len) {
    str = String(str);

    return str + " ".repeat(Math.max(0, len - str.length));
}

function printDimension(dim, total, topN = 5) {
    const rows = dim.top(topN);

    if (rows.length === 0) {
        return;
    }

    console.log(`${BLD}── ${dim.name} ──────────────────────────────────────────${RST}`);
    console.log(`  ${BLD}${pad("Count", 9)}${pad("%", 9)}Value${RST}`);
    console.log(`  ${pad("------", 9)}${pad("------", 9)}-----`);

    for (const [value, count] of rows) {
        const pct = ((count / total) * 100).toFixed(1);
        const exceeds = parseFloat(pct) > threshold;

        if (exceeds) {
            console.log(
                `  ${RED}${pad(count, 9)}${pad(pct + "%", 9)}${value}${RST}  ${YEL}◀ exceeds ${threshold}%${RST}`
            );
        } else {
            console.log(`  ${pad(count, 9)}${pad(pct + "%", 9)}${value}`);
        }
    }

    console.log();
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
    // Load GeoIP database if configured
    if (geoipFile) {
        geoipDb = await require("maxmind").open(geoipFile);
    }

    const fileSizeBytes = fs.statSync(logFile).size;
    let bytesRead = 0;
    let lastProgressUpdate = 0;

    const stream = fs.createReadStream(logFile);

    stream.on("data", (chunk) => {
        bytesRead += chunk.length;
    });

    const rl = readline.createInterface({
        input: stream,
        crlfDelay: Infinity
    });

    // lines read from file
    let scanned = 0;

    // lines that passed the filter
    let matched = 0;

    // lines that were filtered out
    let skipped = 0;

    // Whether any filters are active (used to decide if we should count skipped lines)
    const hasFilter = resolvedFilters.length > 0;

    for await (const line of rl) {
        if (line.trim() === "") {
            continue;
        }

        scanned++;

        const rec = extractRecord(line);

        if (!rec) {
            skipped++;

            continue;
        }

        if (hasFilter && !passesFilter(rec)) {
            // Throttle progress even for skipped lines
            const now = Date.now();

            if (now - lastProgressUpdate > 50) {
                renderProgress(bytesRead, fileSizeBytes, scanned);
                lastProgressUpdate = now;
            }

            continue;
        }

        matched++;
        addRecord(rec);

        // Throttle progress updates to ~every 50 ms
        const now = Date.now();

        if (now - lastProgressUpdate > 50) {
            renderProgress(bytesRead, fileSizeBytes, scanned);
            lastProgressUpdate = now;
        }
    }

    // Final 100 % tick and clear
    renderProgress(fileSizeBytes, fileSizeBytes, scanned);
    clearProgress();

    const total = matched;

    if (total === 0) {
        if (hasFilter) {
            console.error("No lines matched the specified filter(s).");
        } else {
            console.error("Log file is empty or contains no parseable lines." +
              ` (${scanned} lines scanned, ${skipped} skipped)`);
        }

        process.exit(1);
    }

    // Header
    console.log(`${BLD}════════════════════════════════════════════════════════════${RST}`);
    console.log(`${BLD}  Apache Access-Log Top Dimensions${RST}`);
    console.log(`${BLD}════════════════════════════════════════════════════════════${RST}`);
    console.log(`  Log file  : ${CYN}${logFile}${RST}`);
    console.log(`  Total hits: ${CYN}${total}${RST}` +
        `${hasFilter ? `  (${scanned} scanned, ${scanned - matched} filtered out)` : ""}`);
    console.log(`  Threshold : ${CYN}${threshold}%${RST}  (values above this are ${RED}highlighted${RST})`);

    if (geoipFile) {
        console.log(`  GeoIP DB  : ${CYN}${geoipFile}${RST}`);
    }

    if (groupsFile) {
        console.log(`  URL groups: ${CYN}${groupsFile}${RST}  (${urlGroups.length} rules loaded)`);
    }

    for (const f of filters) {
        console.log(`  Filter    : ${CYN}${f.dimName}${RST} = ${CYN}${f.value}${RST}`);
    }

    console.log(`${BLD}════════════════════════════════════════════════════════════${RST}`);
    console.log();

    // Print each built-in dimension
    for (const key of dimOrder) {
        printDimension(dims[key], total, 5);
    }

    // Print URL group dimension (if loaded)
    if (urlGroupDim) {
        printDimension(urlGroupDim, total, 5);
    }

    // Footer
    console.log(`${BLD}════════════════════════════════════════════════════════════${RST}`);
    console.log(`  Done. ${total} log entries analysed.`);
    console.log(`${BLD}════════════════════════════════════════════════════════════${RST}`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
