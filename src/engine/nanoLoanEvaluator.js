const { fetchConfiguredOffice } = require('../services/officeService');
const {
  fetchConfiguredLoanProducts,
  fetchActiveNanoLoanProductByProject
} = require('../services/loanProductService');
const { loadLiveAssessmentConfig } = require('../services/assessmentConfigService');
const {
  matchNumericBand,
  matchSeqBand,
  getScoreParameterConfig
} = require('./bandEvaluator');
const {
  toDhakaDateStr,
  addMonths,
  addYears,
  diffDays,
  isInLastWorkingDaysOfMonth,
  expandDateRange
} = require('../utils/dateUtils');

class NanoLoanEvaluator {
  constructor(client, appConfig) {
    this.client = client;
    this.appConfig = appConfig;
    this.config = null;
    this.latestRun = null;
    this.configDrift = [];
    this.configuredOffice = null;
    this.configuredLoanProducts = [];
  }

  /**
   * Always fetches fresh live configuration from DB on every run:
   *  1. Configured Office validation (office.id & branch.office.code)
   *  2. Configured Loan Product(s) live schema (loan.product.id)
   *  3. Live Credit Risk Model Assessment Configuration tables + latest batch run drift check
   */
  async loadLiveConfiguration() {
    this.configuredOffice = await fetchConfiguredOffice(this.client, this.appConfig);
    this.configuredLoanProducts = await fetchConfiguredLoanProducts(this.client, this.appConfig);

    const { liveConfig, latestRun, configDrift } = await loadLiveAssessmentConfig(
      this.client,
      this.appConfig,
      this.configuredLoanProducts
    );

    this.config = liveConfig;
    this.latestRun = latestRun;
    this.configDrift = configDrift;

    return {
      configuredOffice: this.configuredOffice,
      configuredLoanProducts: this.configuredLoanProducts,
      liveConfig: this.config,
      latestRun: this.latestRun,
      configDrift: this.configDrift
    };
  }

  async resolveApplicableLoanProduct(projectId, projectName) {
    // 1. Find the configured product expected for this member's project (Dabi=1, Progoti=2)
    const expectedConfigured = this.configuredLoanProducts.find(
      (p) => p.expectedProjectId === projectId
    );

    if (expectedConfigured) {
      if (
        expectedConfigured.found &&
        expectedConfigured.isActive &&
        expectedConfigured.projectMappingVerified
      ) {
        return {
          product: expectedConfigured,
          matchedFromProperties: true,
          verified: true,
          verificationMessage: `✅ Verified: Member project [${projectName || `ID ${projectId}`}] matched configured ${expectedConfigured.propertyName}=${expectedConfigured.id} (${expectedConfigured.loanName}).`,
          note: null
        };
      }

      const issues = [];
      if (!expectedConfigured.found) {
        issues.push(`product ID ${expectedConfigured.id} not found in DB`);
      } else {
        if (!expectedConfigured.isActive) {
          issues.push(`product ID ${expectedConfigured.id} is inactive (status ${expectedConfigured.domainStatusId})`);
        }
        if (!expectedConfigured.projectMappingVerified) {
          const actual = expectedConfigured.mappedProjects
            .map((mp) => `${mp.projectName} (ID: ${mp.projectInfoId})`)
            .join(', ') || 'NONE';
          issues.push(`product ID ${expectedConfigured.id} is mapped to [${actual}] instead of Project ID ${projectId}`);
        }
      }

      // Check if another configured product actually maps to this member's project (e.g. swapped IDs)
      const mappedConfigured = this.configuredLoanProducts.find(
        (p) => p.found && p.mappedProjects.some((mp) => mp.projectInfoId === projectId)
      );

      if (mappedConfigured) {
        return {
          product: mappedConfigured,
          matchedFromProperties: true,
          verified: false,
          verificationMessage: `⚠️ Verification Mismatch: ${expectedConfigured.propertyName}=${expectedConfigured.id} failed check (${issues.join('; ')}). Using ${mappedConfigured.propertyName}=${mappedConfigured.id} (${mappedConfigured.loanName}) which actually maps to Project ID ${projectId}.`,
          note: `Check config/config.properties: ${expectedConfigured.propertyName} and ${mappedConfigured.propertyName} appear to be swapped or misconfigured.`
        };
      }

      return {
        product: expectedConfigured.found ? expectedConfigured : null,
        matchedFromProperties: true,
        verified: false,
        verificationMessage: `❌ Verification Failed: ${expectedConfigured.propertyName}=${expectedConfigured.id} failed check (${issues.join('; ')}).`,
        note: `Update ${expectedConfigured.propertyName} in config/config.properties with an active Nano Loan product mapped to Project ID ${projectId}.`
      };
    }

    // 2. For any other project ID beyond Dabi (1) / Progoti (2), check configured mappings then DB
    const matchingConfigured = this.configuredLoanProducts.find(
      (p) => p.found && p.mappedProjects.some((mp) => mp.projectInfoId === projectId)
    );

    if (matchingConfigured) {
      return {
        product: matchingConfigured,
        matchedFromProperties: true,
        verified: matchingConfigured.isActive,
        verificationMessage: `✅ Verified: Member project [${projectName || `ID ${projectId}`}] matched configured ${matchingConfigured.propertyName}=${matchingConfigured.id} (${matchingConfigured.loanName}).`,
        note: null
      };
    }

    const projectNanoProduct = await fetchActiveNanoLoanProductByProject(
      this.client,
      projectId,
      this.appConfig
    );

    if (projectNanoProduct && projectNanoProduct.found) {
      return {
        product: projectNanoProduct,
        matchedFromProperties: false,
        verified: false,
        verificationMessage: `ℹ️ Member belongs to project [${projectName || `ID ${projectId}`}] (neither Dabi=1 nor Progoti=2). Applied live active Nano Loan product #${projectNanoProduct.id} (${projectNanoProduct.loanName}).`,
        note: null
      };
    }

    return {
      product: null,
      matchedFromProperties: false,
      verified: false,
      verificationMessage: `⚠️ No configured or active Nano Loan product found for member project [${projectName || `ID ${projectId}`}]. Falling back to assessment ceilings.`,
      note: null
    };
  }

  async evaluateMember(memberIdOrNo) {
    if (!this.config) {
      await this.loadLiveConfiguration();
    }

    const client = this.client;

    // 1. Fetch Member Info
    const memRes = await client.query(
      `
      SELECT m.*, o.office_code, o.office_name, p.project_name
      FROM member_info m
      LEFT JOIN office_info o ON o.id = m.branch_info_id
      LEFT JOIN project_info p ON p.id = m.project_info_id
      WHERE m.id::text = $1 OR m.member_no = $1
      `,
      [String(memberIdOrNo)]
    );

    if (memRes.rows.length === 0) {
      return {
        error: `Member with ID / No "${memberIdOrNo}" not found in database.`,
        environment: this.buildEnvironmentSummary()
      };
    }

    const member = memRes.rows[0];
    const memberId = Number(member.id);
    const officeId = Number(member.branch_info_id);
    const projectId = Number(member.project_info_id);

    const officeMismatchWarning =
      officeId !== this.appConfig.office.id
        ? `Member belongs to Branch [${member.office_code}] ${member.office_name} (ID: ${officeId}), whereas config.properties has office.id=${this.appConfig.office.id}. Queries were partition-pruned using member's actual office_info_id=${officeId}.`
        : null;

    // Resolve live applicable loan product for member's project (Dabi vs Progoti)
    const applicableProductInfo = await this.resolveApplicableLoanProduct(projectId, member.project_name);
    const applicableProduct = applicableProductInfo.product;

    // Business Date & History Threshold (Asia/Dhaka calendar dates)
    const businessDateStr = toDhakaDateStr(this.config.business_date) || '2026-10-31';
    const historyYears = this.config.history_years || 4;
    const historyCutoffStr = addYears(businessDateStr, -historyYears);

    // 2. Fetch General Loans (Partitioned by office_info_id)
    const productIds = this.config.general_loan_product_ids;

    const loansRes = await client.query(
      `
      SELECT la.id, la.account_no, la.loan_status_id, la.disbursed_amount,
             la.outstanding_balance, la.total_amount, la.product_info_id,
             la.project_info_id, la.office_info_id, la.disbursement_date, la.date_created,
             la.first_installment_date, la.settlement_date, la.installment_amount, la.no_of_installment,
             TO_CHAR(la.disbursement_date AT TIME ZONE 'Asia/Dhaka', 'YYYY-MM-DD') AS disb_date_bd,
             TO_CHAR(la.first_installment_date AT TIME ZONE 'Asia/Dhaka', 'YYYY-MM-DD') AS first_inst_date_bd,
             TO_CHAR(la.settlement_date AT TIME ZONE 'Asia/Dhaka', 'YYYY-MM-DD') AS settle_date_bd,
             lp.loan_name AS product_name
      FROM loan_account la
      JOIN loan_product lp ON lp.id = la.product_info_id
      WHERE la.member_id = $1
        AND la.office_info_id = $2
        AND la.domain_status_id = 1
        AND (la.product_info_id = ANY($3::bigint[]) OR lp.loan_product_type_id = 1)
        AND (la.disbursement_date AT TIME ZONE 'Asia/Dhaka')::date <= $4::date
      ORDER BY la.disbursement_date DESC, la.id DESC
      `,
      [memberId, officeId, productIds, businessDateStr]
    );

    const allGeneralLoans = loansRes.rows;

    // Filter loans within history lookback window (Asia/Dhaka dates)
    const eligibleWindowLoans = allGeneralLoans.filter((l) => {
      const d = l.disb_date_bd || toDhakaDateStr(l.disbursement_date);
      return d && d >= historyCutoffStr && d <= businessDateStr;
    });

    // ----------------------------------------------------
    // STEP 1: Minimum Loan Cycle
    // ----------------------------------------------------
    const minLoanCycle = this.config.minimum_loan_cycle || 2;
    const generalLoanCount = eligibleWindowLoans.length;
    const step1Pass = generalLoanCount >= minLoanCycle;
    let step1Reason = null;
    if (!step1Pass) {
      step1Reason =
        allGeneralLoans.length < minLoanCycle
          ? `Only ${allGeneralLoans.length} general loan(s), minimum ${minLoanCycle} required`
          : `Loan history exceeds the ${historyYears}-year window`;
    }
    const step1Result = {
      step: 1,
      name: 'Minimum Loan Cycle',
      requiredCount: minLoanCycle,
      historyYears,
      actualCount: generalLoanCount,
      historyCutoff: historyCutoffStr,
      passed: step1Pass,
      reason: step1Reason
    };

    // ----------------------------------------------------
    // STEP 2: Running Loan Repayment Requirement
    // ----------------------------------------------------
    const runningLoans = allGeneralLoans.filter((l) => Number(l.loan_status_id) === 1);
    let step2Pass = true;
    let step2Reason = null;
    let runningLoan = null;
    let runningLoanRepaidPct = null;

    const reqPct = Number(this.config.required_paid_percentage || 30.0);

    if (runningLoans.length > 0) {
      runningLoan = runningLoans[0];
      const disbursed = Number(runningLoan.disbursed_amount);
      const outstanding = Number(runningLoan.outstanding_balance);
      runningLoanRepaidPct = disbursed > 0 ? ((disbursed - outstanding) / disbursed) * 100 : 0;

      step2Pass = runningLoanRepaidPct >= reqPct;
      if (!step2Pass) {
        step2Reason = `Latest running loan repaid ${runningLoanRepaidPct.toFixed(1)}%, requires ${reqPct.toFixed(1)}%`;
      }
    } else {
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
      requiredPct: reqPct,
      passed: step2Pass,
      reason: step2Pass
        ? runningLoans.length === 0
          ? 'No running loan (Criterion skipped)'
          : null
        : step2Reason
    };

    // ----------------------------------------------------
    // STEP 3 (Due Month Repayment) & STEP 5 Param 1 Prep
    // Uses loan_collection scheduled due rows (is_collection_date = true)
    // and monthly clearing entries in Asia/Dhaka up to businessDate.
    // ----------------------------------------------------
    const evalPeriodValue = Number(this.config.due_month_evaluation_period || 12);
    const evalPeriodUnit = String(this.config.due_month_evaluation_period_unit || 'MONTH').toUpperCase();
    const evalPeriodCutoffStr =
      evalPeriodUnit === 'YEAR'
        ? addYears(businessDateStr, -evalPeriodValue)
        : addMonths(businessDateStr, -evalPeriodValue);

    const numToAvg = this.config.number_of_loans_to_avg || 2;
    const loansToAvg = eligibleWindowLoans.slice(0, numToAvg);

    const bands = this.config.score_bands;
    const params = this.config.score_parameters;
    const p1Conf = getScoreParameterConfig(params, 'INSTALLMENT_PAYMENT_BEHAVIOR', projectId);
    const p1Loans = eligibleWindowLoans.slice(0, (p1Conf && p1Conf.loanCount) || numToAvg);

    let step3Pass = true;
    let step3Reason = null;
    let totalDueMonthsChecked = 0;
    const param1Details = [];

    // Load active holidays in the evaluation window for accurate Bangladesh last-3-working-days check
    const holidaySet = new Set();
    const holidayRes = await client.query(
      `
      SELECT TO_CHAR(from_date AT TIME ZONE 'Asia/Dhaka', 'YYYY-MM-DD') AS from_bd,
             TO_CHAR(to_date AT TIME ZONE 'Asia/Dhaka', 'YYYY-MM-DD') AS to_bd
      FROM holiday
      WHERE status_id = 1
        AND (office_id IS NULL OR office_id = $1)
        AND (to_date AT TIME ZONE 'Asia/Dhaka')::date >= $2::date
        AND (from_date AT TIME ZONE 'Asia/Dhaka')::date <= $3::date
      `,
      [officeId, evalPeriodCutoffStr, businessDateStr]
    );
    for (const h of holidayRes.rows) {
      for (const dt of expandDateRange(h.from_bd, h.to_bd)) {
        holidaySet.add(dt);
      }
    }

    for (const loan of p1Loans) {
      const lcRes = await client.query(
        `
        SELECT lc.id, lc.collection_no,
               TO_CHAR(lc.collection_date AT TIME ZONE 'Asia/Dhaka', 'YYYY-MM-DD') AS bd_date,
               TO_CHAR(lc.collection_date AT TIME ZONE 'Asia/Dhaka', 'YYYY-MM') AS bd_ym,
               lc.is_collection_date, lc.realizable_amount, lc.realized_amount, lc.overdue_amount,
               lc.principal_overdue_amount, lc.no_of_overdue_instalment
        FROM loan_collection lc
        WHERE lc.office_info_id = $1
          AND lc.loan_account_id = $2
          AND lc.domain_status_id = 1
          AND (lc.collection_date AT TIME ZONE 'Asia/Dhaka')::date <= $3::date
        ORDER BY lc.collection_date ASC, lc.collection_no ASC, lc.id ASC
        `,
        [officeId, loan.id, businessDateStr]
      );

      const allLcRows = lcRes.rows;
      const rows = allLcRows.filter(
        (r) => r.bd_date > evalPeriodCutoffStr && r.bd_date <= businessDateStr
      );
      const dueRows = rows.filter((r) => r.is_collection_date === true);
      if (dueRows.length === 0) {
        continue;
      }

      // Check early full settlement (trx_type = 6) and cumulative installment payments
      const latRes = await client.query(
        `
        SELECT trx_type, collection_amount,
               TO_CHAR(transaction_date AT TIME ZONE 'Asia/Dhaka', 'YYYY-MM-DD') AS bd_date,
               TO_CHAR(transaction_date AT TIME ZONE 'Asia/Dhaka', 'YYYY-MM') AS bd_ym
        FROM loan_account_transaction
        WHERE office_info_id = $1
          AND loan_account_id = $2
          AND domain_status_id = 1
          AND collection_amount > 0
          AND (transaction_date AT TIME ZONE 'Asia/Dhaka')::date <= $3::date
        ORDER BY transaction_date ASC, id ASC
        `,
        [officeId, loan.id, businessDateStr]
      );
      const earlySettleMonths = new Set(
        latRes.rows
          .filter((r) => Number(r.trx_type) === 6 && r.bd_date > evalPeriodCutoffStr)
          .map((r) => r.bd_ym)
      );

      // Track cumulative installment payments so borrowers who prepaid extra installments
      // ahead of their monthly schedule (e.g. two full installments in a prior month) are recognized
      const instAmt = Number(loan.installment_amount || 0);
      const firstInstDate = loan.first_inst_date_bd || toDhakaDateStr(loan.first_installment_date);
      let runningPaid = 0;
      const monthAheadOfSchedule = new Set();
      const hasSavingsAdjustment = latRes.rows.some((r) => Number(r.trx_type) === 7);
      for (const tx of latRes.rows) {
        const prevPaid = runningPaid;
        runningPaid += Number(tx.collection_amount || 0);
        if (instAmt > 0 && firstInstDate && !hasSavingsAdjustment && tx.bd_date > evalPeriodCutoffStr) {
          const instIdx = Math.floor(prevPaid / instAmt) + 1;
          const schedDate = addMonths(firstInstDate, instIdx - 1);
          if (tx.bd_date <= schedDate && !isInLastWorkingDaysOfMonth(tx.bd_date, 3, holidaySet)) {
            monthAheadOfSchedule.add(tx.bd_ym);
          }
        }
      }

      totalDueMonthsChecked += dueRows.length;
      let worstSeq = 1; // 1 = On scheduled date, 2 = Within month, 3 = Last 3 working days, 4 = Exceeding month

      for (const dueRow of dueRows) {
        const monthRows = rows.filter((r) => r.bd_ym === dueRow.bd_ym);
        const lastInMonth = monthRows[monthRows.length - 1];
        const paysAfterDueInMonth = monthRows.filter(
          (r) => r.collection_no > dueRow.collection_no && Number(r.realized_amount) > 0
        );
        const anyNextPayLaterMonth = allLcRows.find(
          (r) =>
            r.collection_no > dueRow.collection_no &&
            r.bd_ym > dueRow.bd_ym &&
            Number(r.realized_amount) > 0 &&
            !allLcRows.some(
              (d2) =>
                d2.is_collection_date &&
                d2.collection_no > dueRow.collection_no &&
                d2.collection_no < r.collection_no
            )
        );

        let instSeq = 1;
        if (
          Number(lastInMonth.overdue_amount) > 0 &&
          (paysAfterDueInMonth.length > 0 ||
            Boolean(anyNextPayLaterMonth) ||
            Number(lastInMonth.principal_overdue_amount) > 0 ||
            Number(lastInMonth.no_of_overdue_instalment) > 0)
        ) {
          instSeq = 4;
          step3Pass = false;
          step3Reason = 'Installment(s) not repaid within their due month';
        } else if (
          Number(dueRow.overdue_amount) === 0 ||
          earlySettleMonths.has(dueRow.bd_ym) ||
          monthAheadOfSchedule.has(dueRow.bd_ym) ||
          paysAfterDueInMonth.some(
            (r) => r.bd_date <= dueRow.bd_date && Number(r.overdue_amount) === 0
          ) ||
          paysAfterDueInMonth.length === 0
        ) {
          instSeq = 1;
        } else {
          const clearRow =
            paysAfterDueInMonth.find((r) => Number(r.overdue_amount) === 0) ||
            paysAfterDueInMonth[paysAfterDueInMonth.length - 1];

          if (isInLastWorkingDaysOfMonth(clearRow.bd_date, 3, holidaySet)) {
            instSeq = 3;
          } else {
            instSeq = 2;
          }
        }

        worstSeq = Math.max(worstSeq, instSeq);
      }

      const fallbackP1 =
        worstSeq === 1
          ? { score: 5, label: 'On scheduled date' }
          : worstSeq === 2
          ? { score: 4, label: 'Within the month' }
          : worstSeq === 3
          ? { score: 3, label: 'Within last 3 working days of the month' }
          : { score: 2, label: 'Exceeding the month' };

      const matched = matchSeqBand(
        bands,
        'INSTALLMENT_PAYMENT_BEHAVIOR',
        projectId,
        worstSeq,
        fallbackP1
      );

      param1Details.push({
        loanId: loan.id,
        disbursedAmount: Number(loan.disbursed_amount),
        collectionsCount: dueRows.length,
        behaviorLabel: matched.label,
        score: matched.score
      });
    }

    const step3Result = {
      step: 3,
      name: 'Due Month Repayment Criteria',
      evaluationPeriod: evalPeriodValue,
      evaluationPeriodUnit: evalPeriodUnit,
      evaluationRule: this.config.due_month_evaluation_rule || 'WITHIN_THE_MONTH',
      evaluationPeriodCutoff: evalPeriodCutoffStr,
      totalCollectionsChecked: totalDueMonthsChecked,
      passed: step3Pass,
      reason: step3Pass ? null : step3Reason
    };

    // ----------------------------------------------------
    // STEP 4: Eligible Loan Amount Calculation (Live Loan Product Ceilings)
    // ----------------------------------------------------
    let avgDisbursedAmount = 0;
    let computedCeiling = 0;
    let step4Pass = true;
    let step4Reason = null;

    const eligPctValue = Number(this.config.eligible_loan_percentage || 20);

    if (loansToAvg.length >= numToAvg) {
      const sumDisbursed = loansToAvg.reduce((sum, l) => sum + Number(l.disbursed_amount), 0);
      avgDisbursedAmount = sumDisbursed / numToAvg;
      computedCeiling = Math.round(avgDisbursedAmount * (eligPctValue / 100));
    } else {
      step4Pass = false;
      step4Reason = `Insufficient loans to average (${loansToAvg.length}/${numToAvg})`;
    }

    // Resolve live ceiling: prefer live applicable Loan Product min/max, then liveConfig.project_ceilings
    let projectCap = null;
    if (
      applicableProduct &&
      applicableProduct.found &&
      applicableProduct.minLoanAmount !== null &&
      applicableProduct.maxLoanAmount !== null
    ) {
      projectCap = {
        min_amount: applicableProduct.minLoanAmount,
        max_amount: applicableProduct.maxLoanAmount,
        source: `Live Loan Product #${applicableProduct.id} (${applicableProduct.loanName})`
      };
    } else {
      const confCap = (this.config.project_ceilings || []).find(
        (p) => Number(p.project_info_id) === projectId
      );
      projectCap = confCap || {
        min_amount: 20000,
        max_amount: projectId === 2 ? 100000 : 50000,
        source: 'SRS Default Fallback'
      };
    }

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
      loansAveraged: loansToAvg.map((l) => ({
        id: l.id,
        accountNo: l.account_no,
        disbursed: Number(l.disbursed_amount),
        date: l.disbursement_date
      })),
      avgDisbursedAmount: Number(avgDisbursedAmount.toFixed(2)),
      eligiblePercentage: eligPctValue,
      computedCeiling,
      projectMinCeiling: projectCap.min_amount,
      projectMaxCeiling: projectCap.max_amount,
      ceilingSource: projectCap.source,
      minEligibleAmount: step4Pass ? minEligibleAmount : projectCap.min_amount,
      maxEligibleAmount: step4Pass ? maxEligibleAmount : computedCeiling,
      passed: step4Pass,
      reason: step4Reason
    };

    // ----------------------------------------------------
    // STEP 5: Credit Scoring Parameters (Live Bands & Parameters)
    // ----------------------------------------------------
    const hasParam1Data = param1Details.length > 0;
    const param1Score = hasParam1Data
      ? param1Details.reduce((s, p) => s + p.score, 0) / param1Details.length
      : null;

    // Param 2: Savings Paid with Loan Installment
    // Numerator  : Compulsory Savings (sa.account_type_id = 1) member deposits (s.trx_type != 4)
    //              within [COALESCE(first_installment_date, disbursement_date) .. LEAST(settlement_date, businessDate)].
    // Denominator: Scheduled collection count (lc.is_collection_date = true up to businessDate) * loan.installment_amount.
    const p2Conf = getScoreParameterConfig(params, 'SAVINGS_PAID_WITH_INSTALLMENT', projectId);
    const p2Loans = eligibleWindowLoans.slice(0, (p2Conf && p2Conf.loanCount) || numToAvg);
    const param2Details = [];

    for (const loan of p2Loans) {
      const loanStartDate =
        loan.first_inst_date_bd ||
        toDhakaDateStr(loan.first_installment_date) ||
        loan.disb_date_bd ||
        toDhakaDateStr(loan.disbursement_date);
      const rawSettleDate = loan.settle_date_bd || toDhakaDateStr(loan.settlement_date);
      const loanEndDate =
        rawSettleDate && rawSettleDate <= businessDateStr ? rawSettleDate : businessDateStr;
      const instAmt = Number(loan.installment_amount || 0);

      const res = await client.query(
        `
        WITH sched_stats AS (
          SELECT COUNT(*) AS sched_count
          FROM loan_collection lc
          WHERE lc.office_info_id = $2
            AND lc.loan_account_id = $3
            AND lc.is_collection_date = true
            AND lc.domain_status_id = 1
            AND (lc.collection_date AT TIME ZONE 'Asia/Dhaka')::date <= $4::date
        ),
        compulsory_savings AS (
          SELECT COALESCE(SUM(s.deposit_amount), 0) AS total_savings
          FROM savings_account_transaction s
          JOIN savings_account sa
            ON sa.id = s.savings_account_id
           AND sa.office_info_id = s.office_info_id
          WHERE s.office_info_id = $2
            AND s.member_info_id = $1
            AND sa.account_type_id = 1
            AND s.domain_status_id = 1
            AND s.deposit_amount > 0
            AND s.trx_type != 4
            AND (s.transaction_date AT TIME ZONE 'Asia/Dhaka')::date >= $5::date
            AND (s.transaction_date AT TIME ZONE 'Asia/Dhaka')::date <= $6::date
        )
        SELECT cs.total_savings, ss.sched_count
        FROM compulsory_savings cs, sched_stats ss
        `,
        [memberId, officeId, loan.id, businessDateStr, loanStartDate, loanEndDate]
      );

      const totalSavings = Number(res.rows[0]?.total_savings || 0);
      const schedCount = Number(res.rows[0]?.sched_count || 0);
      const totalInstallment =
        instAmt > 0 && schedCount > 0 ? schedCount * instAmt : Number(loan.disbursed_amount);
      const pct = totalInstallment > 0 ? (totalSavings / totalInstallment) * 100 : 0;

      const fallbackP2 =
        projectId === 1
          ? pct >= 10
            ? { score: 5, label: '10% of loan value deposited to savings per installment' }
            : pct >= 5
            ? { score: 4, label: '5% to 9% deposited to savings per installment' }
            : pct >= 1
            ? { score: 3, label: '1% to 4% deposited to savings per installment' }
            : { score: 2, label: '0% deposited to savings per installment' }
          : pct > 3
          ? { score: 5, label: '>3% of loan value deposited to savings per installment' }
          : pct >= 1
          ? { score: 4.5, label: '1% to 3% deposited to savings per installment' }
          : { score: 4, label: '0% deposited to savings per installment' };

      const matched = matchNumericBand(
        bands,
        'SAVINGS_PAID_WITH_INSTALLMENT',
        projectId,
        pct,
        fallbackP2
      );

      param2Details.push({
        loanId: loan.id,
        totalSavings,
        totalInstallment,
        ratioPct: Number(pct.toFixed(2)),
        behaviorLabel: matched.label,
        score: matched.score
      });
    }

    const param2Score =
      param2Details.length > 0
        ? param2Details.reduce((s, p) => s + p.score, 0) / param2Details.length
        : 5;

    // Param 3: Savings Adjustment of Previous Loan (up to businessDate in Asia/Dhaka)
    const p3Conf = getScoreParameterConfig(params, 'SAVINGS_ADJUSTMENT_PREV_LOAN', projectId);
    const p3Loans = eligibleWindowLoans.slice(0, (p3Conf && p3Conf.loanCount) || numToAvg);
    const param3Details = [];

    for (const loan of p3Loans) {
      const adjRes = await client.query(
        `
        SELECT COALESCE(SUM(collection_amount), 0) AS total_adjustment
        FROM loan_account_transaction
        WHERE office_info_id = $1
          AND loan_account_id = $2
          AND trx_type = 7
          AND (transaction_date AT TIME ZONE 'Asia/Dhaka')::date <= $3::date
        `,
        [officeId, loan.id, businessDateStr]
      );

      const adjAmount = Number(adjRes.rows[0]?.total_adjustment || 0);
      const disbursed = Number(loan.disbursed_amount);
      const adjPct = disbursed > 0 ? (adjAmount / disbursed) * 100 : 0;

      const fallbackP3 =
        adjPct === 0
          ? { score: 5, label: '0% adjustment made of previous loans' }
          : adjPct <= 25
          ? { score: 4.5, label: '25% adjustment made of previous loans' }
          : adjPct <= 50
          ? { score: 4, label: '50% adjustment made of previous loans' }
          : { score: 2, label: '100% adjustment made of previous loans' };

      const matched = matchNumericBand(
        bands,
        'SAVINGS_ADJUSTMENT_PREV_LOAN',
        projectId,
        adjPct,
        fallbackP3
      );

      param3Details.push({
        loanId: loan.id,
        adjustmentAmount: adjAmount,
        disbursedAmount: disbursed,
        adjustmentPct: Number(adjPct.toFixed(2)),
        behaviorLabel: matched.label,
        score: matched.score
      });
    }

    const param3Score =
      param3Details.length > 0
        ? param3Details.reduce((s, p) => s + p.score, 0) / param3Details.length
        : 5;

    // Param 4: Savings Withdrawal Before Repayment
    // Compares Compulsory Savings (sa.account_type_id = 1) withdrawals within the window
    // spanned by the member's last N scheduled collection dates (lc.is_collection_date = true
    // up to businessDate across evaluated general loans) against daysBeforeRepayment.
    const daysBeforeRepayment = Number(this.config.days_before_repayment || 7);
    const installmentsToConsider = Number(this.config.installments_to_consider || 11);

    const schedDatesRes = await client.query(
      `
      SELECT TO_CHAR(lc.collection_date AT TIME ZONE 'Asia/Dhaka', 'YYYY-MM-DD') AS bd_date
      FROM loan_collection lc
      WHERE lc.office_info_id = $1
        AND lc.loan_account_id = ANY($2::bigint[])
        AND lc.is_collection_date = true
        AND lc.domain_status_id = 1
        AND (lc.collection_date AT TIME ZONE 'Asia/Dhaka')::date <= $3::date
      ORDER BY lc.collection_date DESC, lc.id DESC
      LIMIT $4
      `,
      [officeId, loansToAvg.map((l) => l.id), businessDateStr, installmentsToConsider]
    );

    const consideredRepayDates = schedDatesRes.rows.map((r) => r.bd_date);
    let withdrawalsBeforeRepayCount = 0;
    let minDaysBeforeRepayment = null;

    if (consideredRepayDates.length > 0) {
      const p4WindowStart = consideredRepayDates[consideredRepayDates.length - 1];
      const p4WindowEnd = consideredRepayDates[0];

      const withdrRes = await client.query(
        `
        SELECT TO_CHAR(s.transaction_date AT TIME ZONE 'Asia/Dhaka', 'YYYY-MM-DD') AS bd_date,
               s.withdrawal_amount, s.trx_type
        FROM savings_account_transaction s
        JOIN savings_account sa
          ON sa.id = s.savings_account_id
         AND sa.office_info_id = s.office_info_id
        WHERE s.office_info_id = $1
          AND s.member_info_id = $2
          AND sa.account_type_id = 1
          AND s.domain_status_id = 1
          AND s.withdrawal_amount > 0
          AND (s.transaction_date AT TIME ZONE 'Asia/Dhaka')::date >= $3::date
          AND (s.transaction_date AT TIME ZONE 'Asia/Dhaka')::date <= $4::date
        ORDER BY bd_date DESC
        `,
        [officeId, memberId, p4WindowStart, p4WindowEnd]
      );

      for (const w of withdrRes.rows) {
        let closestGapForWithdrawal = null;
        for (const rDate of consideredRepayDates) {
          if (w.bd_date <= rDate) {
            const gap = diffDays(w.bd_date, rDate);
            if (closestGapForWithdrawal === null || gap < closestGapForWithdrawal) {
              closestGapForWithdrawal = gap;
            }
          }
        }
        if (closestGapForWithdrawal !== null) {
          withdrawalsBeforeRepayCount += 1;
          if (minDaysBeforeRepayment === null || closestGapForWithdrawal < minDaysBeforeRepayment) {
            minDaysBeforeRepayment = closestGapForWithdrawal;
          }
        }
      }
    }

    let p4Seq = 1; // 1 = Never withdrew, 2 = Before N days, 3 = Within N days
    if (withdrawalsBeforeRepayCount === 0) {
      p4Seq = 1;
    } else if (minDaysBeforeRepayment !== null && minDaysBeforeRepayment <= daysBeforeRepayment) {
      p4Seq = 3;
    } else {
      p4Seq = 2;
    }

    const fallbackP4 =
      p4Seq === 1
        ? { score: 5, label: 'Never withdrew' }
        : p4Seq === 3
        ? { score: 3, label: `Within ${daysBeforeRepayment} days` }
        : { score: 4, label: `Before ${daysBeforeRepayment} days` };

    const matchedP4 = matchSeqBand(
      bands,
      'SAVINGS_WITHDRAWAL_BEFORE_REPAYMENT',
      projectId,
      p4Seq,
      fallbackP4
    );

    const param4Score = matchedP4.score;
    const param4Label = matchedP4.label;
    const withdrCount = withdrawalsBeforeRepayCount;

    // Final Score
    // If Param 1 has no scoring data in the evaluation window, the ERP system marks
    // Step 5 as NOT_ELIGIBLE with "Score could not be computed (no scoring data)".
    const reqFinalScore = Number(this.config.required_final_score || 3.0);
    let finalScore = null;
    let step5Pass = false;
    let step5Reason = null;

    if (!hasParam1Data) {
      finalScore = null;
      step5Pass = false;
      step5Reason = 'Score could not be computed (no scoring data)';
    } else {
      finalScore = (param1Score + param2Score + param3Score + param4Score) / 4;
      step5Pass = finalScore >= reqFinalScore;
      step5Reason = step5Pass
        ? null
        : `Final score ${finalScore.toFixed(3)} below required threshold ${reqFinalScore}`;
    }

    const step5Result = {
      step: 5,
      name: 'Credit Scoring & Final Score',
      param1: {
        code: 'INSTALLMENT_PAYMENT_BEHAVIOR',
        score: param1Score !== null ? Number(param1Score.toFixed(3)) : null,
        details: param1Details
      },
      param2: {
        code: 'SAVINGS_PAID_WITH_INSTALLMENT',
        score: Number(param2Score.toFixed(3)),
        details: param2Details
      },
      param3: {
        code: 'SAVINGS_ADJUSTMENT_PREV_LOAN',
        score: Number(param3Score.toFixed(3)),
        details: param3Details
      },
      param4: {
        code: 'SAVINGS_WITHDRAWAL_BEFORE_REPAYMENT',
        score: Number(param4Score.toFixed(3)),
        label: param4Label,
        withdrawalCount: withdrCount,
        installmentsToConsider,
        daysBeforeRepayment
      },
      finalScore: finalScore !== null ? Number(finalScore.toFixed(3)) : null,
      requiredScore: reqFinalScore,
      passed: step5Pass,
      reason: step5Reason
    };

    // Overall Eligibility
    let overallPassed = true;
    let failedStep = null;
    let failedReason = null;

    if (!step1Result.passed) {
      overallPassed = false;
      failedStep = 1;
      failedReason = step1Result.reason;
    } else if (!step2Result.passed) {
      overallPassed = false;
      failedStep = 2;
      failedReason = step2Result.reason;
    } else if (!step3Result.passed) {
      overallPassed = false;
      failedStep = 3;
      failedReason = step3Result.reason;
    } else if (!step4Result.passed) {
      overallPassed = false;
      failedStep = 4;
      failedReason = step4Result.reason;
    } else if (!step5Result.passed) {
      overallPassed = false;
      failedStep = 5;
      failedReason = step5Result.reason;
    }

    // ----------------------------------------------------
    // SYSTEM STORED RECORDS CHECK (QA RECONCILIATION)
    // ----------------------------------------------------
    const targetRunId = this.latestRun ? Number(this.latestRun.id) : null;

    const dbEligRes = targetRunId
      ? await client.query(
          'SELECT * FROM credit_risk_model_eligible_member WHERE member_id = $1 AND run_id = $2 ORDER BY id DESC LIMIT 1',
          [memberId, targetRunId]
        )
      : await client.query(
          'SELECT * FROM credit_risk_model_eligible_member WHERE member_id = $1 ORDER BY run_id DESC, id DESC LIMIT 1',
          [memberId]
        );

    const dbCandRes = targetRunId
      ? await client.query(
          'SELECT * FROM credit_risk_model_eligibility_candidate WHERE member_id = $1 AND run_id = $2 ORDER BY id DESC LIMIT 1',
          [memberId, targetRunId]
        )
      : await client.query(
          'SELECT * FROM credit_risk_model_eligibility_candidate WHERE member_id = $1 ORDER BY run_id DESC, id DESC LIMIT 1',
          [memberId]
        );

    const dbScoreRes = targetRunId
      ? await client.query(
          'SELECT * FROM credit_risk_model_eligibility_score_detail WHERE member_id = $1 AND run_id = $2 ORDER BY parameter_code, loan_account_id',
          [memberId, targetRunId]
        )
      : await client.query(
          'SELECT * FROM credit_risk_model_eligibility_score_detail WHERE member_id = $1 ORDER BY parameter_code, loan_account_id',
          [memberId]
        );

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
      minEligibleAmount: overallPassed ? step4Result.minEligibleAmount : projectCap.min_amount,
      maxEligibleAmount: overallPassed ? step4Result.maxEligibleAmount : step4Result.computedCeiling,
      finalScore: finalScore !== null ? Number(finalScore.toFixed(3)) : null
    };

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
      environment: this.buildEnvironmentSummary(),
      applicableProductInfo,
      officeMismatchWarning,
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
      allGeneralLoans: allGeneralLoans.map((l) => ({
        id: l.id,
        accountNo: l.account_no,
        statusId: l.loan_status_id,
        disbursedAmount: Number(l.disbursed_amount),
        outstandingBalance: Number(l.outstanding_balance),
        disbursementDate: l.disb_date_bd || toDhakaDateStr(l.disbursement_date)
      })),
      systemRecord
    };
  }

  buildEnvironmentSummary() {
    return {
      configPath: this.appConfig.configPath,
      baseUrl: this.appConfig.erp.baseUrl,
      eligibilityReportUrl: this.appConfig.erp.eligibilityReportUrl,
      assessmentConfigUrl: this.appConfig.erp.assessmentConfigUrl,
      configuredOffice: this.configuredOffice,
      branchUser: this.appConfig.credentials.branch.username,
      headOfficeUser: this.appConfig.credentials.headOffice.username,
      configuredLoanProducts: this.configuredLoanProducts,
      liveConfig: this.config,
      latestRun: this.latestRun
        ? {
            id: Number(this.latestRun.id),
            status: this.latestRun.run_status,
            businessDate: this.latestRun.config_snapshot?._business_date || null,
            endedAt: this.latestRun.ended_at ? new Date(this.latestRun.ended_at).toISOString() : null
          }
        : null,
      configDrift: this.configDrift
    };
  }
}

module.exports = { NanoLoanEvaluator };
