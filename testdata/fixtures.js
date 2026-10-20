'use strict';
// The template the tests start from: the sample view document of the view
// format, 14 tiles in all nine kinds.
const fs = require('fs');
const path = require('path');

const SAMPLE = path.join(__dirname, 'view-v1.sample.json');
const text = fs.readFileSync(SAMPLE, 'utf8');

function template() {
    return JSON.parse(text);
}

module.exports = { template, SAMPLE };
