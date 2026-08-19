/* Loads named functions out of the renderer source and evaluates them against
   stubs. The renderer is one flat script with DOM access at the top level, so
   it cannot be require()d — this pulls out the units under test verbatim, which
   keeps the tests honest: they exercise the shipped code, not a copy of it. */
const fs = require('fs');
const path = require('path');

const SOURCE = path.join(__dirname, '..', '..', 'src', 'renderer', 'js', 'tracker-renderer.js');

function readSource() {
    return fs.readFileSync(SOURCE, 'utf8');
}

/** Text from the line beginning `marker` through the end of `endMarker`. */
function slice(source, marker, endMarker) {
    const start = source.indexOf(marker);
    if (start === -1) throw new Error(`marker not found: ${marker}`);
    const end = source.indexOf(endMarker, start);
    if (end === -1) throw new Error(`end marker not found: ${endMarker}`);
    return source.slice(start, end + endMarker.length);
}

module.exports = { readSource, slice, SOURCE };
