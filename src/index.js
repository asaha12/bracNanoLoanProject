#!/usr/bin/env node

const readline = require('readline');
const { loadAppConfig } = require('./config/appConfig');
const { getClient } = require('./db/connection');
const { NanoLoanEvaluator } = require('./engine/nanoLoanEvaluator');
const { generateReport } = require('./reporters/consoleReporter');

async function evaluateAndDisplay(memberIdOrNo) {
  const appConfig = loadAppConfig();
  const client = getClient(appConfig);

  try {
    await client.connect();
    const evaluator = new NanoLoanEvaluator(client, appConfig);
    await evaluator.loadLiveConfiguration();
    const res = await evaluator.evaluateMember(memberIdOrNo);
    generateReport(res);
  } catch (err) {
    console.error('❌ Error during evaluation:', err.message);
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
  }
}

function promptForMemberId() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    rl.question('Please enter Member ID (e.g. 16273461, 16292015, 34145511): ', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  let memberId = args.length > 0 ? args[0].trim() : '';

  if (!memberId) {
    memberId = await promptForMemberId();
    if (!memberId) {
      console.log('No Member ID entered. Exiting.');
      return;
    }
  }

  await evaluateAndDisplay(memberId);
}

main();
