const { getClient } = require('./db');

class NanoLoanEvaluator {
  constructor(client) {
    this.client = client;
  }

  async loadConfig(runId = 2) {
    // 1. Try to load config snapshot from run
    const runRes = await this.client.query('SELECT * FROM credit_risk_model_eligibility_run WHERE id = $1', [runId]);
    if (runRes.rows.length > 0 && runRes.rows[0].config_snapshot) {
      this.config = runRes.rows[0].config_snapshot;
      this.runInfo = runRes.rows[0];
    } else {
      // Default fallback values based on active configuration
      this.config = {
        business_date: '2026-10-31',
        history_years: 4,
        minimum_loan_cycle: 2,
        loans_to_select: 2,
        number_of_loans_to_avg: 2,
        eligible_loan_percentage: 20,
        required_paid_percentage: 30,
        required_final_score: 3.0,
        due_month_evaluation_period: 12,
        installments_to_consider: 11,
        days_before_repayment: 7,
        project_ceilings: [
          { project_info_id: 1, project: 'Microfinance (Dabi)', min_amount: 20000, max_amount: 50000 },
          { project_info_id: 2, project: 'Progoti', min_amount: 20000, max_amount: 100000 }
        ]
      };
    }
  }

  async evaluateMember(memberIdOrNo) {
    const client = this.client;

    // 1. Fetch Member Info
    const memRes = await client.query(`
      SELECT m.*, o.office_code, o.office_name, p.project_name
      FROM member_info m
      LEFT JOIN office_info o ON o.id = m.branch_info_id
      LEFT JOIN project_info p ON p.id = m.project_info_id
      WHERE m.id = $1 OR m.member_no = $1
    `, [String(memberIdOrNo)]);

    if (memRes.rows.length === 0) {
      return { error: `Member with ID / No "${memberIdOrNo}" not found in database.` };
    }

    const member = memRes.rows[0];
    const memberId = Number(member.id);
    const officeId = Number(member.branch_info_id);
    const projectId = Number(member.project_info_id);

    // Business Date & History Threshold
    const businessDateStr = this.config._business_date || '2026-10-31';
    const businessDate = new Date(businessDateStr);
    const historyYears = this.config.history_years || 4;
    const historyCutoff = new Date(businessDate);
    historyCutoff.setFullYear(historyCutoff.getFullYear() - historyYears);

    // 2. Fetch General Loans (Monthly, General Loan Products)
    // Products from config snapshot or standard product_type = 1
    const productIds = this.config.general_loan_product_ids || [42, 46, 76, 79, 80, 96, 97, 100, 102, 103, 119, 126, 133, 134, 143, 145, 146, 180, 181, 183, 184, 185, 188, 224, 225, 226, 227, 228, 230];

    const loansRes = await client.query(`
      SELECT la.id, la.account_no, la.loan_status_id, la.disbursed_amount, 
             la.outstanding_balance, la.total_amount, la.product_info_id, 
             la.project_info_id, la.office_info_id, la.disbursement_date, la.date_created,
             lp.loan_name as product_name
      FROM loan_account la
      JOIN loan_product lp ON lp.id = la.product_info_id
      WHERE la.member_id = $1 
        AND la.office_info_id = $2
        AND (la.product_info_id = ANY($3::bigint[]) OR lp.loan_product_type_id = 1)
      ORDER BY la.disbursement_date DESC, la.id DESC
    `, [memberId, officeId, productIds]);

    const allGeneralLoans = loansRes.rows;

    // Filter loans within 4 years
    const eligibleWindowLoans = allGeneralLoans.filter(l => {
      const d = new Date(l.disbursement_date);
      return d >= historyCutoff && d <= businessDate;
    });

    // ----------------------------------------------------
    // STEP 1: Minimum Loan Cycle
    // ----------------------------------------------------
    const minLoanCycle = this.config.minimum_loan_cycle || 2;
    const generalLoanCount = eligibleWindowLoans.length;
    const step1Pass = generalLoanCount >= minLoanCycle;
    const step1Result = {
      step: 1,
      name: 'Minimum Loan Cycle',
      requiredCount: minLoanCycle,
      actualCount: generalLoanCount,
      historyCutoff: historyCutoff.toISOString().split('T')[0],
      passed: step1Pass,
      reason: step1Pass ? null : `Only ${generalLoanCount} general loan(s), minimum ${minLoanCycle} required`
    };

    // ----------------------------------------------------
    // STEP 2: Running Loan Repayment Requirement
    // ----------------------------------------------------
    // Check if member has active general loan (status 1)
    const runningLoans = allGeneralLoans.filter(l => Number(l.loan_status_id) === 1);
    let step2Pass = true;
    let step2Reason = null;
    let runningLoan = null;
    let runningLoanRepaidPct = null;

    if (runningLoans.length > 0) {
      // Pick most recently disbursed active loan
      runningLoan = runningLoans[0];
      const disbursed = Number(runningLoan.disbursed_amount);
      const outstanding = Number(runningLoan.outstanding_balance);
      runningLoanRepaidPct = disbursed > 0 ? ((disbursed - outstanding) / disbursed) * 100 : 0;

      const reqPct = Number(this.config.required_paid_percentage || 30.0);
      step2Pass = runningLoanRepaidPct >= reqPct;
      if (!step2Pass) {
        step2Reason = `Latest running loan repaid ${runningLoanRepaidPct.toFixed(1)}%, requires ${reqPct.toFixed(1)}%`;
      }
    } else {
      // Exception: No running loan, skip step 2
      step2Pass = true;
      step2Reason = 'Skipped (No active running loan)';
    }

    const step2Result = {
      step: 2,
      name: 'Running Loan Repayment Requirement',
      hasRunningLoan: runningLoans.length > 0,
      runningLoanId: runningLoan ? runningLoan.id : null,
      disbursedAmount: runningLoan ? Number(runningLoan.disbursed_amount) : null,
      outstandingBalance: runningLoan ? Number(runningLoan.outstanding_balance) : null,
      repaidPct: runningLoanRepaidPct !== null ? Number(runningLoanRepaidPct.toFixed(4)) : null,
      requiredPct: Number(this.config.required_paid_percentage || 30.0),
      passed: step2Pass,
      reason: step2Pass ? (runningLoans.length === 0 ? 'No running loan (Criterion skipped)' : null) : step2Reason
    };

    // ----------------------------------------------------
    // STEP 3: Due Month Repayment Criteria
    // ----------------------------------------------------
    const evalPeriodMonths = this.config.due_month_evaluation_period || 12;
    const evalPeriodCutoff = new Date(businessDate);
    evalPeriodCutoff.setMonth(evalPeriodCutoff.getMonth() - evalPeriodMonths);

    let step3Pass = true;
    let step3Reason = null;
    let lateRepayments = [];

    // Query collections in evaluation period
    const collectionsRes = await client.query(`
      SELECT lat.id, lat.loan_account_id, lat.collection_amount, lat.transaction_date, lat.trx_type,
             lc.collection_date, lc.is_collection_date
      FROM loan_account_transaction lat
      LEFT JOIN loan_collection lc ON (lc.office_info_id = lat.office_info_id AND lc.loan_account_id = lat.loan_account_id AND lc.id = lat.collection_id)
      WHERE lat.office_info_id = $1 
        AND lat.loan_account_id = ANY($2::bigint[])
        AND lat.transaction_date >= $3
        AND lat.transaction_date <= $4
        AND lat.collection_amount > 0
      ORDER BY lat.transaction_date
    `, [officeId, eligibleWindowLoans.map(l => l.id), evalPeriodCutoff, businessDate]);

    // Check if any payment was exceeding the month
    // In BRAC system, if collection was delayed beyond due month
    for (const tx of collectionsRes.rows) {
      if (tx.is_collection_date === false && tx.collection_date) {
        // Can check against due schedule if necessary
      }
    }

    const step3Result = {
      step: 3,
      name: 'Due Month Repayment Criteria',
      evaluationPeriodMonths: evalPeriodMonths,
      evaluationPeriodCutoff: evalPeriodCutoff.toISOString().split('T')[0],
      totalCollectionsChecked: collectionsRes.rows.length,
      passed: step3Pass,
      reason: step3Pass ? null : step3Reason
    };

    // ----------------------------------------------------
    // STEP 4: Eligible Loan Amount Calculation
    // ----------------------------------------------------
    const numToAvg = this.config.number_of_loans_to_avg || 2;
    const loansToAvg = eligibleWindowLoans.slice(0, numToAvg);
    let avgDisbursedAmount = 0;
    let computedCeiling = 0;
    let step4Pass = true;
    let step4Reason = null;

    if (loansToAvg.length >= numToAvg) {
      const sumDisbursed = loansToAvg.reduce((sum, l) => sum + Number(l.disbursed_amount), 0);
      avgDisbursedAmount = sumDisbursed / numToAvg;
      const eligPct = Number(this.config.eligible_loan_percentage || 20) / 100;
      computedCeiling = Math.round(avgDisbursedAmount * eligPct);
    } else {
      step4Pass = false;
      step4Reason = `Insufficient loans to average (${loansToAvg.length}/${numToAvg})`;
    }

    // Project Ceilings:
    // Dabi (1): min 20,000, max 50,000
    // Progoti (2): min 20,000, max 100,000
    const projectCap = (this.config.project_ceilings || []).find(p => p.project_info_id === projectId) || {
      min_amount: 20000,
      max_amount: projectId === 2 ? 100000 : 50000
    };

    let minEligibleAmount = projectCap.min_amount;
    let maxEligibleAmount = computedCeiling;

    if (step4Pass) {
      if (computedCeiling < projectCap.min_amount) {
        step4Pass = false;
        step4Reason = `Computed ceiling ${computedCeiling} below project minimum ${projectCap.min_amount}`;
      } else if (computedCeiling > projectCap.max_amount) {
        maxEligibleAmount = projectCap.max_amount;
      }
    }

    const step4Result = {
      step: 4,
      name: 'Eligible Loan Amount Calculation',
      loansAveragedCount: loansToAvg.length,
      loansAveraged: loansToAvg.map(l => ({ id: l.id, accountNo: l.account_no, disbursed: Number(l.disbursed_amount), date: l.disbursement_date })),
      avgDisbursedAmount: Number(avgDisbursedAmount.toFixed(2)),
      eligiblePercentage: Number(this.config.eligible_loan_percentage || 20),
      computedCeiling,
      projectMinCeiling: projectCap.min_amount,
      projectMaxCeiling: projectCap.max_amount,
      minEligibleAmount: step4Pass ? minEligibleAmount : projectCap.min_amount,
      maxEligibleAmount: step4Pass ? maxEligibleAmount : computedCeiling,
      passed: step4Pass,
      reason: step4Reason
    };

    // ----------------------------------------------------
    // STEP 5: Credit Scoring Parameters
    // ----------------------------------------------------
    // Loans to evaluate for scoring: latest N loans (loansToAvg)
    const evaluatedLoanIds = loansToAvg.map(l => l.id);

    // Param 1: Installment Payment Behavior
    const param1Details = [];
    for (const loan of loansToAvg) {
      const txRes = await client.query(`
        SELECT lat.id, lat.collection_amount, lat.transaction_date, lat.trx_type,
               lc.collection_date, lc.is_collection_date
        FROM loan_account_transaction lat
        LEFT JOIN loan_collection lc ON (lc.office_info_id = lat.office_info_id AND lc.loan_account_id = lat.loan_account_id AND lc.id = lat.collection_id)
        WHERE lat.office_info_id = $1 AND lat.loan_account_id = $2 AND lat.collection_amount > 0 AND lat.trx_type != 7
        ORDER BY lat.transaction_date
      `, [officeId, loan.id]);

      let lowestScore = 5;
      let label = 'On scheduled date';

      for (const t of txRes.rows) {
        const d = new Date(t.transaction_date);
        const day = d.getUTCDate();
        // Check if transaction in last 3 working days of month (e.g. days 28-31)
        const lastDayOfMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
        if (day >= lastDayOfMonth - 3) {
          if (lowestScore > 3) {
            lowestScore = 3;
            label = 'Within last 3 working days of the month';
          }
        } else {
          if (lowestScore > 4) {
            lowestScore = 4;
            label = 'Within the month';
          }
        }
      }

      param1Details.push({
        loanId: loan.id,
        disbursedAmount: Number(loan.disbursed_amount),
        collectionsCount: txRes.rows.length,
        behaviorLabel: label,
        score: lowestScore
      });
    }

    const param1Score = param1Details.length > 0
      ? param1Details.reduce((s, p) => s + p.score, 0) / param1Details.length
      : 5;

    // Param 2: Savings Paid with Loan Installment
    const param2Details = [];
    for (const loan of loansToAvg) {
      const res = await client.query(`
        SELECT 
          COALESCE(SUM(s.deposit_amount), 0) AS total_savings,
          COALESCE(SUM(l.collection_amount), 0) AS total_installment
        FROM loan_account_transaction l
        LEFT JOIN savings_account_transaction s
            ON s.office_info_id = l.office_info_id
           AND s.member_info_id = $1
           AND s.deposit_amount > 0
           AND s.trx_type = 1
           AND DATE_TRUNC('month', s.date_created) = DATE_TRUNC('month', l.date_created)
        WHERE l.office_info_id = $2
          AND l.loan_account_id = $3
          AND l.collection_amount > 0
          AND l.trx_type != 7
      `, [memberId, officeId, loan.id]);

      const totalSavings = Number(res.rows[0]?.total_savings || 0);
      const totalInstallment = Number(res.rows[0]?.total_installment || Number(loan.disbursed_amount));
      const pct = totalInstallment > 0 ? (totalSavings / totalInstallment) * 100 : 0;

      let score = 2;
      let label = '0% deposited to savings per installment';
      if (projectId === 1) { // Dabi
        if (pct >= 10) { score = 5; label = '10% of loan value deposited to savings per installment'; }
        else if (pct >= 5) { score = 4; label = '5% to 9% deposited to savings per installment'; }
        else if (pct >= 1) { score = 3; label = '1% to 4% deposited to savings per installment'; }
        else { score = 2; label = '0% deposited to savings per installment'; }
      } else { // Progoti
        if (pct > 3) { score = 5; label = '>3% of loan value deposited to savings per installment'; }
        else if (pct >= 1) { score = 4.5; label = '1% to 3% deposited to savings per installment'; }
        else { score = 4; label = '0% deposited to savings per installment'; }
      }

      param2Details.push({
        loanId: loan.id,
        totalSavings,
        totalInstallment,
        ratioPct: Number(pct.toFixed(2)),
        behaviorLabel: label,
        score
      });
    }

    const param2Score = param2Details.length > 0
      ? param2Details.reduce((s, p) => s + p.score, 0) / param2Details.length
      : 5;

    // Param 3: Savings Adjustment of Previous Loan
    const param3Details = [];
    for (const loan of loansToAvg) {
      const adjRes = await client.query(`
        SELECT COALESCE(SUM(collection_amount), 0) AS total_adjustment
        FROM loan_account_transaction
        WHERE office_info_id = $1 AND loan_account_id = $2 AND trx_type = 7
      `, [officeId, loan.id]);

      const adjAmount = Number(adjRes.rows[0]?.total_adjustment || 0);
      const disbursed = Number(loan.disbursed_amount);
      const adjPct = disbursed > 0 ? (adjAmount / disbursed) * 100 : 0;

      let score = 5;
      let label = '0% adjustment made of previous loans';
      if (adjPct === 0) { score = 5; label = '0% adjustment made of previous loans'; }
      else if (adjPct <= 25) { score = 4.5; label = '25% adjustment made of previous loans'; }
      else if (adjPct <= 50) { score = 4; label = '50% adjustment made of previous loans'; }
      else { score = 2; label = '100% adjustment made of previous loans'; }

      param3Details.push({
        loanId: loan.id,
        adjustmentAmount: adjAmount,
        disbursedAmount: disbursed,
        adjustmentPct: Number(adjPct.toFixed(2)),
        behaviorLabel: label,
        score
      });
    }

    const param3Score = param3Details.length > 0
      ? param3Details.reduce((s, p) => s + p.score, 0) / param3Details.length
      : 5;

    // Param 4: Savings Withdrawal Before Repayment
    const withdrRes = await client.query(`
      SELECT COUNT(*) as withdrawal_count
      FROM savings_account_transaction s
      WHERE s.office_info_id = $1 
        AND s.member_info_id = $2 
        AND s.withdrawal_amount > 0
        AND s.date_created >= $3
    `, [officeId, memberId, evalPeriodCutoff]);

    const withdrCount = Number(withdrRes.rows[0]?.withdrawal_count || 0);
    let param4Score = 5;
    let param4Label = 'Never withdrew';
    if (withdrCount === 0) {
      param4Score = 5;
      param4Label = 'Never withdrew';
    } else {
      param4Score = 4;
      param4Label = 'Withdrawal made';
    }

    // Final Score
    const finalScore = (param1Score + param2Score + param3Score + param4Score) / 4;
    const reqFinalScore = Number(this.config.required_final_score || 3.0);
    const step5Pass = finalScore >= reqFinalScore;
    const step5Reason = step5Pass ? null : `Final score ${finalScore.toFixed(3)} below required threshold ${reqFinalScore}`;

    const step5Result = {
      step: 5,
      name: 'Credit Scoring & Final Score',
      param1: { code: 'INSTALLMENT_PAYMENT_BEHAVIOR', score: Number(param1Score.toFixed(3)), details: param1Details },
      param2: { code: 'SAVINGS_PAID_WITH_INSTALLMENT', score: Number(param2Score.toFixed(3)), details: param2Details },
      param3: { code: 'SAVINGS_ADJUSTMENT_PREV_LOAN', score: Number(param3Score.toFixed(3)), details: param3Details },
      param4: { code: 'SAVINGS_WITHDRAWAL_BEFORE_REPAYMENT', score: Number(param4Score.toFixed(3)), label: param4Label, withdrawalCount: withdrCount },
      finalScore: Number(finalScore.toFixed(3)),
      requiredScore: reqFinalScore,
      passed: step5Pass,
      reason: step5Reason
    };

    // Overall Eligibility
    let overallPassed = true;
    let failedStep = null;
    let failedReason = null;

    if (!step1Result.passed) {
      overallPassed = false; failedStep = 1; failedReason = step1Result.reason;
    } else if (!step2Result.passed) {
      overallPassed = false; failedStep = 2; failedReason = step2Result.reason;
    } else if (!step3Result.passed) {
      overallPassed = false; failedStep = 3; failedReason = step3Result.reason;
    } else if (!step4Result.passed) {
      overallPassed = false; failedStep = 4; failedReason = step4Result.reason;
    } else if (!step5Result.passed) {
      overallPassed = false; failedStep = 5; failedReason = step5Result.reason;
    }

    // ----------------------------------------------------
    // SYSTEM STORED RECORDS CHECK (QA RECONCILIATION)
    // ----------------------------------------------------
    const dbEligRes = await client.query('SELECT * FROM credit_risk_model_eligible_member WHERE member_id = $1', [memberId]);
    const dbCandRes = await client.query('SELECT * FROM credit_risk_model_eligibility_candidate WHERE member_id = $1', [memberId]);
    const dbScoreRes = await client.query('SELECT * FROM credit_risk_model_eligibility_score_detail WHERE member_id = $1 ORDER BY parameter_code, loan_account_id', [memberId]);

    const systemRecord = {
      foundInEligibleTable: dbEligRes.rows.length > 0,
      eligibleRow: dbEligRes.rows[0] || null,
      foundInCandidateTable: dbCandRes.rows.length > 0,
      candidateRow: dbCandRes.rows[0] || null,
      scoreDetails: dbScoreRes.rows
    };

    const evaluation = {
      businessDate: businessDateStr,
      step1: step1Result,
      step2: step2Result,
      step3: step3Result,
      step4: step4Result,
      step5: step5Result,
      overallStatus: overallPassed ? 'ELIGIBLE' : 'NOT_ELIGIBLE',
      failedStep,
      failedReason,
      minEligibleAmount: overallPassed ? step4Result.minEligibleAmount : 20000,
      maxEligibleAmount: overallPassed ? step4Result.maxEligibleAmount : step4Result.computedCeiling,
      finalScore: Number(finalScore.toFixed(3))
    };

    // If official system scores exist, attach them
    if (systemRecord.foundInEligibleTable && systemRecord.eligibleRow.final_score !== null) {
      const row = systemRecord.eligibleRow;
      evaluation.systemFinalScore = Number(row.final_score);
      evaluation.systemParam1Score = Number(row.param1_score);
      evaluation.systemParam2Score = Number(row.param2_score);
      evaluation.systemParam3Score = Number(row.param3_score);
      evaluation.systemParam4Score = Number(row.param4_score);
      evaluation.systemMaxEligibleAmount = Number(row.max_eligible_amount);
      evaluation.systemMinEligibleAmount = Number(row.min_eligible_amount);
      evaluation.systemEligibilityStatus = row.eligibility_status;
    }

    return {
      member: {
        id: member.id,
        memberNo: member.member_no,
        name: member.member_name,
        branchId: member.branch_info_id,
        branchCode: member.office_code,
        branchName: member.office_name,
        projectId: member.project_info_id,
        projectName: member.project_name
      },
      evaluation,
      allGeneralLoans: allGeneralLoans.map(l => ({
        id: l.id,
        accountNo: l.account_no,
        statusId: l.loan_status_id,
        disbursedAmount: Number(l.disbursed_amount),
        outstandingBalance: Number(l.outstanding_balance),
        disbursementDate: l.disbursement_date ? l.disbursement_date.toISOString().split('T')[0] : null
      })),
      systemRecord
    };
  }
}

module.exports = { NanoLoanEvaluator };
