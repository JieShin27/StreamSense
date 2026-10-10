#!/usr/bin/env node
// Installs the WorkBuddy agent engine on this computer if needed, then opens it so you can sign in once.
//   npm run workbuddy:login      then type /login, choose the international site, sign in, and type /exit

import { spawnSync } from 'node:child_process';

const PACKAGE = '@tencent-ai/codebuddy-code';
const run = (args) => spawnSync('npm', args, { stdio: 'inherit', shell: true });

if (spawnSync('npm', ['ls', '-g', PACKAGE, '--depth=0'], { shell: true }).status !== 0) {
  console.log('Installing the WorkBuddy agent engine (one time, about a minute)...');
  if (run(['install', '-g', PACKAGE]).status !== 0) process.exit(1);
}

console.log('Opening the WorkBuddy agent engine.');
console.log('Type  /login  and follow the steps, then type  /exit .\n');
process.exit(spawnSync('codebuddy', [], { stdio: 'inherit', shell: true }).status ?? 0);
