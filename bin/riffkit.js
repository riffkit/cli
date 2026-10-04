#!/usr/bin/env node
import { main } from '../src/main.js'

// A reader that stops early (riffkit list_videos | head) is not an error.
process.stdout.on('error', (err) => {
  if (err.code !== 'EPIPE') throw err
})

process.exitCode = await main(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  // Opened only when a spend asks for confirmation.
  get stdin() { return process.stdin },
  env: process.env,
})
