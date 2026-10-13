<?php
/* Precision QC — usage-log receiver (level B, docs/LOGGING.md).
 * Upload this folder (log.php + data/.htaccess) next to the web app, then set
 * logEndpoint in the app's config.js to "log/log.php" (path relative to the page).
 *
 * Write-only: it accepts anonymous, numbers-only events from the browser, checks them
 * against a whitelist, and appends them to data/usage-YYYYMMDD.jsonl. It never reads
 * anything back and stores no IP address (an hourly hash of it is used only for rate
 * limiting). Same-origin only. Needs PHP 7.4+. Download the logs over SFTP. */

const MAX_BODY = 32768;      // bytes per request
const MAX_EVENTS = 50;       // events per request
const MAX_PER_HOUR = 600;    // events per visitor per hour
const KEEP_DAYS = 365;       // older files are deleted

const EVENTS = ['page_open', 'analyze_done', 'analyze_error', 'param_change', 'export', 'feedback', 'log_download', 'consent'];
const KEYS = ['v', 'ts', 'session', 'event', 'app', 'mode', 'source', 'image', 'params', 'result', 'timing_ms', 'batch', 'changed', 'feedback', 'error', 'format', 'n', 'env', 'referrer_same_site', 'granted'];

function done(int $code): void { http_response_code($code); exit; }

/* a value is kept only if it is a short string / number / bool / null, or a small
 * array of those (two levels deep at most) - nothing else can reach the file */
function clean($v, int $depth = 0) {
    if (is_string($v)) return mb_substr($v, 0, 80);
    if (is_int($v) || is_bool($v) || $v === null) return $v;
    if (is_float($v)) return is_finite($v) ? $v : null;
    if (is_array($v) && $depth < 3 && count($v) <= 40) {
        $out = [];
        foreach ($v as $k => $x) $out[is_int($k) ? $k : mb_substr((string)$k, 0, 40)] = clean($x, $depth + 1);
        return $out;
    }
    return null;
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') { header('Allow: POST'); done(405); }

// same-origin only: the browser's Origin must be this very host
$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if ($origin !== '' && strcasecmp((string)parse_url($origin, PHP_URL_HOST), preg_replace('/:\d+$/', '', $_SERVER['HTTP_HOST'] ?? '')) !== 0) done(403);

$len = (int)($_SERVER['CONTENT_LENGTH'] ?? 0);
if ($len > MAX_BODY) done(413);
$body = file_get_contents('php://input', false, null, 0, MAX_BODY + 1);
if ($body === false || $body === '' || strlen($body) > MAX_BODY) done(400);
$in = json_decode($body, true, 8);
if (!is_array($in) || ($in['v'] ?? null) !== 1 || !isset($in['events']) || !is_array($in['events']) || count($in['events']) > MAX_EVENTS) done(400);

$dir = __DIR__ . '/data';
if (!is_dir($dir) && !@mkdir($dir, 0755, true)) done(500);

// rate limit: events per hour, keyed by a salted hash of the visitor (no IP is stored)
$salt = hash('sha256', __FILE__ . date('YmdH'));
$ipKey = substr(hash('sha256', ($_SERVER['REMOTE_ADDR'] ?? '') . $salt), 0, 16);
$rate = "$dir/.rate-" . date('YmdH') . "-$ipKey";
$used = is_file($rate) ? (int)@file_get_contents($rate) : 0;
if ($used + count($in['events']) > MAX_PER_HOUR) done(429);
@file_put_contents($rate, (string)($used + count($in['events'])), LOCK_EX);

$lines = '';
foreach ($in['events'] as $e) {
    if (!is_array($e) || ($e['v'] ?? null) !== 1 || !in_array($e['event'] ?? '', EVENTS, true)) continue;
    if (!preg_match('/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/', (string)($e['ts'] ?? ''))) continue;
    if (!preg_match('/^[0-9a-f]{8,32}$/', (string)($e['session'] ?? ''))) continue;
    $row = [];
    foreach (KEYS as $k) if (array_key_exists($k, $e)) $row[$k] = clean($e[$k]);
    $row['received'] = gmdate('Y-m-d\TH:i:s\Z');
    $lines .= json_encode($row, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . "\n";
}
if ($lines !== '' && @file_put_contents($dir . '/usage-' . gmdate('Ymd') . '.jsonl', $lines, FILE_APPEND | LOCK_EX) === false) done(500);

// housekeeping (cheap, ~1 in 50 requests): drop old logs and stale rate files
if (random_int(1, 50) === 1) {
    foreach (glob("$dir/usage-*.jsonl") ?: [] as $f) if (filemtime($f) < time() - KEEP_DAYS * 86400) @unlink($f);
    foreach (glob("$dir/.rate-*") ?: [] as $f) if (filemtime($f) < time() - 7200) @unlink($f);
}
done(204);
