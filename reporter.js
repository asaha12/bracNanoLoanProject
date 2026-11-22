function formatCurrency(val) {
  if (val === null || val === undefined) return 'N/A';
  return 'BDT ' + Number(val).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function printSectionHeader(title) {
  console.log('\n' + '='.repeat(80));
  console.log(`  ${title}`);
  console.log('='.repeat(80));
}

function printSubHeader(title) {
  console.log('\n' + '-'.repeat(80));
  console.log(`  ${title}`);
  console.log('-'.repeat(80));
}

function generateReport(res) {
  if (res.error) {
    console.error('\n❌ ERROR:', res.error);
    return;
  }

  const { member, evaluation, allGeneralLoans, systemRecord } = res;
  const isEligible = evaluation.overallStatus === 'ELIGIBLE';

  printSectionHeader(`BRAC NANO LOAN - MEMBER ELIGIBILITY & CREDIT SCORE QA BREAKDOWN`);

  const displayFinalScore = evaluation.systemFinalScore !== undefined ? evaluation.systemFinalScore : evaluation.finalScore;

  console.log(`
👤 MEMBER INFORMATION:
  - Member ID        : ${member.id}
  - Member Number    : ${member.memberNo}
  - Member Name      : ${member.name}
  - Branch Office    : [${member.branchCode || 'N/A'}] ${member.branchName || 'N/A'} (ID: ${member.branchId})
  - Project          : ${member.projectName || 'N/A'} (ID: ${member.projectId})
  - Evaluation Date  : ${evaluation.businessDate}
  - Assessment Status: ${isEligible ? '✅ ELIGIBLE' : '❌ NOT ELIGIBLE'}
  ${!isEligible ? `- Failure Reason   : [Step ${evaluation.failedStep}] ${evaluation.failedReason}` : ''}
  - Min Loan Ceiling : ${formatCurrency(evaluation.minEligibleAmount)}
  - Max Loan Ceiling : ${formatCurrency(evaluation.maxEligibleAmount)}
  - Final Score      : ${displayFinalScore.toFixed(3)} (Threshold: ${evaluation.step5.requiredScore})
  `);

  // STEP 1
  printSubHeader(`STEP 1: Minimum Loan Cycle Evaluation (Sequence 1)`);
  console.log(`  Configured Rule  : Minimum ${evaluation.step1.requiredCount} General Loans within last 4 years (after ${evaluation.step1.historyCutoff})`);
  console.log(`  Actual Evaluated : ${evaluation.step1.actualCount} General Loans found`);
  console.log(`  Step Verdict     : ${evaluation.step1.passed ? '✅ PASS' : '❌ FAIL - ' + evaluation.step1.reason}`);
  console.log(`\n  General Loans History (${allGeneralLoans.length} total loans found):`);
  console.table(allGeneralLoans.map(l => ({
    'Loan ID': l.id,
    'Account No': l.accountNo,
    'Disbursed Date': l.disbursementDate,
    'Disbursed Amount': formatCurrency(l.disbursedAmount),
    'Outstanding': formatCurrency(l.outstandingBalance),
    'Status': Number(l.statusId) === 1 ? 'Running (1)' : Number(l.statusId) === 2 ? 'Closed (2)' : `Status ${l.statusId}`,
    'In 4-Yr Window': (l.disbursementDate >= evaluation.step1.historyCutoff && l.disbursementDate <= evaluation.businessDate) ? 'YES' : 'NO'
  })));

  // STEP 2
  printSubHeader(`STEP 2: Running Loan Repayment Requirement (Sequence 2)`);
  if (!evaluation.step2.hasRunningLoan) {
    console.log(`  Status           : ℹ️ Member has no active running loan (all loans closed).`);
    console.log(`  Rule Impact      : Step 2 criteria is automatically SKIPPED as per SRS business exception.`);
    console.log(`  Step Verdict     : ✅ PASS (Skipped)`);
  } else {
    console.log(`  Running Loan ID  : ${evaluation.step2.runningLoanId}`);
    console.log(`  Disbursed Amount : ${formatCurrency(evaluation.step2.disbursedAmount)}`);
    console.log(`  Outstanding Bal  : ${formatCurrency(evaluation.step2.outstandingBalance)}`);
    console.log(`  Formula          : (Disbursed - Outstanding) / Disbursed * 100`);
    console.log(`  Repaid Percentage: ${evaluation.step2.repaidPct}%`);
    console.log(`  Required Threshold: >= ${evaluation.step2.requiredPct}%`);
    console.log(`  Step Verdict     : ${evaluation.step2.passed ? '✅ PASS' : '❌ FAIL - ' + evaluation.step2.reason}`);
  }

  // STEP 3
  printSubHeader(`STEP 3: Due Month Repayment Criteria (Sequence 3)`);
  console.log(`  Evaluation Period: Last ${evaluation.step3.evaluationPeriodMonths} Months (since ${evaluation.step3.evaluationPeriodCutoff})`);
  console.log(`  Rule             : All repayments must be completed within the respective repayment month`);
  console.log(`  Checked Trx Count: ${evaluation.step3.totalCollectionsChecked} collections examined`);
  console.log(`  Step Verdict     : ${evaluation.step3.passed ? '✅ PASS' : '❌ FAIL - ' + evaluation.step3.reason}`);

  // STEP 4
  printSubHeader(`STEP 4: Eligible Loan Amount & Ceiling Calculation (Sequence 4)`);
  console.log(`  Number of Loans to Average : ${evaluation.step4.loansAveragedCount} loans`);
  console.log(`  Loans Averaged             : ${evaluation.step4.loansAveraged.map(l => `${l.id} (${formatCurrency(l.disbursed)})`).join(', ')}`);
  console.log(`  Average Disbursed Amount   : ${formatCurrency(evaluation.step4.avgDisbursedAmount)}`);
  console.log(`  Eligible Loan Percentage   : ${evaluation.step4.eligiblePercentage}%`);
  console.log(`  Formula                    : Average Disbursed * 20%`);
  console.log(`  Calculated Ceiling         : ${formatCurrency(evaluation.step4.computedCeiling)}`);
  console.log(`  Project Ceiling Range      : ${formatCurrency(evaluation.step4.projectMinCeiling)} - ${formatCurrency(evaluation.step4.projectMaxCeiling)}`);
  console.log(`  Step Verdict               : ${evaluation.step4.passed ? '✅ PASS' : '❌ FAIL - ' + evaluation.step4.reason}`);
  if (evaluation.step4.passed) {
    console.log(`  Final Min Eligible Amount  : ${formatCurrency(evaluation.step4.minEligibleAmount)}`);
    console.log(`  Final Max Eligible Amount  : ${formatCurrency(evaluation.step4.maxEligibleAmount)}`);
  }

  // STEP 5
  printSubHeader(`STEP 5: Credit Risk Scoring & Final Score (Sequence 5)`);
  if (systemRecord.scoreDetails && systemRecord.scoreDetails.length > 0) {
    console.log(`  Official System Score Parameter Breakdown (stored in credit_risk_model_eligibility_score_detail):`);
    console.table(systemRecord.scoreDetails.map(sd => ({
      'Parameter Code': sd.parameter_code,
      'Loan ID': sd.loan_account_id || 'MEMBER LEVEL',
      'Behavior Condition': sd.behaviour_label,
      'Numerator': sd.numerator ? Number(sd.numerator) : 'N/A',
      'Denominator': sd.denominator ? Number(sd.denominator) : 'N/A',
      'Raw Value': sd.raw_value ? `${Number(sd.raw_value).toFixed(4)}%` : 'N/A',
      'Assigned Score': Number(sd.score_value).toFixed(3)
    })));

    const sysRow = systemRecord.eligibleRow || {};
    console.log(`  System Parameter Summary Scores:`);
    console.log(`  - Param 1 (Installment Payment Behavior) : ${Number(sysRow.param1_score || 0).toFixed(3)}`);
    console.log(`  - Param 2 (Savings Paid with Installment): ${Number(sysRow.param2_score || 0).toFixed(3)}`);
    console.log(`  - Param 3 (Savings Adjustment Prev Loan) : ${Number(sysRow.param3_score || 0).toFixed(3)}`);
    console.log(`  - Param 4 (Savings Withdrawal in Window) : ${Number(sysRow.param4_score || 0).toFixed(3)}`);
    console.log(`\n  Final Credit Score Calculation:`);
    console.log(`  Formula          : (Param1 + Param2 + Param3 + Param4) / 4`);
    console.log(`                   : (${Number(sysRow.param1_score).toFixed(3)} + ${Number(sysRow.param2_score).toFixed(3)} + ${Number(sysRow.param3_score).toFixed(3)} + ${Number(sysRow.param4_score).toFixed(3)}) / 4`);
    console.log(`  Final Score      : ${Number(sysRow.final_score).toFixed(3)}`);
    console.log(`  Required Score   : >= ${evaluation.step5.requiredScore}`);
    console.log(`  Step Verdict     : ${Number(sysRow.final_score) >= evaluation.step5.requiredScore ? '✅ PASS' : '❌ FAIL'}`);
  } else {
    const s5 = evaluation.step5;
    console.log(`  1. Installment Payment Behavior Score : ${s5.param1.score.toFixed(3)}`);
    s5.param1.details.forEach(d => {
      console.log(`     - Loan ${d.loanId}: ${d.behaviorLabel} (Score: ${d.score})`);
    });

    console.log(`  2. Savings Paid with Installment Score: ${s5.param2.score.toFixed(3)}`);
    s5.param2.details.forEach(d => {
      console.log(`     - Loan ${d.loanId}: Ratio ${d.ratioPct}% -> ${d.behaviorLabel} (Score: ${d.score})`);
    });

    console.log(`  3. Savings Adjustment of Prev Loan    : ${s5.param3.score.toFixed(3)}`);
    s5.param3.details.forEach(d => {
      console.log(`     - Loan ${d.loanId}: ${d.adjustmentPct}% adjustment -> ${d.behaviorLabel} (Score: ${d.score})`);
    });

    console.log(`  4. Savings Withdrawal Before Repayment: ${s5.param4.score.toFixed(3)}`);
    console.log(`     - Behavior: ${s5.param4.label} (Withdrawals in window: ${s5.param4.withdrawalCount})`);

    console.log(`\n  Final Credit Score Calculation:`);
    console.log(`  Formula          : (Param1 + Param2 + Param3 + Param4) / 4`);
    console.log(`                   : (${s5.param1.score.toFixed(3)} + ${s5.param2.score.toFixed(3)} + ${s5.param3.score.toFixed(3)} + ${s5.param4.score.toFixed(3)}) / 4`);
    console.log(`  Final Score      : ${s5.finalScore.toFixed(3)}`);
    console.log(`  Required Score   : >= ${s5.requiredScore}`);
    console.log(`  Step Verdict     : ${s5.passed ? '✅ PASS' : '❌ FAIL - ' + s5.reason}`);
  }

  // QA RECONCILIATION
  printSectionHeader(`QA DATABASE RECONCILIATION`);
  if (systemRecord.foundInEligibleTable) {
    const sys = systemRecord.eligibleRow;
    console.log(`  [Found in credit_risk_model_eligible_member table - Run ID: ${sys.run_id}]`);
    console.log(`  ---------------------------------------------------------------------`);
    console.log(`  Metric                   | Engine Calculated  | Database Stored    | QA Match?`);
    console.log(`  -------------------------+--------------------+--------------------+----------`);
    
    const checkMatch = (label, eng, db) => {
      const match = eng === db || (typeof eng === 'number' && Math.abs(eng - Number(db)) < 0.01);
      console.log(`  ${label.padEnd(25)}| ${String(eng).padEnd(19)}| ${String(db).padEnd(19)}| ${match ? '✅ MATCH' : '⚠️ MISMATCH'}`);
    };

    checkMatch('Eligibility Status', evaluation.overallStatus, sys.eligibility_status);
    checkMatch('Min Eligible Amount', evaluation.minEligibleAmount, Number(sys.min_eligible_amount));
    checkMatch('Max Eligible Amount', evaluation.maxEligibleAmount, Number(sys.max_eligible_amount));
    if (sys.param1_score) checkMatch('Param 1 Score', s5.param1.score, Number(sys.param1_score));
    if (sys.param2_score) checkMatch('Param 2 Score', s5.param2.score, Number(sys.param2_score));
    if (sys.param3_score) checkMatch('Param 3 Score', s5.param3.score, Number(sys.param3_score));
    if (sys.param4_score) checkMatch('Param 4 Score', s5.param4.score, Number(sys.param4_score));
    if (sys.final_score) checkMatch('Final Score', s5.finalScore, Number(sys.final_score));
    if (sys.fail_step) checkMatch('Fail Step', evaluation.failedStep, Number(sys.fail_step));

    if (systemRecord.scoreDetails.length > 0) {
      console.log(`\n  System Score Details Stored in DB:`);
      console.table(systemRecord.scoreDetails.map(sd => ({
        'Loan ID': sd.loan_account_id || 'MEMBER',
        'Parameter': sd.parameter_code,
        'Behavior Label': sd.behaviour_label,
        'Raw Value': sd.raw_value,
        'Score Value': sd.score_value
      })));
    }
  } else if (systemRecord.foundInCandidateTable) {
    const cand = systemRecord.candidateRow;
    console.log(`  [Found in credit_risk_model_eligibility_candidate table - Run ID: ${cand.run_id}]`);
    console.log(`  Stage A Status   : ${cand.stage_a_status}`);
    console.log(`  Fail Step        : ${cand.fail_step}`);
    console.log(`  Fail Reason      : ${cand.fail_reason}`);
    console.log(`  Avg Disbursed    : ${formatCurrency(cand.avg_disbursed_amount)}`);
    console.log(`  Computed Ceiling : ${formatCurrency(cand.computed_ceiling)}`);
  } else {
    console.log(`  ℹ️ Member ${member.id} was not part of the previous batch eligibility run (Office ${member.branchId}).`);
    console.log(`  The calculation above has been dynamically computed from raw core ERP tables according to SRS rules.`);
  }

  console.log('\n' + '='.repeat(80) + '\n');
}

module.exports = { generateReport };
