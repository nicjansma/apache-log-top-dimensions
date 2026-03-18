# apache-log-top-dimensions

A zero-dependency* Node.js CLI tool that parses an **Apache Combined Log Format** access log, ranks the top values for every extracted dimension, and highlights any value that exceeds a user-defined percentage of total traffic.

(\**Adding MaxMind country-code lookup `--geoip` adds a single dependency*)

## Features

- **17 built-in dimensions** extracted in a single streaming pass:

  | Dimension            | Example                               |
  |----------------------|---------------------------------------|
  | IP Address           | `192.168.1.1`                         |
  | IP Subnet (/24)      | `192.168.1.0/24`                      |
  | Country              | `US`, `DE`, `JP`, ...                 |
  | Date                 | `10/Oct/2000`                         |
  | Hour                 | `13:00`                               |
  | HTTP Method          | `GET`                                 |
  | URL (full)           | `/index.html?q=test`                  |
  | URL Path (no query)  | `/index.html`                         |
  | File Extension       | `.html`                               |
  | HTTP Status Code     | `200`                                 |
  | Status Class         | `2xx`                                 |
  | Response Size Bucket | `1K-10K`                              |
  | Referer              | `https://example.com/`                |
  | User-Agent           | *(full string)*                       |
  | User-Agent Family    | `Chrome`, `Firefox`, `Googlebot`, ... |
  | Response Time Bucket | `0-100ms`                             |
  | HTTP Protocol        | `HTTP/1.1`                            |

- **GeoIP Country lookup** — resolve IP addresses to ISO country codes using a free MaxMind GeoLite2-Country database
- **Custom URL Groups** — supply a file of regex rules to classify URLs into your own categories (e.g. "Wiki page", "API call", "Static asset")
- **Top 5** values shown for each dimension with hit count and percentage
- Values exceeding the threshold are **highlighted in red** with a `◀ exceeds N%` marker
- **Progress bar** on stderr while reading (percentage, bytes, line count)
- **TTY-aware** — colours and progress bar are automatically disabled when output is piped or redirected
- **Streaming** — reads line-by-line so it can handle large log files without high memory usage
- **Minimal dependencies** — one optional runtime dependency (`maxmind`) for GeoIP lookups

## Requirements

- Node.js **14+** (uses `for await...of` and `??` operator)

## Installation

```bash
git clone <repo-url>
cd apache-log-top-dimensions
```

Then install dependencies (only when using MaxMind):

```bash
npm install
```

## Usage

```bash
node apache-log-top.js <logfile> [threshold_percent] [options]
```

| Argument            | Description                                                    | Default           |
|---------------------|----------------------------------------------------------------|-------------------|
| `logfile`           | Path to an Apache Combined-format access log                   | *(required)*      |
| `threshold_percent` | Highlight any value exceeding this % of total hits             | `30`              |
| `--groups`, `-g`    | Path to a URL-groups definition file                           | *(none)*          |
| `--geoip`, `-G`     | Path to a MaxMind GeoLite2-Country `.mmdb` file                | *(auto-detected)* |
| `--filter`, `-f`    | Only count lines where a dimension equals a value (repeatable) | *(none)*          |

### Examples

```bash
# Use the default 30% threshold
node apache-log-top.js /var/log/apache2/access.log

# Use a 20% threshold
node apache-log-top.js /var/log/apache2/access.log 20

# Pipe output (colours auto-disabled)
node apache-log-top.js access.log > report.txt

# With custom URL groups
node apache-log-top.js access.log 25 --groups url-groups.txt

# Filter to a single IP address
node apache-log-top.js access.log --filter "IP Address=192.168.1.1"

# Combine multiple filters (AND logic) — POST requests that returned 5xx
node apache-log-top.js access.log -f "HTTP Method=POST" -f "Status Class=5xx"

# Filter by URL Group (requires --groups)
node apache-log-top.js access.log --groups url-groups.txt --filter "URL Group=Homepage"

# With an explicit GeoIP database path
node apache-log-top.js access.log --geoip /path/to/GeoLite2-Country.mmdb

# Filter to traffic from a single country
node apache-log-top.js access.log --filter "Country=US"
```

### Filtering

Use `--filter "Dimension Name=value"` (or `-f`) to restrict analysis to only the log lines where a dimension has exactly the given value. All other dimensions are then computed only over the filtered set.

- Multiple `--filter` flags combine with **AND** logic.
- Dimension names are **case-insensitive** and must match one of the displayed dimension names (e.g. `IP Address`, `HTTP Method`, `Status Class`, `URL Group`, etc.).
- The header shows how many lines were scanned vs. how many passed the filter.

## GeoIP Country Lookup

The tool can resolve IP addresses to ISO country codes (e.g. `US`, `DE`, `JP`) using a [MaxMind GeoLite2-Country](https://dev.maxmind.com/geoip/geolite2-free-geolocation-data) database.

### Setup

1. Sign up for a free MaxMind account and download the **GeoLite2-Country** database in `.mmdb` format.
2. Place `GeoLite2-Country.mmdb` in the same directory as your log file — it will be auto-detected.
3. Alternatively, specify the path explicitly with `--geoip /path/to/GeoLite2-Country.mmdb`.

When a GeoIP database is loaded, a **Country** dimension appears in the output showing the top countries by hit count. IPs that cannot be resolved show as `(unknown)`.

### Sample GeoIP output

```text
── Country ──────────────────────────────────────────
  Count    %        Value
  ------   ------   -----
  5610     56.1%    US        ◀ exceeds 30%
  2770     27.7%    DE
  180      1.8%     SG
  150      1.5%     NL
  130      1.3%     JP
```

## URL Groups File

A URL groups file lets you classify request URLs into custom categories that appear as an extra **"URL Group"** dimension in the output.

### Format

One rule per line:

```text
<regex>  =>  <output_expression>
```

- Lines starting with `#` are comments. Blank lines are ignored.
- The regex is tested against the full request URL (including query string).
- The output expression can reference capture groups with `$1`, `$2`, etc.
- If no `=>` separator is given, the full regex match (`$0`) is the output value.
- Rules are evaluated top-to-bottom; **first match wins**.
- URLs that match no rule are counted as `(unmatched)`.

### Example file

Here's an example URL Groups file:

```text
# URL Groups definition file
#
# Each line defines a rule:  <regex>  =>  <output_expression>
#
# - Lines starting with # are comments.
# - Blank lines are ignored.
# - The regex is matched against the full request URL (including query string).
# - The output expression can use $1, $2, ... to reference capture groups.
# - If no  =>  separator is present, the full regex match ($0) is used.
#
# Rules are evaluated top-to-bottom; the first match wins.

# ── Wiki / content pages ────────────────────────────────
^/wiki/(.+)$                    => Wiki: $1
^/w/index\.php                  => Wiki engine (index.php)

# ── API endpoints ───────────────────────────────────────
^/api/v[0-9]+/(.*)              => API: $1
^/api/                          => API (other)

# ── Static assets ───────────────────────────────────────
^/(images|css|js|fonts)/        => Static: $1
\.(png|jpe?g|gif|svg|ico)(\?|$) => Image
\.(css)(\?|$)                   => Stylesheet
\.(js)(\?|$)                    => JavaScript

# ── Common paths ────────────────────────────────────────
^/robots\.txt$                  => robots.txt
^/favicon\.ico$                 => favicon
^/sitemap.*\.xml                => Sitemap
^/$                             => Homepage
```

### Sample output

```text
── URL Group ──────────────────────────────────────────
  Count    %        Value
  ------   ------   -----
  4120     41.2%    Wiki: Main_Page     ◀ exceeds 30%
  2301     23.0%    Static: images
  1580     15.8%    Image
  988      9.9%     API: search
  411      4.1%     Homepage
```

## Sample Output

```text
════════════════════════════════════════════════════════════
  Apache Access-Log Top Dimensions
════════════════════════════════════════════════════════════
  Log file  : access.log
  Total hits: 10000
  Threshold : 30%  (values above this are highlighted)
════════════════════════════════════════════════════════════

── HTTP Method ──────────────────────────────────────────
  Count    %        Value
  ------   ------   -----
  7821     78.2%    GET       ◀ exceeds 30%
  1504     15.0%    POST
  389      3.9%     HEAD
  201      2.0%     PUT
  85       0.9%     DELETE

── HTTP Status Code ──────────────────────────────────────
  Count    %        Value
  ------   ------   -----
  6502     65.0%    200       ◀ exceeds 30%
  1830     18.3%    304
  901      9.0%     404
  412      4.1%     301
  355      3.6%     500
...
```

## Expected Log Format

The tool expects **Apache Combined Log Format** with two additional fields:

- `%D` for HTTP Response Time
- `%H` for HTTP Version

```conf
LogFormat "%a %l %u %t \"%r\" %>s %O \"%{Referer}i\" \"%{User-Agent}i\" %D %H" combinedplus
```

Example line:

```text
192.168.1.1 - - [10/Oct/2000:13:55:36 -0700] "GET /index.html HTTP/1.0" 200 2326 "http://www.example.com/start.html" "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" 123 HTTP/1.1
```

Lines that don't match this format are silently skipped.

## AI Disclosure

This application was written with AI assistance (Claude Opus 4.6) for code generation, iterative feature development, and review.

## License

MIT

## Version History

- v1.0.0 - 2026-03-07: Initial version release
- v1.1.0 - 2026-03-18: Added Country lookup
