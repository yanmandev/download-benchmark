#!/usr/bin/env node
'use strict';

const { parseArgs } = require('node:util');
const { performance } = require('node:perf_hooks');

const DEFAULT_COUNT = 10;
const MAX_COUNT = 10000;
const MAX_FILE_BYTES = 1e9; // 1 GB

const USAGE = `Usage: node index.js <url> [-n <count>]

  <url>              http(s) address to download (file up to 1 GB)
  -n, --count <num>  number of sequential requests, 1..${MAX_COUNT} (default: ${DEFAULT_COUNT})
  -h, --help         show this help`;

function parseCliArgs(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      count: { type: 'string', short: 'n' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.help) {
    console.log(USAGE);
    process.exit(0);
  }

  if (positionals.length !== 1) {
    throw new Error('Exactly one URL is required');
  }

  return {
    url: validateUrl(positionals[0]),
    count: validateCount(values.count),
  };
}

function validateUrl(input) {
  let url;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error(`Invalid URL: "${input}"`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Only http and https are supported, got "${url.protocol}"`);
  }

  return url.href;
}

function validateCount(input) {
  if (input === undefined) {
    return DEFAULT_COUNT;
  }

  const count = Number(input);
  if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) {
    throw new Error(`Request count must be an integer from 1 to ${MAX_COUNT}, got "${input}"`);
  }

  return count;
}

// Downloads the whole response body and returns its size in bytes and the elapsed time in ms.
async function measureRequest(url) {
  const start = performance.now();
  const response = await fetch(url, { headers: { 'Cache-Control': 'no-cache' } });

  if (!response.ok) {
    throw new Error(`Server responded with ${response.status} ${response.statusText}`);
  }

  const declaredSize = Number(response.headers.get('content-length'));
  if (declaredSize > MAX_FILE_BYTES) {
    await response.body.cancel();
    throw fileTooLargeError();
  }

  // Content-Length may be missing or wrong, so the size is also checked while reading.
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > MAX_FILE_BYTES) {
      throw fileTooLargeError();
    }
  }

  return { bytes, ms: performance.now() - start };
}

function fileTooLargeError() {
  return new Error(`File is larger than the ${MAX_FILE_BYTES / 1e9} GB limit`);
}

async function runBenchmark(url, count) {
  const results = [];

  for (let i = 1; i <= count; i++) {
    const result = await measureRequest(url);
    console.log(`#${i}: ${formatMegabytes(result.bytes)} MB in ${result.ms.toFixed(0)} ms`);
    results.push(result);
  }

  return results;
}

function summarize(results) {
  const totalBytes = results.reduce((sum, r) => sum + r.bytes, 0);
  const totalMs = results.reduce((sum, r) => sum + r.ms, 0);

  return {
    totalBytes,
    averageMs: totalMs / results.length,
    // bits / microseconds = megabits per second
    speedMbps: (totalBytes * 8) / (totalMs * 1000),
  };
}

function formatMegabytes(bytes) {
  return (bytes / 1e6).toFixed(2);
}

function printSummary({ totalBytes, averageMs, speedMbps }) {
  console.log('');
  console.log(`Average request time: ${averageMs.toFixed(0)} ms`);
  console.log(`Total downloaded:     ${formatMegabytes(totalBytes)} MB`);
  console.log(`Download speed:       ${speedMbps.toFixed(2)} Mbit/s`);
}

async function main() {
  let options;
  try {
    options = parseCliArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`Error: ${err.message}\n\n${USAGE}`);
    process.exit(1);
  }

  console.log(`Downloading ${options.url} ${options.count} time(s)...\n`);

  try {
    const results = await runBenchmark(options.url, options.count);
    printSummary(summarize(results));
  } catch (err) {
    console.error(`Request failed: ${err.cause?.message ?? err.message}`);
    process.exit(1);
  }
}

main();
