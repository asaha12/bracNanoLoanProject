#!/usr/bin/env node

const readline = require('readline');
const { getClient } = require('./db');
const { NanoLoanEvaluator } = require('./nanoLoanEngine');
const { generateReport } = require('./reporter');

async function evaluateAndDisplay(memberIdOrNo) {
  const client = getClient();
  try {
    await client.connect();
    const evaluator = new NanoLoanEvaluator(client);
    await evaluator.loadConfig();
    const res = await evaluator.evaluateMember(memberIdOrNo);
    generateReport(res);
  } catch (err) {
    console.error('❌ Error during evaluation:', err.message);
  } finally {
    await client.end();
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 0) {
    const memberId = args[0].trim();
    await evaluateAndDisplay(memberId);
  } else {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    rl.question('Please enter Member ID (e.g. 16273461, 34145511): ', async (answer) => {
      rl.close();
      const memberId = answer.trim();
      if (!memberId) {
        console.log('No Member ID entered. Exiting.');
        return;
      }
      await evaluateAndDisplay(memberId);
    });
  }
}

main();
